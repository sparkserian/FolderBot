// Activity: what the watcher is doing right now, file by file, and why.
import {
  ArrowClockwise,
  ArrowRight,
  CaretDown,
  CheckCircle,
  Clock,
  FileText,
  FilmStrip,
  FolderOpen,
  FolderSimpleDashed,
  GearSix,
  HourglassMedium,
  LockSimple,
  MagnifyingGlass,
  Pause,
  PencilSimpleLine,
  Play,
  SkipForward,
  Stop,
  Television,
  WarningOctagon,
  type Icon as PhosphorIcon
} from "@phosphor-icons/react";
import { useState } from "react";
import type { AutomationJob, AutomationStatus } from "../../shared/types";
import { Button, EmptyState, InfoBar, PageHeader, ProgressBar, Section, Spinner, useNow } from "../components/ui";
import {
  formatBytes,
  formatClock,
  formatElapsed,
  formatEta,
  formatRelative,
  formatSpeed,
  plural,
  STAGE_LABELS
} from "../format";
import { api, describe, navigate, toast, useStore } from "../store";

const ACTIVE = new Set<AutomationJob["stage"]>(["matching", "copying", "moving"]);

export function ActivityPage() {
  const automation = useStore((current) => current.automation);
  const settings = useStore((current) => current.settings);
  const loaded = useStore((current) => current.loaded);
  const historyCount = useStore((current) => current.automationHistory.length + current.renameHistory.length);
  const now = useNow();

  const neverSetUp = loaded && !settings.automationInboxDirectory && !settings.automationEnabled;
  const jobs = automation.jobs;
  const active = jobs.filter((job) => ACTIVE.has(job.stage));
  const attention = jobs.filter((job) => job.stage === "failed" || job.stage === "locked");
  const waiting = jobs.filter((job) => job.stage === "arriving" || job.stage === "settling" || job.stage === "queued");
  const skipped = jobs.filter((job) => job.stage === "skipped");
  const filed = jobs.filter((job) => job.stage === "filed");

  const toggle = async () => {
    const next = !settings.automationEnabled;
    try {
      const saved = await api.setAutomationEnabled(next);
      toast(saved.automationEnabled ? "Watching the inbox" : "Watcher paused", "success");
    } catch (error) {
      toast(`Could not change the watcher: ${describe(error)}`, "error");
    }
  };

  if (neverSetUp) {
    return <Welcome hasHistory={historyCount > 0} />;
  }

  return (
    <>
      <PageHeader
        title="Activity"
        subtitle={<WatcherLine automation={automation} now={now} />}
        actions={
          <>
            {settings.automationInboxDirectory ? (
              <Button icon={FolderOpen} onClick={() => void api.openFolder(settings.automationInboxDirectory)}>
                Open inbox
              </Button>
            ) : null}
            <Button
              variant={settings.automationEnabled ? "standard" : "accent"}
              icon={settings.automationEnabled ? Pause : Play}
              onClick={() => void toggle()}
            >
              {settings.automationEnabled ? "Pause" : "Resume"}
            </Button>
          </>
        }
      />

      {!settings.automationEnabled ? (
        <InfoBar
          tone="warning"
          title="The watcher is paused"
          actions={<Button size="small" variant="accent" icon={Play} onClick={() => void toggle()}>Resume</Button>}
        >
          New downloads stay in the inbox until you resume it.
        </InfoBar>
      ) : null}

      {automation.problems.map((problem) => (
        <InfoBar
          key={problem.message}
          tone="error"
          title={problem.message}
          actions={
            problem.path ? (
              <Button size="small" icon={FolderOpen} onClick={() => void openOrReport(problem.path ?? "")}>Open folder</Button>
            ) : (
              <Button size="small" icon={GearSix} onClick={() => navigate("settings", "automation")}>Settings</Button>
            )
          }
        >
          {problem.hint}
        </InfoBar>
      ))}

      {active.map((job) => (
        <ActiveJob key={job.id} job={job} now={now} />
      ))}

      {attention.length > 0 ? (
        <Section title="Needs attention">
          <div className="list">
            {attention.map((job) => (
              <JobRow key={job.id} job={job} now={now} />
            ))}
          </div>
        </Section>
      ) : null}

      {waiting.length > 0 ? (
        <Section title="Waiting">
          <div className="list">
            {waiting.map((job) => (
              <JobRow key={job.id} job={job} now={now} />
            ))}
          </div>
        </Section>
      ) : null}

      {active.length === 0 && attention.length === 0 && waiting.length === 0 && settings.automationEnabled && automation.problems.length === 0 ? (
        <div className="idle-card">
          <CheckCircle size={28} weight="fill" className="idle-icon" aria-hidden />
          <div>
            <strong>All caught up</strong>
            <p>
              Anything that lands in <span className="path-inline">{automation.inboxDirectory}</span> is renamed and filed once it
              finishes downloading and stops changing for {automation.settleSeconds} seconds.
            </p>
          </div>
        </div>
      ) : null}

      {skipped.length > 0 ? (
        <Section title="Left alone">
          <div className="list">
            {skipped.map((job) => (
              <JobRow key={job.id} job={job} now={now} />
            ))}
          </div>
        </Section>
      ) : null}

      {filed.length > 0 ? (
        <Section
          title="Filed recently"
          aside={
            <div className="section-aside">
              <Button variant="subtle" size="small" onClick={() => navigate("history")}>All history</Button>
              <Button variant="subtle" size="small" onClick={() => void api.clearFinishedAutomationJobs()}>Clear</Button>
            </div>
          }
        >
          <div className="list">
            {filed.map((job) => (
              <FiledRow key={job.id + (job.finishedAt ?? "")} job={job} now={now} />
            ))}
          </div>
        </Section>
      ) : null}

      <EventLog automation={automation} />
    </>
  );
}

function WatcherLine({ automation, now }: { automation: AutomationStatus; now: number }) {
  if (!automation.enabled) {
    return <>Paused. Files in the inbox are left alone.</>;
  }
  if (!automation.watching) {
    return <>Not watching yet. Finish setting up automation.</>;
  }
  return (
    <>
      Watching <span className="path-inline">{automation.inboxDirectory}</span>
      {automation.lastScanAt ? <span className="muted"> · checked {formatRelative(automation.lastScanAt, now)}</span> : null}
    </>
  );
}

// The file being filed right now, with full progress.
function ActiveJob({ job, now }: { job: AutomationJob; now: number }) {
  const progress = job.progress;
  const percent = progress && progress.bytesTotal > 0 ? (progress.bytesDone / progress.bytesTotal) * 100 : undefined;
  const stopping = job.detail === "Stopping…";

  return (
    <section className="now-card" aria-label={`Filing ${job.fileName}`}>
      <div className="now-head">
        <MediaIcon job={job} />
        <div className="now-title">
          <span className="now-eyebrow">
            <Spinner size={14} /> {STAGE_LABELS[job.stage]}
            {progress ? ` · step ${progress.stepIndex} of ${progress.stepCount}` : ""}
          </span>
          <strong>{job.title || job.fileName}</strong>
          <span className="now-names">
            {job.fileName}
            {job.targetName && job.targetName !== job.fileName ? (
              <>
                <ArrowRight size={12} aria-hidden /> {job.targetName}
              </>
            ) : null}
          </span>
        </div>
        <Button icon={Stop} busy={stopping} onClick={() => void api.skipAutomationJob(job.id)}>
          Stop
        </Button>
      </div>

      <ProgressBar
        label={`${STAGE_LABELS[job.stage]} ${job.fileName}`}
        value={percent}
        indeterminate={percent === undefined || job.stage === "matching"}
      />

      <div className="now-stats">
        {progress && job.stage !== "matching" ? (
          <>
            <span className="now-percent">{Math.floor(percent ?? 0)}%</span>
            <span>
              {formatBytes(progress.bytesDone)} of {formatBytes(progress.bytesTotal)}
            </span>
            {progress.bytesPerSecond > 0 ? <span>{formatSpeed(progress.bytesPerSecond)}</span> : null}
            <span>{formatEta(progress.etaSeconds)}</span>
          </>
        ) : (
          <span>
            {formatBytes(job.size)} · started {formatElapsed(job.stageSince, now)} ago
          </span>
        )}
      </div>
      <p className="now-detail">{job.detail}</p>
    </section>
  );
}

const STAGE_ICONS: Record<AutomationJob["stage"], PhosphorIcon> = {
  arriving: HourglassMedium,
  settling: Clock,
  locked: LockSimple,
  queued: Clock,
  matching: MagnifyingGlass,
  copying: ArrowRight,
  moving: ArrowRight,
  filed: CheckCircle,
  failed: WarningOctagon,
  skipped: SkipForward
};

function JobRow({ job, now }: { job: AutomationJob; now: number }) {
  const [busy, setBusy] = useState(false);
  const IconComponent = STAGE_ICONS[job.stage];
  const retryIn = job.error?.willRetryAt ? Math.max(0, Date.parse(job.error.willRetryAt) - now) : null;

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      toast(describe(error), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`row job-row stage-${job.stage}`}>
      <IconComponent className="row-icon" size={20} weight={job.stage === "failed" || job.stage === "filed" ? "fill" : "regular"} aria-hidden />
      <div className="row-text">
        <span className="row-title" title={job.inboxPath}>{job.fileName}</span>
        <span className="row-detail">
          {job.stage === "failed" && retryIn !== null && retryIn > 0
            ? `${job.error?.message ?? job.detail} Trying again in ${formatElapsed(new Date(now - retryIn).toISOString(), now)}.`
            : job.detail}
        </span>
        {job.stage === "failed" && job.error?.hint ? <span className="row-hint">{job.error.hint}</span> : null}
      </div>
      <div className="row-meta">
        <span className={`stage-pill stage-pill-${job.stage}`}>{STAGE_LABELS[job.stage]}</span>
        <span className="row-sub">
          {formatBytes(job.size)} · {formatElapsed(job.stageSince, now)}
        </span>
      </div>
      <div className="row-actions">
        {job.stage === "failed" || job.stage === "skipped" ? (
          <Button size="small" icon={ArrowClockwise} busy={busy} onClick={() => void run(() => api.retryAutomationJob(job.id))}>
            {job.stage === "skipped" ? "File it" : "Retry"}
          </Button>
        ) : null}
        {job.stage !== "skipped" ? (
          <Button size="small" variant="subtle" icon={SkipForward} disabled={busy} title="Leave this file alone until it changes" onClick={() => void run(() => api.skipAutomationJob(job.id))}>
            Skip
          </Button>
        ) : null}
        <Button size="small" variant="subtle" icon={FolderOpen} aria-label="Show in folder" title="Show in folder" onClick={() => void api.showItemInFolder(job.inboxPath)} />
      </div>
    </div>
  );
}

function FiledRow({ job, now }: { job: AutomationJob; now: number }) {
  return (
    <div className="row job-row stage-filed">
      <MediaIcon job={job} small />
      <div className="row-text">
        <span className="row-title">{job.targetName ?? job.fileName}</span>
        <span className="row-detail" title={job.sourceLibraryPath}>
          {job.title ? `${job.title} · ` : ""}
          {formatBytes(job.size)}
        </span>
      </div>
      <div className="row-meta">
        <span className="stage-pill stage-pill-filed">Filed</span>
        <span className="row-sub">{job.finishedAt ? formatRelative(job.finishedAt, now) : ""}</span>
      </div>
      <div className="row-actions">
        {job.sourceLibraryPath ? (
          <Button size="small" variant="subtle" icon={FolderOpen} aria-label="Show in folder" title="Show in the source library" onClick={() => void api.showItemInFolder(job.sourceLibraryPath ?? "")} />
        ) : null}
      </div>
    </div>
  );
}

function MediaIcon({ job, small }: { job: AutomationJob; small?: boolean }) {
  const IconComponent = job.mediaKind === "movie" ? FilmStrip : job.mediaKind === "episode" ? Television : FileText;
  return (
    <span className={`media-icon${small ? " is-small" : ""}`} aria-hidden>
      <IconComponent size={small ? 18 : 22} />
    </span>
  );
}

// The raw event list, for when the summary is not enough.
function EventLog({ automation }: { automation: AutomationStatus }) {
  const [open, setOpen] = useState(false);
  const events = automation.recentEvents;

  return (
    <section className="section">
      <button type="button" className="disclosure" aria-expanded={open} onClick={() => setOpen(!open)}>
        <CaretDown size={14} className="disclosure-caret" aria-hidden />
        <span>Detailed log</span>
        <span className="muted">{events.length > 0 ? plural(events.length, "event") : "empty"}</span>
      </button>
      {open ? (
        <div className="event-log">
          <div className="event-log-actions">
            <Button size="small" icon={FileText} onClick={() => void api.openLog()}>Open full log file</Button>
          </div>
          {events.length === 0 ? (
            <p className="muted">Nothing yet. Every step the watcher takes is listed here.</p>
          ) : (
            <ol>
              {events.map((event, index) => (
                <li key={`${event.createdAt}-${index}`} className={`event event-${event.level ?? "info"}`}>
                  <time>{formatClock(event.createdAt)}</time>
                  <span>{event.message}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      ) : null}
    </section>
  );
}

function Welcome({ hasHistory }: { hasHistory: boolean }) {
  return (
    <>
      <PageHeader title="Welcome to FolderBot" subtitle="Clean names and tidy folders for your TV episodes and movies." />
      <div className="welcome-grid">
        <button type="button" className="welcome-card" onClick={() => navigate("settings", "automation")}>
          <FolderSimpleDashed size={32} weight="light" aria-hidden />
          <strong>File downloads automatically</strong>
          <span>Pick an inbox folder and your libraries. Each finished download is renamed, copied to the mirror library and moved into place.</span>
          <span className="welcome-link">Set up the watcher <ArrowRight size={14} aria-hidden /></span>
        </button>
        <button type="button" className="welcome-card" onClick={() => navigate("rename")}>
          <PencilSimpleLine size={32} weight="light" aria-hidden />
          <strong>Rename a batch now</strong>
          <span>Drop in episodes or movies, check the new names side by side, then rename. Every batch can be undone.</span>
          <span className="welcome-link">Go to Rename <ArrowRight size={14} aria-hidden /></span>
        </button>
      </div>
      {hasHistory ? (
        <EmptyState icon={Clock} title="Your earlier work is in History" actions={<Button onClick={() => navigate("history")}>Open History</Button>} />
      ) : null}
    </>
  );
}

async function openOrReport(folder: string): Promise<void> {
  const error = await api.openFolder(folder);
  if (error) {
    toast(`Windows could not open ${folder}: ${error}`, "error");
  }
}
