// History: one timeline of everything FolderBot changed, by the watcher or by hand, with undo.
import {
  ArrowCounterClockwise,
  CaretRight,
  ClockCounterClockwise,
  FilmStrip,
  FolderOpen,
  MagnifyingGlass,
  PencilSimpleLine,
  Television,
  Wrench
} from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import type { AutomationHistoryEntry, RenameHistoryEntry } from "../../shared/types";
import { parseMediaName, toDisplayTitle } from "../../shared/filename-parser";
import { SeriesPicker } from "../components/SeriesPicker";
import { Button, EmptyState, InfoBar, PageHeader } from "../components/ui";
import { fileName, folderOf, formatClock, formatDayHeading, plural, SOURCE_LABELS } from "../format";
import { api, describe, loadHistory, toast, useStore } from "../store";

type Filter = "all" | "watcher" | "manual";

type TimelineItem =
  | { kind: "watcher"; at: string; entry: AutomationHistoryEntry }
  | { kind: "manual"; at: string; entry: RenameHistoryEntry };

export function HistoryPage() {
  const renameHistory = useStore((current) => current.renameHistory);
  const automationHistory = useStore((current) => current.automationHistory);
  const errors = useStore((current) => current.historyErrors);
  const settings = useStore((current) => current.settings);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [fixing, setFixing] = useState<AutomationHistoryEntry | null>(null);

  const items = useMemo(() => {
    const text = query.trim().toLowerCase();
    const timeline: TimelineItem[] = [];

    if (filter !== "manual") {
      for (const entry of automationHistory) {
        if (!text || entry.displayTitle.toLowerCase().includes(text) || fileName(entry.originalInboxPath).toLowerCase().includes(text) || fileName(entry.sourceLibraryPath).toLowerCase().includes(text)) {
          timeline.push({ kind: "watcher", at: entry.createdAt, entry });
        }
      }
    }

    if (filter !== "watcher") {
      for (const entry of renameHistory) {
        if (!text || entry.items.some((item) => fileName(item.sourcePath).toLowerCase().includes(text) || fileName(item.targetPath).toLowerCase().includes(text))) {
          timeline.push({ kind: "manual", at: entry.createdAt, entry });
        }
      }
    }

    timeline.sort((left, right) => Date.parse(right.at) - Date.parse(left.at));

    const days: Array<{ heading: string; items: TimelineItem[] }> = [];
    for (const item of timeline) {
      const heading = formatDayHeading(item.at);
      const last = days.at(-1);
      if (last && last.heading === heading) {
        last.items.push(item);
      } else {
        days.push({ heading, items: [item] });
      }
    }
    return days;
  }, [renameHistory, automationHistory, filter, query]);

  const total = renameHistory.length + automationHistory.length;

  return (
    <>
      <PageHeader title="History" subtitle="Everything FolderBot renamed or filed. Undo puts files back where they were." />

      <div className="commandbar">
        <div className="segmented" role="tablist" aria-label="Show">
          {(["all", "watcher", "manual"] as const).map((value) => (
            <button key={value} type="button" role="tab" aria-selected={filter === value} onClick={() => setFilter(value)}>
              {value === "all" ? "All" : value === "watcher" ? "Filed by the watcher" : "Renamed by hand"}
            </button>
          ))}
        </div>
        <label className="search">
          <MagnifyingGlass size={16} aria-hidden />
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by show or file name" aria-label="Search history" />
        </label>
      </div>

      {errors.manual ? <InfoBar tone="error" title="The rename history could not be read" actions={<Button size="small" onClick={() => void loadHistory()}>Try again</Button>}>{errors.manual}</InfoBar> : null}
      {errors.automation ? <InfoBar tone="error" title="The watcher history could not be read" actions={<Button size="small" onClick={() => void loadHistory()}>Try again</Button>}>{errors.automation}</InfoBar> : null}

      {items.length === 0 ? (
        <EmptyState icon={ClockCounterClockwise} title={total === 0 ? "Nothing here yet" : "Nothing matches"}>
          {total === 0 ? "Files you rename, and files the watcher files, are listed here so you can undo them." : "Try a different search or filter."}
        </EmptyState>
      ) : (
        items.map((day) => (
          <section key={day.heading} className="section">
            <div className="section-head"><h2>{day.heading}</h2></div>
            <div className="list">
              {day.items.map((item) =>
                item.kind === "watcher" ? (
                  <WatcherEntry key={item.entry.id} entry={item.entry} onFix={() => setFixing(item.entry)} />
                ) : (
                  <ManualEntry key={item.entry.id} entry={item.entry} />
                )
              )}
            </div>
          </section>
        ))
      )}

      {fixing ? (
        <SeriesPicker
          open
          sourceId={fixing.sourceId === "local" ? settings.automationSourceId === "local" ? "tvdb" : settings.automationSourceId : fixing.sourceId}
          initialQuery={toDisplayTitle(parseMediaName(fileName(fixing.originalInboxPath)).normalizedTitle) || fixing.displayTitle}
          title="Pick the right show"
          subtitle={`FolderBot renames and moves ${fileName(fixing.sourceLibraryPath)} in both libraries.`}
          confirmLabel="Move to this show"
          onClose={() => setFixing(null)}
          onConfirm={async (match) => {
            try {
              const result = await api.repairAutomationHistoryEntries({ entryIds: [fixing.id], match });
              const failed = result.results.find((item) => !item.success);
              toast(failed ? `Could not move it: ${failed.error}` : `Moved to ${match.title}`, failed ? "error" : "success");
              setFixing(null);
              await loadHistory();
            } catch (error) {
              toast(`Could not move it: ${describe(error)}`, "error");
            }
          }}
        />
      ) : null}
    </>
  );
}

function WatcherEntry({ entry, onFix }: { entry: AutomationHistoryEntry; onFix: () => void }) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const IconComponent = entry.mediaKind === "movie" ? FilmStrip : Television;

  const undo = async () => {
    setBusy(true);
    try {
      const result = await api.undoAutomationHistoryEntry(entry.id);
      const failed = result.results.filter((item) => !item.success);
      toast(
        failed.length > 0 ? `Undo was incomplete: ${failed[0].error}` : "Put back in the inbox. The watcher leaves it alone until it changes.",
        failed.length > 0 ? "error" : "success"
      );
      await loadHistory();
    } catch (error) {
      toast(`Undo failed: ${describe(error)}`, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`history-item${entry.undoneAt ? " is-undone" : ""}`}>
      <div className="row">
        <span className="media-icon is-small" aria-hidden><IconComponent size={18} /></span>
        <button type="button" className="row-text row-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className="row-title">{fileName(entry.sourceLibraryPath)}</span>
          <span className="row-detail">
            {entry.displayTitle} · filed by the watcher · {SOURCE_LABELS[entry.sourceId]}
          </span>
        </button>
        <div className="row-meta">
          {entry.undoneAt ? <span className="stage-pill stage-pill-skipped">Undone</span> : null}
          <span className="row-sub">{formatClock(entry.createdAt)}</span>
        </div>
        <div className="row-actions">
          {!entry.undoneAt ? (
            <>
              <Button size="small" variant="subtle" icon={FolderOpen} aria-label="Show in folder" title="Show in the source library" onClick={() => void api.showItemInFolder(entry.sourceLibraryPath)} />
              {entry.mediaKind === "episode" ? <Button size="small" variant="subtle" icon={Wrench} onClick={onFix}>Wrong show?</Button> : null}
              <Button size="small" icon={ArrowCounterClockwise} busy={busy} onClick={() => void undo()}>Undo</Button>
            </>
          ) : null}
        </div>
      </div>
      {open ? (
        <dl className="history-paths">
          <div><dt>From the inbox</dt><dd>{entry.originalInboxPath}</dd></div>
          <div><dt>Source library</dt><dd>{entry.sourceLibraryPath}</dd></div>
          <div><dt>Mirror library</dt><dd>{entry.mirrorLibraryPath}</dd></div>
        </dl>
      ) : null}
    </div>
  );
}

function ManualEntry({ entry }: { entry: RenameHistoryEntry }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const pending = entry.items.filter((item) => !item.undoneAt);
  const folders = Array.from(new Set(entry.items.map((item) => folderOf(item.targetPath))));

  const undo = async (itemIds?: string[]) => {
    setBusy(true);
    try {
      const result = await api.undoRenameHistoryEntry({ entryId: entry.id, itemIds });
      const failed = result.results.filter((item) => !item.success);
      toast(failed.length > 0 ? `${failed.length} could not be put back: ${failed[0].error}` : `Put back ${plural(result.results.length, "file")}.`, failed.length > 0 ? "error" : "success");
      setSelected([]);
      await loadHistory();
    } catch (error) {
      toast(`Undo failed: ${describe(error)}`, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`history-item${pending.length === 0 ? " is-undone" : ""}`}>
      <div className="row">
        <span className="media-icon is-small" aria-hidden><PencilSimpleLine size={18} /></span>
        <button type="button" className="row-text row-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className="row-title">
            <CaretRight size={12} className="row-caret" aria-hidden /> Renamed {plural(entry.itemCount, "file")}
          </span>
          <span className="row-detail">{folders.length === 1 ? folders[0] : `${folders.length} folders`} · {SOURCE_LABELS[entry.sourceId]}</span>
        </button>
        <div className="row-meta">
          {pending.length === 0 ? <span className="stage-pill stage-pill-skipped">Undone</span> : pending.length < entry.items.length ? <span className="stage-pill">{pending.length} still renamed</span> : null}
          <span className="row-sub">{formatClock(entry.createdAt)}</span>
        </div>
        <div className="row-actions">
          {pending.length > 0 ? <Button size="small" icon={ArrowCounterClockwise} busy={busy} onClick={() => void undo()}>Undo all</Button> : null}
        </div>
      </div>
      {open ? (
        <div className="history-files">
          {entry.items.map((item) => (
            <label key={item.id} className={`history-file${item.undoneAt ? " is-undone" : ""}`}>
              <input
                type="checkbox"
                className="checkbox"
                disabled={Boolean(item.undoneAt)}
                checked={selected.includes(item.id)}
                onChange={(event) => setSelected(event.target.checked ? [...selected, item.id] : selected.filter((id) => id !== item.id))}
              />
              <span className="history-file-name" title={item.sourcePath}>{fileName(item.sourcePath)}</span>
              <CaretRight size={12} aria-hidden />
              <span className="history-file-name is-new" title={item.targetPath}>{fileName(item.targetPath)}</span>
              {item.undoneAt ? <span className="muted">Undone</span> : null}
            </label>
          ))}
          {pending.length > 0 ? (
            <div className="history-files-actions">
              <Button size="small" variant="subtle" onClick={() => setSelected(selected.length === pending.length ? [] : pending.map((item) => item.id))}>
                {selected.length === pending.length ? "Select none" : "Select all"}
              </Button>
              <Button size="small" icon={ArrowCounterClockwise} disabled={selected.length === 0} busy={busy} onClick={() => void undo(selected)}>
                Undo {selected.length > 0 ? plural(selected.length, "file") : "selected"}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
