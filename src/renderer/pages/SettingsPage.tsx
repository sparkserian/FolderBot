// Settings, as Windows settings cards. Every change saves as it is made.
import {
  ArrowsClockwise,
  Bell,
  BellSlash,
  CheckCircle,
  Clock,
  Database,
  DownloadSimple,
  FileText,
  FilmStrip,
  FolderOpen,
  FolderSimple,
  GithubLogo,
  Globe,
  Info,
  Key,
  MagnifyingGlass,
  Power,
  Television,
  Tray,
  Wrench,
  X
} from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import type { AppSettings, RepairShowResult, UpdateState } from "../../shared/types";
import { Button, PageHeader, PathText, Section, SettingsCard, Switch } from "../components/ui";
import { fileName, formatRelative, plural } from "../format";
import { api, describe, saveSettings, setState, toast, useStore } from "../store";

const SECTIONS: Array<[string, string]> = [
  ["automation", "Automatic filing"],
  ["notifications", "Notifications"],
  ["sources", "Metadata sources"],
  ["startup", "Startup"],
  ["updates", "Updates"],
  ["maintenance", "Maintenance"],
  ["about", "About"]
];

export function SettingsPage() {
  const settings = useStore((current) => current.settings);
  const target = useStore((current) => current.settingsSection);

  useEffect(() => {
    if (target) {
      document.getElementById(`settings-${target}`)?.scrollIntoView({ block: "start" });
      setState({ settingsSection: undefined });
    }
  }, [target]);

  return (
    <>
      <PageHeader title="Settings" />
      <nav className="jumpbar" aria-label="Settings sections">
        {SECTIONS.map(([id, label]) => (
          <button key={id} type="button" onClick={() => document.getElementById(`settings-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" })}>
            {label}
          </button>
        ))}
      </nav>

      <AutomationSection settings={settings} />
      <NotificationSection settings={settings} />
      <SourcesSection settings={settings} />
      <StartupSection settings={settings} />
      <UpdatesSection />
      <MaintenanceSection />
      <AboutSection />
    </>
  );
}

function AutomationSection({ settings }: { settings: AppSettings }) {
  const missing = !settings.automationInboxDirectory
    ? "Choose an inbox first."
    : !(settings.automationSourceLibraryDirectory && settings.automationMirrorLibraryDirectory) &&
        !(settings.automationMovieSourceDirectory && settings.automationMovieMirrorDirectory)
      ? "Choose both TV libraries, both movie libraries, or all four."
      : "";

  return (
    <Section title="Automatic filing" id="settings-automation">
      <SettingsCard
        icon={Tray}
        title="Watch the inbox"
        description={missing || "Finished downloads are renamed, copied to the mirror library and moved into the source library."}
      >
        <Switch
          label="Watch the inbox"
          checked={settings.automationEnabled}
          disabled={Boolean(missing) && !settings.automationEnabled}
          onChange={(next) => void saveSettings({ automationEnabled: next })}
        />
      </SettingsCard>

      <FolderCard icon={FolderSimple} title="Inbox" description="Where downloads land" settingKey="automationInboxDirectory" value={settings.automationInboxDirectory} />

      <div className="card-group">
        <div className="card-group-title"><Television size={16} aria-hidden /> TV episodes</div>
        <FolderCard title="Source library" description="Episodes are moved here, into show and season folders" settingKey="automationSourceLibraryDirectory" value={settings.automationSourceLibraryDirectory} />
        <FolderCard title="Mirror library" description="A second copy, usually on another drive" settingKey="automationMirrorLibraryDirectory" value={settings.automationMirrorLibraryDirectory} />
      </div>

      <div className="card-group">
        <div className="card-group-title"><FilmStrip size={16} aria-hidden /> Movies</div>
        <FolderCard title="Source library" description="Movies are moved here" settingKey="automationMovieSourceDirectory" value={settings.automationMovieSourceDirectory} />
        <FolderCard title="Mirror library" description="A second copy of each movie" settingKey="automationMovieMirrorDirectory" value={settings.automationMovieMirrorDirectory} />
      </div>

      <SettingsCard icon={MagnifyingGlass} title="Episode names from" description="Movies are always named from the file name and year.">
        <select className="select" value={settings.automationSourceId} onChange={(event) => void saveSettings({ automationSourceId: event.target.value as AppSettings["automationSourceId"] })}>
          <option value="tvdb">TheTVDB</option>
          <option value="tmdb">TMDb</option>
          <option value="local">Filename only</option>
        </select>
      </SettingsCard>

      <SettingsCard
        icon={Clock}
        title="Wait before filing"
        description="A file has to stop changing for this long before FolderBot touches it, so unfinished downloads are left alone."
      >
        <NumberSetting value={settings.automationSettleSeconds} min={10} max={600} unit="seconds" onSave={(value) => void saveSettings({ automationSettleSeconds: value })} />
      </SettingsCard>
    </Section>
  );
}

function FolderCard({
  icon,
  title,
  description,
  settingKey,
  value
}: {
  icon?: typeof FolderSimple;
  title: string;
  description: string;
  settingKey: keyof AppSettings;
  value: string;
}) {
  return (
    <SettingsCard
      icon={icon}
      title={title}
      description={<PathText value={value} placeholder={description} />}
    >
      {value ? <Button size="small" variant="subtle" icon={X} aria-label={`Clear ${title}`} title="Clear" onClick={() => void saveSettings({ [settingKey]: "" } as Partial<AppSettings>)} /> : null}
      <Button
        icon={FolderOpen}
        onClick={async () => {
          const folder = await api.pickOutputDirectory();
          if (folder) {
            await saveSettings({ [settingKey]: folder } as Partial<AppSettings>);
          }
        }}
      >
        {value ? "Change" : "Choose"}
      </Button>
    </SettingsCard>
  );
}

function NotificationSection({ settings }: { settings: AppSettings }) {
  return (
    <Section title="Notifications" id="settings-notifications">
      <SettingsCard icon={Bell} title="When a file is filed" description="One notification per batch, only while the window is in the background.">
        <Switch label="Notify when a file is filed" checked={settings.notifyOnFiled} onChange={(next) => void saveSettings({ notifyOnFiled: next })} />
      </SettingsCard>
      <SettingsCard icon={BellSlash} title="When a file can't be filed" description="Says what went wrong. Click it to open Activity.">
        <Switch label="Notify when a file fails" checked={settings.notifyOnFailure} onChange={(next) => void saveSettings({ notifyOnFailure: next })} />
      </SettingsCard>
    </Section>
  );
}

function SourcesSection({ settings }: { settings: AppSettings }) {
  const providers = useStore((current) => current.providerStatuses);
  const status = (id: string) => providers.find((item) => item.id === id);

  return (
    <Section title="Metadata sources" id="settings-sources">
      <SettingsCard
        icon={Key}
        title={<>TMDb <ConnectionChip ready={status("tmdb")?.ready} /></>}
        description="API Read Access Token from themoviedb.org › Settings › API."
        below={<SecretSetting label="TMDb API read access token" value={settings.tmdbBearerToken} onSave={(value) => void saveSettings({ tmdbBearerToken: value })} />}
      />
      <SettingsCard
        icon={Key}
        title={<>TheTVDB <ConnectionChip ready={status("tvdb")?.ready} /></>}
        description="Project API key from thetvdb.com. The PIN is only needed for subscriber keys."
        below={
          <div className="field-pair">
            <SecretSetting label="TheTVDB API key" value={settings.tvdbApiKey} onSave={(value) => void saveSettings({ tvdbApiKey: value })} />
            <SecretSetting label="Subscriber PIN (optional)" value={settings.tvdbPin} onSave={(value) => void saveSettings({ tvdbPin: value })} />
          </div>
        }
      />
      <SettingsCard icon={Globe} title="Language" description="Used for episode titles from TMDb and TheTVDB, for example en-US or fr-FR.">
        <TextSetting label="Language" value={settings.defaultLanguage} width={110} onSave={(value) => void saveSettings({ defaultLanguage: value })} />
      </SettingsCard>
    </Section>
  );
}

function ConnectionChip({ ready }: { ready?: boolean }) {
  return <span className={`chip${ready ? " chip-success" : ""}`}>{ready ? "Connected" : "Not set up"}</span>;
}

function StartupSection({ settings }: { settings: AppSettings }) {
  return (
    <Section title="Startup" id="settings-startup">
      <SettingsCard
        icon={Power}
        title="Start FolderBot when I sign in"
        description="Starts in the tray, so the watcher is running without opening the window."
      >
        <Switch label="Start when I sign in" checked={settings.launchAtLogin} onChange={(next) => void saveSettings({ launchAtLogin: next })} />
      </SettingsCard>
    </Section>
  );
}

function UpdatesSection() {
  const update = useStore((current) => current.update);
  const version = useStore((current) => current.appInfo?.version ?? "");
  const [checking, setChecking] = useState(false);

  return (
    <Section title="Updates" id="settings-updates">
      <SettingsCard icon={DownloadSimple} title={`FolderBot ${version}`} description={<UpdateLine update={update} />}>
        {update.kind === "ready" ? (
          <Button variant="accent" icon={ArrowsClockwise} onClick={() => void api.installUpdate()}>Restart to update</Button>
        ) : update.kind === "unsupported" ? null : (
          <Button
            icon={ArrowsClockwise}
            busy={checking || update.kind === "checking"}
            disabled={update.kind === "downloading"}
            onClick={async () => {
              setChecking(true);
              try {
                setState({ update: await api.checkForUpdates() });
              } finally {
                setChecking(false);
              }
            }}
          >
            Check for updates
          </Button>
        )}
      </SettingsCard>
    </Section>
  );
}

function UpdateLine({ update }: { update: UpdateState }) {
  const now = Date.now();
  switch (update.kind) {
    case "unsupported":
      return <>{update.reason}</>;
    case "checking":
      return <>Checking GitHub for a new version…</>;
    case "available":
      return <>Version {update.version} found. Downloading in the background.</>;
    case "downloading":
      return <>Downloading {update.version}: {update.percent}%</>;
    case "ready":
      return <>Version {update.version} is downloaded. It installs when you restart or quit FolderBot.</>;
    case "error":
      return <>{update.message}</>;
    default:
      return <>{update.checkedAt ? `Up to date. Checked ${formatRelative(update.checkedAt, now)}.` : "Updates download automatically, then ask you to restart."}</>;
  }
}

function MaintenanceSection() {
  const appInfo = useStore((current) => current.appInfo);
  const [folders, setFolders] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<RepairShowResult[] | null>(null);

  const run = async () => {
    setRunning(true);
    try {
      const outcome = await api.repairSeasonPlacement(folders);
      setResults(outcome);
      const moved = outcome.reduce((sum, show) => sum + show.locations.reduce((inner, location) => inner + location.movedCount, 0), 0);
      toast(`Moved ${plural(moved, "episode")} into season folders.`, "success");
      setFolders([]);
    } catch (error) {
      toast(`Repair failed: ${describe(error)}`, "error");
    } finally {
      setRunning(false);
    }
  };

  return (
    <Section title="Maintenance" id="settings-maintenance">
      <SettingsCard
        icon={Wrench}
        title="Put loose episodes into season folders"
        description="For show folders where episodes sit outside their Season folder. Runs on both the source and mirror libraries."
        below={
          <div className="repair">
            {folders.length > 0 ? (
              <ul className="repair-list">
                {folders.map((folder) => (
                  <li key={folder}>
                    <FolderSimple size={16} aria-hidden />
                    <span className="path" title={folder}>{folder}</span>
                    <Button size="small" variant="subtle" icon={X} aria-label={`Remove ${fileName(folder)}`} onClick={() => setFolders(folders.filter((item) => item !== folder))} />
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="repair-actions">
              <Button
                icon={FolderOpen}
                onClick={async () => {
                  const picked = await api.pickOutputDirectories();
                  setFolders(Array.from(new Set([...folders, ...picked])));
                }}
              >
                Choose show folders
              </Button>
              <Button variant="accent" icon={Wrench} busy={running} disabled={folders.length === 0} onClick={() => void run()}>
                Repair {folders.length > 0 ? plural(folders.length, "show") : ""}
              </Button>
            </div>
            {results ? (
              <ul className="repair-results">
                {results.map((show) => {
                  const moved = show.locations.reduce((sum, location) => sum + location.movedCount, 0);
                  const errors = show.locations.flatMap((location) => location.errors);
                  return (
                    <li key={show.selectedShowPath}>
                      {errors.length > 0 ? <span className="text-critical">{show.showName}: {errors[0]}</span> : <span><CheckCircle size={14} weight="fill" className="text-success" aria-hidden /> {show.showName}: moved {plural(moved, "episode")}</span>}
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </div>
        }
      />
      <SettingsCard icon={FileText} title="Watcher log" description="Every step the watcher has taken, with times.">
        <Button icon={FileText} onClick={() => void api.openLog()}>Open log</Button>
      </SettingsCard>
      <SettingsCard icon={Database} title="Settings and history folder" description={<PathText value={appInfo?.userDataPath ?? ""} placeholder="" />}>
        <Button icon={FolderOpen} disabled={!appInfo} onClick={() => void api.openFolder(appInfo?.userDataPath ?? "")}>Open</Button>
      </SettingsCard>
    </Section>
  );
}

function AboutSection() {
  const appInfo = useStore((current) => current.appInfo);
  return (
    <Section title="About" id="settings-about">
      <SettingsCard
        icon={Info}
        title="FolderBot"
        description={`Version ${appInfo?.version ?? ""}. Names and files TV episodes and movies. Icons by Phosphor (MIT).`}
      >
        <Button icon={GithubLogo} onClick={() => void api.openExternal("https://github.com/sparkserian/FolderBot")}>GitHub</Button>
      </SettingsCard>
    </Section>
  );
}

// Text fields save when they lose focus or on Enter, not on every keystroke.
function TextSetting({ label, value, onSave, width }: { label: string; value: string; onSave: (value: string) => void; width?: number }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft.trim() !== value) onSave(draft.trim());
  };
  return (
    <input
      className="input"
      aria-label={label}
      style={width ? { width } : undefined}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => event.key === "Enter" && (event.target as HTMLInputElement).blur()}
    />
  );
}

function SecretSetting({ label, value, onSave }: { label: string; value: string; onSave: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  const [visible, setVisible] = useState(false);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft.trim() !== value) onSave(draft.trim());
  };
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <span className="field-row">
        <input
          className="input"
          type={visible ? "text" : "password"}
          value={draft}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => event.key === "Enter" && (event.target as HTMLInputElement).blur()}
        />
        <Button size="small" variant="subtle" onClick={() => setVisible(!visible)}>{visible ? "Hide" : "Show"}</Button>
      </span>
    </label>
  );
}

function NumberSetting({ value, min, max, unit, onSave }: { value: number; min: number; max: number; unit: string; onSave: (value: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const parsed = Math.max(min, Math.min(max, Math.round(Number(draft) || value)));
    setDraft(String(parsed));
    if (parsed !== value) onSave(parsed);
  };
  return (
    <span className="number-setting">
      <input
        className="input"
        type="number"
        min={min}
        max={max}
        value={draft}
        aria-label={unit}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => event.key === "Enter" && (event.target as HTMLInputElement).blur()}
      />
      <span className="muted">{unit}</span>
    </span>
  );
}
