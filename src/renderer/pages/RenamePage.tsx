// Rename: drop files, check the new names side by side, rename. Nothing changes until the user
// presses Rename, and the whole batch can be undone straight after.
import {
  ArrowRight,
  Broom,
  CaretDown,
  CheckCircle,
  FilePlus,
  FolderOpen,
  MagnifyingGlass,
  PencilSimpleLine,
  WarningCircle,
  X
} from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { parseMediaName, formatEpisodeCode, toDisplayTitle } from "../../shared/filename-parser";
import type { MetadataSourceId, ParsedMedia, ProviderSeriesSearchMatch, RenamePreview } from "../../shared/types";
import { SeriesPicker } from "../components/SeriesPicker";
import { Button, InfoBar, PageHeader, PathText } from "../components/ui";
import { fileName, plural, SOURCE_LABELS } from "../format";
import { api, describe, loadHistory, navigate, toast, useStore, getState } from "../store";

interface SeriesGroup {
  title: string;
  filePaths: string[];
}

const SOURCE_KEY = "folderbot.renameSource";

export function RenamePage() {
  const providers = useStore((current) => current.providerStatuses);
  const [files, setFiles] = useState<string[]>([]);
  const [previews, setPreviews] = useState<Record<string, RenamePreview>>({});
  const [sourceId, setSourceId] = useState<MetadataSourceId>(() => (localStorage.getItem(SOURCE_KEY) as MetadataSourceId) || "local");
  const [outputDirectory, setOutputDirectory] = useState("");
  const [manualTitle, setManualTitle] = useState("");
  const [showOptions, setShowOptions] = useState(false);
  const [busy, setBusy] = useState<"matching" | "renaming" | null>(null);
  const [dragging, setDragging] = useState(false);
  const [picker, setPicker] = useState<{ groups: SeriesGroup[]; index: number; matches: Record<string, ProviderSeriesSearchMatch> } | null>(null);
  const [result, setResult] = useState<{ renamed: number; failed: Array<{ name: string; error: string }>; entryId?: string } | null>(null);

  const provider = providers.find((item) => item.id === sourceId);
  const providerReady = sourceId === "local" || Boolean(provider?.ready);

  useEffect(() => {
    localStorage.setItem(SOURCE_KEY, sourceId);
  }, [sourceId]);

  // Dropping files anywhere on the window adds them here.
  useEffect(() => {
    let depth = 0;
    const enter = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      depth += 1;
      setDragging(true);
    };
    const over = (event: DragEvent) => event.preventDefault();
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const drop = (event: DragEvent) => {
      event.preventDefault();
      depth = 0;
      setDragging(false);
      const paths = Array.from(event.dataTransfer?.files ?? [])
        .map((file) => api.getPathForFile(file))
        .filter((value): value is string => Boolean(value));
      addFiles(paths);
    };
    document.addEventListener("dragenter", enter);
    document.addEventListener("dragover", over);
    document.addEventListener("dragleave", leave);
    document.addEventListener("drop", drop);
    return () => {
      document.removeEventListener("dragenter", enter);
      document.removeEventListener("dragover", over);
      document.removeEventListener("dragleave", leave);
      document.removeEventListener("drop", drop);
    };
  });

  const addFiles = (paths: string[]) => {
    if (paths.length === 0) return;
    const next = Array.from(new Set([...files, ...paths]));
    const added = next.length - files.length;
    setFiles(next);
    setResult(null);
    if (added === 0) {
      toast("Those files are already in the list.");
      return;
    }
    // Filename-only names are instant, so build them straight away.
    if (sourceId === "local") {
      void buildPreviews(next, {});
    } else {
      setPreviews({});
    }
  };

  const removeFile = (filePath: string) => {
    setFiles(files.filter((item) => item !== filePath));
    const nextPreviews = { ...previews };
    delete nextPreviews[filePath];
    setPreviews(nextPreviews);
  };

  const clear = () => {
    setFiles([]);
    setPreviews({});
    setResult(null);
  };

  const buildPreviews = async (paths: string[], explicitSeriesMatches: Record<string, ProviderSeriesSearchMatch>, source = sourceId) => {
    if (paths.length === 0) return;
    setBusy("matching");
    try {
      const settingsNow = getState().settings;
      const built = await api.previewRenames({
        filePaths: paths,
        options: {
          sourceId: source,
          tmdbToken: settingsNow.tmdbBearerToken || undefined,
          tvdbApiKey: settingsNow.tvdbApiKey || undefined,
          tvdbPin: settingsNow.tvdbPin || undefined,
          language: settingsNow.defaultLanguage,
          destinationDirectory: outputDirectory || undefined,
          manualTitle: manualTitle || undefined,
          explicitSeriesMatches: Object.keys(explicitSeriesMatches).length > 0 ? explicitSeriesMatches : undefined
        }
      });
      setPreviews(Object.fromEntries(built.map((item) => [item.sourcePath, item])));
    } catch (error) {
      toast(`Could not build new names: ${describe(error)}`, "error");
    } finally {
      setBusy(null);
    }
  };

  // With an online source, confirm each show once, then build every name.
  const lookUp = () => {
    if (sourceId === "local") {
      void buildPreviews(files, {});
      return;
    }
    const groups = groupBySeries(files, manualTitle);
    if (groups.length === 0) {
      void buildPreviews(files, {});
      return;
    }
    setPicker({ groups, index: 0, matches: {} });
  };

  const advancePicker = (match?: ProviderSeriesSearchMatch) => {
    if (!picker) return;
    const matches = { ...picker.matches };
    if (match) {
      for (const filePath of picker.groups[picker.index].filePaths) {
        matches[filePath] = match;
      }
    }
    if (picker.index < picker.groups.length - 1) {
      setPicker({ ...picker, index: picker.index + 1, matches });
      return;
    }
    setPicker(null);
    void buildPreviews(files, matches);
  };

  const rename = async () => {
    const ready = files.map((filePath) => previews[filePath]).filter((item): item is RenamePreview => Boolean(item) && item.conflicts.length === 0);
    if (ready.length === 0) return;
    setBusy("renaming");
    try {
      const results = await api.applyRenames({ items: ready, sourceId });
      const failed = results.filter((item) => !item.success);
      const renamedPaths = new Set(results.filter((item) => item.success).map((item) => item.sourcePath));
      await loadHistory();
      const entryId = getState().renameHistory[0]?.id;
      setResult({
        renamed: renamedPaths.size,
        failed: failed.map((item) => ({ name: fileName(item.sourcePath), error: item.error ?? "Unknown error" })),
        entryId
      });
      setFiles(files.filter((filePath) => !renamedPaths.has(filePath)));
      const nextPreviews = { ...previews };
      for (const filePath of renamedPaths) delete nextPreviews[filePath];
      setPreviews(nextPreviews);
    } catch (error) {
      toast(`Rename failed: ${describe(error)}`, "error");
    } finally {
      setBusy(null);
    }
  };

  const undoLast = async () => {
    if (!result?.entryId) return;
    try {
      const undone = await api.undoRenameHistoryEntry({ entryId: result.entryId });
      const failedCount = undone.results.filter((item) => !item.success).length;
      toast(failedCount > 0 ? `${failedCount} could not be put back. See History.` : `Put back ${plural(undone.results.length, "file")}.`, failedCount > 0 ? "error" : "success");
      setResult(null);
      await loadHistory();
    } catch (error) {
      toast(`Undo failed: ${describe(error)}`, "error");
    }
  };

  const counts = useMemo(() => {
    const built = files.map((filePath) => previews[filePath]).filter(Boolean) as RenamePreview[];
    return {
      built: built.length,
      ready: built.filter((item) => item.conflicts.length === 0).length,
      issues: built.filter((item) => item.conflicts.length > 0).length
    };
  }, [files, previews]);

  const needsLookup = files.length > 0 && counts.built < files.length;

  return (
    <>
      <PageHeader title="Rename" subtitle="Clean up names for a batch of episodes or movies. Nothing changes until you press Rename." />

      {result ? (
        <InfoBar
          tone={result.failed.length > 0 ? "warning" : "success"}
          title={result.failed.length > 0 ? `Renamed ${result.renamed}, ${result.failed.length} could not be renamed` : `Renamed ${plural(result.renamed, "file")}`}
          actions={
            <>
              {result.entryId && result.renamed > 0 ? <Button size="small" onClick={() => void undoLast()}>Undo</Button> : null}
              <Button size="small" variant="subtle" onClick={() => navigate("history")}>History</Button>
            </>
          }
          onDismiss={() => setResult(null)}
        >
          {result.failed.slice(0, 2).map((item) => `${item.name}: ${item.error}`).join(" · ")}
        </InfoBar>
      ) : null}

      <div className="commandbar">
        <Button icon={FilePlus} onClick={async () => addFiles(await api.pickFiles())}>Add files</Button>
        <Button variant="subtle" icon={Broom} disabled={files.length === 0 || busy !== null} onClick={clear}>Clear</Button>
        <span className="commandbar-divider" />
        <label className="inline-field">
          <span>Names from</span>
          <select
            className="select"
            value={sourceId}
            onChange={(event) => {
              const next = event.target.value as MetadataSourceId;
              setSourceId(next);
              setPreviews({});
              if (next === "local") void buildPreviews(files, {}, next);
            }}
          >
            <option value="local">Filename only (offline)</option>
            <option value="tvdb">TheTVDB</option>
            <option value="tmdb">TMDb</option>
          </select>
        </label>
        <button type="button" className="disclosure" aria-expanded={showOptions} onClick={() => setShowOptions(!showOptions)}>
          <CaretDown size={14} className="disclosure-caret" aria-hidden />
          More options
        </button>
      </div>

      {!providerReady ? (
        <InfoBar
          tone="warning"
          title={`${SOURCE_LABELS[sourceId]} is not connected`}
          actions={<Button size="small" onClick={() => navigate("settings", "sources")}>Add a key</Button>}
        >
          Add your {SOURCE_LABELS[sourceId]} key in Settings, or use Filename only.
        </InfoBar>
      ) : null}

      {showOptions ? (
        <div className="options-panel">
          <label className="field">
            <span className="field-label">Save renamed files to</span>
            <span className="field-row">
              <PathText value={outputDirectory} placeholder="The folder each file is already in" />
              <Button size="small" icon={FolderOpen} onClick={async () => setOutputDirectory((await api.pickOutputDirectory()) ?? outputDirectory)}>Choose</Button>
              {outputDirectory ? <Button size="small" variant="subtle" icon={X} aria-label="Rename in place" onClick={() => setOutputDirectory("")} /> : null}
            </span>
          </label>
          <label className="field">
            <span className="field-label">Show title</span>
            <input className="input" value={manualTitle} onChange={(event) => setManualTitle(event.target.value)} placeholder="Only if the filenames don't say which show it is" />
          </label>
        </div>
      ) : null}

      {files.length === 0 ? (
        <button type="button" className={`dropzone${dragging ? " is-dragging" : ""}`} onClick={async () => addFiles(await api.pickFiles())}>
          <FilePlus size={40} weight="light" aria-hidden />
          <strong>Drop episodes or movies here</strong>
          <span>or click to choose files. FolderBot reads the show, season and episode from each name.</span>
          <span className="muted">mkv · mp4 · avi · mov · m4v · wmv · mpg · srt · ass</span>
        </button>
      ) : (
        <div className={`rename-table${dragging ? " is-dragging" : ""}`} role="table" aria-label="Files to rename">
          <div className="rename-head" role="row">
            <span role="columnheader">Current name</span>
            <span aria-hidden />
            <span role="columnheader">New name</span>
            <span aria-hidden />
          </div>
          {files.map((filePath) => (
            <RenameRow key={filePath} filePath={filePath} preview={previews[filePath]} busy={busy === "matching"} onRemove={() => removeFile(filePath)} />
          ))}
        </div>
      )}

      {files.length > 0 ? (
        <div className="actionbar">
          <span className="actionbar-summary">
            {plural(files.length, "file")}
            {counts.built > 0 ? ` · ${counts.ready} ready` : ""}
            {counts.issues > 0 ? ` · ${counts.issues} need attention` : ""}
          </span>
          {needsLookup || sourceId !== "local" ? (
            <Button
              variant={needsLookup ? "accent" : "standard"}
              icon={MagnifyingGlass}
              busy={busy === "matching"}
              disabled={!providerReady || busy === "renaming"}
              onClick={lookUp}
            >
              {needsLookup ? "Find new names" : "Look up again"}
            </Button>
          ) : null}
          <Button
            variant={needsLookup ? "standard" : "accent"}
            icon={PencilSimpleLine}
            busy={busy === "renaming"}
            disabled={counts.ready === 0 || busy === "matching"}
            onClick={() => void rename()}
          >
            Rename {counts.ready > 0 ? plural(counts.ready, "file") : ""}
          </Button>
        </div>
      ) : null}

      {picker ? (
        <SeriesPicker
          open
          sourceId={sourceId}
          initialQuery={picker.groups[picker.index].title}
          title={`Which show is "${picker.groups[picker.index].title}"?`}
          subtitle={`${picker.index + 1} of ${picker.groups.length} · ${plural(picker.groups[picker.index].filePaths.length, "file")}. Your choice applies to all of them.`}
          confirmLabel={picker.index < picker.groups.length - 1 ? "Use this show, next" : "Use this show"}
          skipLabel="Let FolderBot guess"
          onConfirm={(match) => advancePicker(match)}
          onSkip={() => advancePicker()}
          onClose={() => setPicker(null)}
        />
      ) : null}
    </>
  );
}

function RenameRow({ filePath, preview, busy, onRemove }: { filePath: string; preview?: RenamePreview; busy: boolean; onRemove: () => void }) {
  const name = fileName(filePath);
  const parsed = preview?.parsed ?? parseMediaName(name);
  const problem = preview?.conflicts[0];
  const note = preview?.warnings[0];

  return (
    <div className={`rename-row${problem ? " has-problem" : preview ? " is-ready" : ""}`} role="row">
      <span className="rename-cell" role="cell">
        <span className="rename-name" title={filePath}>{name}</span>
        <span className="rename-meta">{describeParsed(parsed)}</span>
      </span>
      <span className="rename-arrow" aria-hidden>
        {problem ? <WarningCircle size={16} weight="fill" /> : preview ? <CheckCircle size={16} weight="fill" /> : <ArrowRight size={16} />}
      </span>
      <span className="rename-cell" role="cell">
        {preview ? (
          <>
            <span className="rename-name is-new" title={preview.targetPath}>{preview.targetName}</span>
            <span className={`rename-meta${problem ? " is-problem" : ""}`}>{problem ?? note ?? (preview.metadata ? `${SOURCE_LABELS[preview.metadata.sourceId]} · ${preview.metadata.displayTitle}` : "Ready")}</span>
          </>
        ) : (
          <span className="rename-name is-pending">{busy ? "Finding a name…" : "Not looked up yet"}</span>
        )}
      </span>
      <Button size="small" variant="subtle" icon={X} aria-label={`Remove ${name}`} onClick={onRemove} />
    </div>
  );
}

function describeParsed(parsed: ParsedMedia): string {
  if (parsed.kind === "episode") {
    return `${toDisplayTitle(parsed.normalizedTitle)} · ${formatEpisodeCode(parsed.season, parsed.episode, parsed.absoluteEpisode)}`;
  }
  if (parsed.kind === "movie") {
    return `Movie · ${toDisplayTitle(parsed.normalizedTitle)}${parsed.year ? ` (${parsed.year})` : ""}`;
  }
  return "Not recognised as an episode or movie";
}

function groupBySeries(files: string[], manualTitle: string): SeriesGroup[] {
  const groups = new Map<string, SeriesGroup>();
  for (const filePath of files) {
    const parsed = parseMediaName(fileName(filePath));
    if (parsed.kind !== "episode") continue;
    const title = manualTitle || toDisplayTitle(parsed.normalizedTitle);
    const key = title.toLowerCase();
    const group = groups.get(key) ?? { title, filePaths: [] };
    group.filePaths.push(filePath);
    groups.set(key, group);
  }
  return Array.from(groups.values());
}
