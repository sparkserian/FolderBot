// The automation watcher, plus the folder-repair flows that share its library helpers.
//
// Every media file in the inbox becomes a job. A job always has a stage and one plain sentence
// saying what is happening or why it is waiting, so the app never sits on an unexplained
// "waiting": a file that is still arriving, settling, locked by another program, queued behind
// another file, copying (with bytes, speed and time left), failed (with the reason and a fix),
// or skipped is shown as exactly that.
import { promises as fs } from "node:fs";
import path from "node:path";
import { app } from "electron";
import { parseMediaName, toDisplayTitle } from "../shared/filename-parser";
import type {
  AppSettings,
  AutomationEvent,
  AutomationJob,
  AutomationJobError,
  AutomationJobProgress,
  AutomationProblem,
  AutomationRepairEntryResult,
  AutomationRepairRequest,
  AutomationRepairResult,
  AutomationStatus,
  MediaKind,
  RenameOptions,
  RenamePreview,
  RepairShowLocationResult,
  RepairShowResult,
  ResolvedMetadata
} from "../shared/types";
import {
  getAutomationHistory,
  recordAutomationHistoryEntry,
  saveAutomationHistory
} from "./automation-history-store";
import { moveFile, sanitizeWindowsReservedName } from "./file-ops";
import { resolveEpisodeFromSeriesMatch } from "./providers";
import { previewRenames } from "./rename-service";
import { copyWithProgress, freeBytes, moveWithProgress, sameVolume, type TransferProgress } from "./transfer";

const MEDIA_EXTENSIONS = new Set([".mkv", ".mp4", ".avi", ".mov", ".m4v", ".wmv", ".srt", ".ass", ".mpg", ".mpeg"]);
const TEMP_EXTENSIONS = [".part", ".crdownload", ".tmp", ".partial", ".download", ".!qb", ".!ut", ".aria2"];
const SCAN_INTERVAL_MS = 3_000;
const MIN_STABLE_PASSES = 2;
const MAX_EVENTS = 200;
const MAX_FINISHED_JOBS = 30;
const RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000];
const STATUS_THROTTLE_MS = 250;
// Space kept free on a library drive on top of the file itself.
const SPACE_MARGIN_BYTES = 256 * 1024 * 1024;

const ACTIVE_STAGES = new Set<AutomationJob["stage"]>(["matching", "copying", "moving"]);
const WAITING_STAGES = new Set<AutomationJob["stage"]>(["arriving", "settling", "locked", "queued"]);

// Internal bookkeeping kept alongside what the renderer sees.
type JobRecord = AutomationJob & {
  mtimeMs: number;
  lastSizeAt: number;
  stablePasses: number;
  stableSince: number;
  // Failed, skipped and undone files are held until their size or date changes.
  heldSignature?: string;
  retryAt?: number;
  abort?: AbortController;
  stopRequested?: boolean;
};

export interface AutomationCallbacks {
  onStatus: (status: AutomationStatus) => void;
  onJobFinished?: (job: AutomationJob) => void;
}

let settings: AppSettings | null = null;
let callbacks: AutomationCallbacks | null = null;
let scanTimer: NodeJS.Timeout | null = null;
let scanInFlight = false;
let workerRunning = false;
let statusTimer: NodeJS.Timeout | null = null;
let lastStatusAt = 0;
let lastScanAt: string | undefined;
let problems: AutomationProblem[] = [];
const jobs = new Map<string, JobRecord>();
const finishedJobs: AutomationJob[] = [];
const recentEvents: AutomationEvent[] = [];
// Log writes are serialized so messages stay ordered in the on-disk automation log.
let logWriteQueue = Promise.resolve();

export function initializeAutomationService(nextSettings: AppSettings, nextCallbacks: AutomationCallbacks): void {
  callbacks = nextCallbacks;
  settings = nextSettings;
  restartWatcher();
}

// Any settings change that affects automation restarts the watcher with the new configuration.
export function updateAutomationSettings(nextSettings: AppSettings): void {
  const previous = settings;
  settings = nextSettings;

  const watcherChanged =
    !previous ||
    previous.automationEnabled !== nextSettings.automationEnabled ||
    previous.automationInboxDirectory !== nextSettings.automationInboxDirectory ||
    previous.automationSourceLibraryDirectory !== nextSettings.automationSourceLibraryDirectory ||
    previous.automationMirrorLibraryDirectory !== nextSettings.automationMirrorLibraryDirectory ||
    previous.automationMovieSourceDirectory !== nextSettings.automationMovieSourceDirectory ||
    previous.automationMovieMirrorDirectory !== nextSettings.automationMovieMirrorDirectory;

  if (watcherChanged) {
    restartWatcher();
  } else {
    emitStatus(true);
  }
}

// An undo puts a file back in the inbox. Hold it until the user changes it, so the watcher
// does not file it straight back.
export async function suppressAutomationInboxFile(filePath: string): Promise<void> {
  const stats = await statFile(filePath);
  if (!stats) {
    return;
  }

  const key = path.resolve(filePath);
  const job = jobs.get(key) ?? createJob(key, stats.size, stats.mtimeMs);
  setStage(job, "skipped", "Returned to the inbox by Undo. FolderBot will leave it alone until the file changes.");
  job.heldSignature = signature(stats.size, stats.mtimeMs);
  jobs.set(key, job);
  addEvent(`Holding ${job.fileName}: it was returned by Undo.`, "info", job.id);
}

// Retry a failed or skipped file now.
export async function retryAutomationJob(jobId: string): Promise<void> {
  const job = findJob(jobId);
  if (!job || (job.stage !== "failed" && job.stage !== "skipped")) {
    return;
  }

  const stats = await statFile(job.inboxPath);
  if (!stats) {
    jobs.delete(job.inboxPath);
    addEvent(`${job.fileName} is no longer in the inbox.`, "warning", job.id);
    return;
  }

  job.heldSignature = undefined;
  job.retryAt = undefined;
  job.error = undefined;
  job.attempts = 0;
  job.size = stats.size;
  job.mtimeMs = stats.mtimeMs;
  setStage(job, "queued", "Retrying now.");
  addEvent(`Retrying ${job.fileName}.`, "info", job.id);
  void runWorker();
}

// Stop a file that is being filed, or leave a waiting or failed file alone until it changes.
export async function skipAutomationJob(jobId: string): Promise<void> {
  const job = findJob(jobId);
  if (!job || job.stage === "filed") {
    return;
  }

  if (ACTIVE_STAGES.has(job.stage)) {
    job.stopRequested = true;
    job.abort?.abort();
    job.detail = "Stopping…";
    emitStatus(true);
    return;
  }

  holdAsSkipped(job, "Skipped by you. FolderBot will leave it alone until the file changes.");
  addEvent(`Skipped ${job.fileName}.`, "info", job.id);
}

// Remove finished items from the activity list.
export function clearFinishedAutomationJobs(): void {
  finishedJobs.splice(0);
  emitStatus(true);
}

// Provide the renderer with a snapshot of the watcher's current status.
export function getAutomationStatus(): AutomationStatus {
  const current = settings;
  const live = Array.from(jobs.values()).map(publicJob).sort(compareJobs);

  return {
    enabled: current?.automationEnabled ?? false,
    watching: isWatcherActive(),
    processing: live.some((job) => ACTIVE_STAGES.has(job.stage)),
    inboxDirectory: current?.automationInboxDirectory ?? "",
    sourceLibraryDirectory: current?.automationSourceLibraryDirectory ?? "",
    mirrorLibraryDirectory: current?.automationMirrorLibraryDirectory ?? "",
    movieSourceDirectory: current?.automationMovieSourceDirectory ?? "",
    movieMirrorDirectory: current?.automationMovieMirrorDirectory ?? "",
    sourceId: current?.automationSourceId ?? "tvdb",
    settleSeconds: current?.automationSettleSeconds ?? 45,
    pendingCount: live.filter((job) => WAITING_STAGES.has(job.stage)).length,
    recentEvents: [...recentEvents],
    jobs: [...live, ...finishedJobs],
    problems: [...problems],
    lastScanAt,
    logPath: getAutomationLogPath()
  };
}

export function getAutomationLogPath(): string {
  return path.join(app.getPath("userData"), "automation.log");
}

// ------------------------------------------------------------------ watcher lifecycle

function restartWatcher(): void {
  stopWatcher();

  // Jobs that are mid-transfer keep running; everything else is rediscovered on the next scan.
  for (const [key, job] of jobs) {
    if (!ACTIVE_STAGES.has(job.stage) && job.stage !== "skipped") {
      jobs.delete(key);
    }
  }
  problems = [];

  if (!settings?.automationEnabled) {
    emitStatus(true);
    return;
  }

  const setupProblems = describeSetupProblems(settings);
  if (setupProblems.length > 0) {
    problems = setupProblems;
    emitStatus(true);
    return;
  }

  scanTimer = setInterval(() => {
    void scanInbox();
  }, SCAN_INTERVAL_MS);

  queueLogLine("---- watcher started ----");
  addEvent(`Watching ${settings.automationInboxDirectory}.`, "info");
  void scanInbox();
}

function stopWatcher(): void {
  if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
  }
}

function isWatcherActive(): boolean {
  return Boolean(scanTimer) && Boolean(settings?.automationEnabled);
}

function describeSetupProblems(current: AppSettings): AutomationProblem[] {
  const found: AutomationProblem[] = [];

  if (!current.automationInboxDirectory) {
    found.push({ message: "Choose an inbox folder to watch.", hint: "Settings › Automation › Inbox" });
  }

  if (!hasEpisodeTargets(current) && !hasMovieTargets(current)) {
    found.push({
      message: "Choose where files go.",
      hint: "Set both TV libraries, both movie libraries, or all four in Settings › Automation."
    });
  }

  return found;
}

// ------------------------------------------------------------------ scanning

async function scanInbox(): Promise<void> {
  if (!settings || scanInFlight) {
    return;
  }

  scanInFlight = true;
  const current = settings;
  const now = Date.now();

  try {
    const nextProblems: AutomationProblem[] = [];
    let entries: import("node:fs").Dirent[];

    try {
      entries = await fs.readdir(current.automationInboxDirectory, { withFileTypes: true });
    } catch (error) {
      nextProblems.push(describeFolderProblem("inbox", current.automationInboxDirectory, error));
      problems = nextProblems;
      return;
    }

    nextProblems.push(...(await checkLibraryRoots(current)));

    const names = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name.toLowerCase()));
    const seen = new Set<string>();
    const foldersWithMedia: string[] = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && (await folderHasMedia(path.join(current.automationInboxDirectory, entry.name)))) {
          foldersWithMedia.push(entry.name);
        }
        continue;
      }

      if (!entry.isFile() || !isMediaFile(entry.name)) {
        continue;
      }

      const key = path.resolve(current.automationInboxDirectory, entry.name);
      seen.add(key);
      await observeFile(key, entry.name, names, current, now);
    }

    if (foldersWithMedia.length > 0) {
      nextProblems.push({
        message:
          foldersWithMedia.length === 1
            ? `"${foldersWithMedia[0]}" is a folder, so FolderBot is not filing the videos inside it.`
            : `${foldersWithMedia.length} folders in the inbox hold videos that FolderBot is not filing.`,
        hint: "FolderBot only picks up files sitting directly in the inbox. Move the video out of the folder to file it.",
        path: current.automationInboxDirectory
      });
    }

    // Files that left the inbox on their own (deleted, or moved by the user).
    for (const [key, job] of jobs) {
      if (!seen.has(key) && !ACTIVE_STAGES.has(job.stage)) {
        jobs.delete(key);
        if (job.stage !== "skipped" && job.stage !== "failed") {
          addEvent(`${job.fileName} left the inbox before it was filed.`, "info", job.id);
        }
      }
    }

    problems = nextProblems;
  } catch (error) {
    problems = [{ message: `The inbox scan failed: ${formatError(error)}` }];
    addEvent(`Inbox scan failed: ${formatError(error)}`, "error");
  } finally {
    lastScanAt = new Date().toISOString();
    scanInFlight = false;
    emitStatus();
    void runWorker();
  }
}

// Move one file through arriving, settling, locked and queued based on what changed since the
// last scan.
async function observeFile(key: string, fileName: string, inboxNames: Set<string>, current: AppSettings, now: number): Promise<void> {
  const stats = await statFile(key);
  if (!stats) {
    return;
  }

  let job = jobs.get(key);
  const currentSignature = signature(stats.size, stats.mtimeMs);

  if (!job) {
    job = createJob(key, stats.size, stats.mtimeMs);
    jobs.set(key, job);
    setStage(job, "settling", "Just found. Checking that it has finished arriving.");
    job.readyAt = new Date(now + current.automationSettleSeconds * 1000).toISOString();
    addEvent(`Found ${fileName} (${formatBytes(stats.size)}).`, "info", job.id);
    return;
  }

  if (ACTIVE_STAGES.has(job.stage)) {
    return;
  }

  if (job.stage === "failed" || job.stage === "skipped") {
    if (job.heldSignature === currentSignature) {
      if (job.stage === "failed" && job.retryAt && now >= job.retryAt) {
        job.retryAt = undefined;
        setStage(job, "queued", `Trying again (attempt ${job.attempts + 1}).`);
      }
      return;
    }

    // The file changed, so the hold no longer applies; watch it from scratch.
    job.heldSignature = undefined;
    job.error = undefined;
    job.retryAt = undefined;
    job.attempts = 0;
    addEvent(`${fileName} changed, so FolderBot is watching it again.`, "info", job.id);
  }

  const partner = findTempPartner(fileName, inboxNames);
  const changed = stats.size !== job.size || stats.mtimeMs !== job.mtimeMs;

  if (changed) {
    const seconds = Math.max(0.5, (now - job.lastSizeAt) / 1000);
    const grown = stats.size - job.size;
    job.growthBytesPerSecond = grown > 0 ? grown / seconds : 0;
    job.size = stats.size;
    job.mtimeMs = stats.mtimeMs;
    job.lastSizeAt = now;
    job.stableSince = now;
    job.stablePasses = 0;
    job.readyAt = undefined;
    setStage(
      job,
      "arriving",
      grown > 0
        ? `Still arriving: ${formatBytes(stats.size)} so far, growing about ${formatBytes(job.growthBytesPerSecond)}/s.`
        : "Still being written. Waiting for it to stop changing."
    );
    return;
  }

  if (partner) {
    job.stableSince = now;
    job.stablePasses = 0;
    setStage(job, "arriving", `The download is not finished yet (${partner} is still in the inbox).`);
    return;
  }

  job.stablePasses += 1;
  job.growthBytesPerSecond = undefined;
  const settleMs = current.automationSettleSeconds * 1000;
  const remainingMs = settleMs - (now - job.stableSince);

  if (job.stablePasses < MIN_STABLE_PASSES || remainingMs > 0) {
    job.readyAt = new Date(now + Math.max(0, remainingMs)).toISOString();
    const quietFor = Math.round((now - job.stableSince) / 1000);
    setStage(
      job,
      "settling",
      `No changes for ${quietFor}s. Starts in ${Math.max(1, Math.ceil(remainingMs / 1000))}s if it stays that way.`
    );
    return;
  }

  const access = await checkAccess(key);
  if (!access.ok) {
    const lockedFor = job.stage === "locked" ? ` (for ${formatDuration(now - Date.parse(job.stageSince))})` : "";
    setStage(job, "locked", `${access.detail}${lockedFor}`, job.stage === "locked");
    if (job.stage === "locked" && !job.error) {
      job.error = { message: access.detail, code: access.code, at: new Date().toISOString() };
    }
    return;
  }

  job.error = undefined;
  if (job.stage !== "queued") {
    job.readyAt = undefined;
    setStage(job, "queued", "Ready to file.");
  }
}

// ------------------------------------------------------------------ filing

// Files are filed one at a time, oldest first, so two large copies never fight over a drive.
async function runWorker(): Promise<void> {
  if (workerRunning) {
    return;
  }

  workerRunning = true;

  try {
    for (;;) {
      const next = Array.from(jobs.values())
        .filter((job) => job.stage === "queued")
        .sort((left, right) => Date.parse(left.firstSeenAt) - Date.parse(right.firstSeenAt))[0];

      if (!next || !settings) {
        break;
      }

      for (const waiting of jobs.values()) {
        if (waiting.stage === "queued" && waiting !== next) {
          waiting.detail = `Ready. Waiting for ${next.fileName} to finish first.`;
        }
      }

      await fileJob(next, settings);
    }
  } finally {
    workerRunning = false;
    emitStatus(true);
  }
}

async function fileJob(job: JobRecord, current: AppSettings): Promise<void> {
  const stats = await statFile(job.inboxPath);
  if (!stats) {
    jobs.delete(job.inboxPath);
    return;
  }

  if (signature(stats.size, stats.mtimeMs) !== signature(job.size, job.mtimeMs)) {
    // It changed between the last scan and now; let it settle again.
    job.size = stats.size;
    job.mtimeMs = stats.mtimeMs;
    job.stableSince = Date.now();
    job.stablePasses = 0;
    setStage(job, "arriving", "It changed again just before filing. Waiting for it to settle.");
    return;
  }

  job.attempts += 1;
  job.abort = new AbortController();
  job.stopRequested = false;
  job.error = undefined;
  job.progress = undefined;

  try {
    const sourceLabel = current.automationSourceId === "tvdb" ? "TheTVDB" : current.automationSourceId === "tmdb" ? "TMDb" : "the local parser";
    setStage(job, "matching", `Reading the name${current.automationSourceId === "local" ? "" : ` and looking it up on ${sourceLabel}`}.`);
    addEvent(`Filing ${job.fileName} (${formatBytes(job.size)}).`, "info", job.id);

    const preview = await buildRenamePreview(job.inboxPath, current);
    const targets = resolveAutomationTargets(preview.parsed.kind, current);
    job.mediaKind = preview.parsed.kind;
    job.title = preview.metadata?.displayTitle || toDisplayTitle(preview.parsed.normalizedTitle);
    job.targetName = preview.targetName;

    const mirror = await resolveLibraryTargetPath(preview, targets.mirrorRoot, preview.targetName);
    const source = await resolveLibraryTargetPath(preview, targets.sourceRoot, preview.targetName);
    logFolderCreationEvents("mirror", mirror, targets.libraryLabel);
    logFolderCreationEvents("source", source, targets.libraryLabel);

    const mirrorExists = await pathExists(mirror.targetPath);
    const sourceNeedsCopy = !sameVolume(job.inboxPath, source.targetPath);
    const stepCount = (mirrorExists ? 0 : 1) + 1;
    let stepIndex = 0;

    await ensureSpace(mirrorExists ? 0 : job.size, mirror.targetPath, "mirror library");
    await ensureSpace(sourceNeedsCopy ? job.size : 0, source.targetPath, "source library");

    if (mirrorExists) {
      addEvent(`The mirror library already has ${preview.targetName}; keeping that copy.`, "warning", job.id);
    } else {
      stepIndex += 1;
      setStage(job, "copying", `Copying to the mirror library: ${path.dirname(mirror.targetPath)}`);
      job.progress = startProgress("mirror", stepIndex, stepCount, job.size);
      await copyWithProgress(job.inboxPath, mirror.targetPath, {
        signal: job.abort.signal,
        onProgress: (progress) => updateProgress(job, "mirror", stepIndex, stepCount, progress)
      });
      addEvent(`Copied to the mirror library: ${mirror.targetPath}`, "info", job.id);
    }

    stepIndex += 1;
    setStage(
      job,
      "moving",
      sourceNeedsCopy
        ? `Moving into the source library on another drive (copy, then remove from the inbox): ${path.dirname(source.targetPath)}`
        : `Moving into the source library: ${path.dirname(source.targetPath)}`
    );
    job.progress = startProgress("source", stepIndex, stepCount, job.size);
    await moveWithProgress(job.inboxPath, source.targetPath, {
      signal: job.abort.signal,
      onProgress: (progress) => updateProgress(job, "source", stepIndex, stepCount, progress)
    });
    addEvent(`Moved into the source library: ${source.targetPath}`, "info", job.id);

    const entry = await recordAutomationHistoryEntry({
      sourceId: preview.metadata?.sourceId ?? (preview.parsed.kind === "movie" ? "local" : current.automationSourceId),
      mediaKind: preview.parsed.kind,
      originalInboxPath: job.inboxPath,
      sourceLibraryPath: source.targetPath,
      mirrorLibraryPath: mirror.targetPath,
      displayTitle: job.title
    });

    job.sourceLibraryPath = source.targetPath;
    job.mirrorLibraryPath = mirror.targetPath;
    job.historyEntryId = entry.id;
    job.progress = undefined;
    job.finishedAt = new Date().toISOString();
    setStage(job, "filed", `Filed as ${preview.targetName}`);
    addEvent(`Filed ${job.fileName} as ${preview.targetName}.`, "success", job.id);

    jobs.delete(job.inboxPath);
    finishedJobs.unshift(publicJob(job));
    finishedJobs.splice(MAX_FINISHED_JOBS);
    callbacks?.onJobFinished?.(publicJob(job));
  } catch (error) {
    job.progress = undefined;

    if (job.stopRequested) {
      holdAsSkipped(job, "Stopped by you. FolderBot will leave it alone until the file changes.");
      addEvent(`Stopped filing ${job.fileName}.`, "warning", job.id);
      return;
    }

    const described = describeError(error);
    const retryDelay = described.transient ? RETRY_DELAYS_MS[job.attempts - 1] : undefined;
    const now = Date.now();

    job.error = {
      message: described.message,
      hint: described.hint,
      code: described.code,
      at: new Date(now).toISOString(),
      willRetryAt: retryDelay ? new Date(now + retryDelay).toISOString() : undefined
    };
    job.retryAt = retryDelay ? now + retryDelay : undefined;
    const stats = await statFile(job.inboxPath);
    job.heldSignature = stats ? signature(stats.size, stats.mtimeMs) : undefined;
    setStage(
      job,
      "failed",
      retryDelay
        ? `${described.message} Trying again in ${formatDuration(retryDelay)}.`
        : described.message
    );
    addEvent(`Could not file ${job.fileName}: ${described.message}`, "error", job.id);

    if (!retryDelay) {
      callbacks?.onJobFinished?.(publicJob(job));
    }
  } finally {
    job.abort = undefined;
    emitStatus(true);
  }
}

function startProgress(step: AutomationJobProgress["step"], stepIndex: number, stepCount: number, size: number): AutomationJobProgress {
  return { step, stepIndex, stepCount, bytesDone: 0, bytesTotal: size, bytesPerSecond: 0, etaSeconds: null };
}

function updateProgress(
  job: JobRecord,
  step: AutomationJobProgress["step"],
  stepIndex: number,
  stepCount: number,
  progress: TransferProgress
): void {
  job.progress = { step, stepIndex, stepCount, ...progress };
  emitStatus();
}

async function ensureSpace(bytesNeeded: number, targetPath: string, label: string): Promise<void> {
  if (bytesNeeded <= 0) {
    return;
  }

  const available = await freeBytes(path.dirname(targetPath));
  if (available !== null && available < bytesNeeded + SPACE_MARGIN_BYTES) {
    throw Object.assign(
      new Error(
        `Not enough space for the ${label}: the file needs ${formatBytes(bytesNeeded)} and ${driveLabel(targetPath)} has ${formatBytes(available)} free.`
      ),
      { code: "ENOSPC" }
    );
  }
}

async function buildRenamePreview(
  filePath: string,
  current: AppSettings
): Promise<RenamePreview & { parsed: RenamePreview["parsed"] & { kind: "episode" | "movie" } }> {
  const parsed = parseMediaName(path.basename(filePath));
  const sourceId = parsed.kind === "movie" ? "local" : current.automationSourceId;
  const previews = await previewRenames({
    filePaths: [filePath],
    options: buildRenameOptions(current, sourceId)
  });

  const preview = previews[0];
  if (!preview) {
    throw new Error("FolderBot could not build a new name for this file.");
  }

  if (preview.parsed.kind !== "episode" && preview.parsed.kind !== "movie") {
    throw Object.assign(
      new Error("FolderBot could not tell whether this is a TV episode or a movie from its name."),
      { code: "UNRECOGNIZED" }
    );
  }

  if (preview.conflicts.length > 0) {
    throw new Error(preview.conflicts[0]);
  }

  return preview as RenamePreview & { parsed: RenamePreview["parsed"] & { kind: "episode" | "movie" } };
}

// ------------------------------------------------------------------ checks and descriptions

async function checkAccess(filePath: string): Promise<{ ok: true } | { ok: false; detail: string; code?: string }> {
  try {
    // Windows reports a file another program holds open for writing as EBUSY on a write open.
    const handle = await fs.open(filePath, process.platform === "win32" ? "r+" : "r");
    await handle.close();
    return { ok: true };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;

    if (code === "EBUSY") {
      return {
        ok: false,
        code,
        detail: "Another program has this file open (often the downloader or a virus scan). Filing starts as soon as it lets go."
      };
    }

    if (code === "EPERM" || code === "EACCES") {
      // A read-only file can still be copied; clear the flag so it can also be moved.
      const stats = await fs.stat(filePath).catch(() => null);
      if (stats && (stats.mode & 0o200) === 0) {
        const cleared = await fs.chmod(filePath, stats.mode | 0o200).then(() => true, () => false);
        if (cleared) {
          return { ok: true };
        }
      }

      return {
        ok: false,
        code,
        detail: "Windows is not letting FolderBot open this file. It may be in use or protected; FolderBot keeps checking."
      };
    }

    if (code === "ENOENT") {
      return { ok: false, code, detail: "The file disappeared from the inbox." };
    }

    return { ok: false, code, detail: `FolderBot cannot open this file yet: ${formatError(error)}` };
  }
}

async function checkLibraryRoots(current: AppSettings): Promise<AutomationProblem[]> {
  const roots: Array<[string, string]> = [
    ["TV source library", current.automationSourceLibraryDirectory],
    ["TV mirror library", current.automationMirrorLibraryDirectory],
    ["Movie source library", current.automationMovieSourceDirectory],
    ["Movie mirror library", current.automationMovieMirrorDirectory]
  ];
  const found: AutomationProblem[] = [];

  for (const [label, root] of roots) {
    if (!root) {
      continue;
    }

    // The folder itself is created when needed; its drive or parent has to be reachable.
    const probe = (await pathExists(root)) ? root : path.dirname(root);
    try {
      await fs.access(probe);
    } catch (error) {
      found.push(describeFolderProblem(label, root, error));
    }
  }

  return found;
}

function describeFolderProblem(label: string, folder: string, error: unknown): AutomationProblem {
  const code = (error as NodeJS.ErrnoException).code;
  const name = label === "inbox" ? "The inbox folder" : `The ${label}`;

  if (code === "ENOENT") {
    return {
      message: `${name} cannot be found.`,
      hint: `${folder} is missing. If it is on an external or network drive, check the drive is connected.`,
      path: folder
    };
  }

  if (code === "EACCES" || code === "EPERM") {
    return { message: `${name} cannot be opened: access was denied.`, hint: folder, path: folder };
  }

  return { message: `${name} cannot be opened: ${formatError(error)}`, hint: folder, path: folder };
}

function describeError(error: unknown): { message: string; hint?: string; code?: string; transient: boolean } {
  const code = (error as NodeJS.ErrnoException)?.code;
  const message = formatError(error);

  switch (code) {
    case "ENOSPC":
      return {
        code,
        transient: false,
        message: message.startsWith("Not enough space") ? message : "The drive ran out of space.",
        hint: "Free up space on that drive, then press Retry."
      };
    case "EEXIST":
      return {
        code,
        transient: false,
        message,
        hint: "Rename or remove one of the two files, then press Retry."
      };
    case "EBUSY":
      return { code, transient: true, message: "Another program is using the file.", hint: "Close any program that has it open." };
    case "EACCES":
    case "EPERM":
      return {
        code,
        transient: true,
        message: "Windows denied access while filing.",
        hint: "Check that FolderBot can write to the library folders and that no program has the file open."
      };
    case "ENOENT":
      return {
        code,
        transient: true,
        message,
        hint: "A folder or drive FolderBot needs is missing. Check the drive is connected."
      };
    case "EIO":
      return { code, transient: true, message: "The drive reported a read or write error.", hint: "Check the drive and its cable." };
    case "UNRECOGNIZED":
      return {
        code,
        transient: false,
        message,
        hint: "Rename the file so it includes S01E02 or a year, or file it from the Rename page."
      };
    case "ENOTFOUND":
    case "EAI_AGAIN":
    case "ECONNRESET":
    case "ETIMEDOUT":
    case "ECONNREFUSED":
      return { code, transient: true, message: "Could not reach the metadata service.", hint: "Check the internet connection." };
  }

  if (/fetch failed|network|timed out|socket/i.test(message)) {
    return { code, transient: true, message: "Could not reach the metadata service.", hint: "Check the internet connection." };
  }

  if (/configure both/i.test(message)) {
    return { code, transient: false, message, hint: "Settings › Automation" };
  }

  return { code, transient: false, message };
}

// ------------------------------------------------------------------ job helpers

function createJob(key: string, size: number, mtimeMs: number): JobRecord {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  return {
    id: key,
    fileName: path.basename(key),
    inboxPath: key,
    size,
    stage: "settling",
    detail: "",
    firstSeenAt: nowIso,
    stageSince: nowIso,
    attempts: 0,
    mtimeMs,
    lastSizeAt: now,
    stablePasses: 0,
    stableSince: now
  };
}

function setStage(job: JobRecord, stage: AutomationJob["stage"], detail: string, keepSince = false): void {
  if (job.stage !== stage && !keepSince) {
    job.stageSince = new Date().toISOString();
  }
  job.stage = stage;
  job.detail = detail;
  emitStatus(true);
}

function holdAsSkipped(job: JobRecord, detail: string): void {
  job.heldSignature = signature(job.size, job.mtimeMs);
  job.retryAt = undefined;
  job.progress = undefined;
  setStage(job, "skipped", detail);
}

function findJob(jobId: string): JobRecord | undefined {
  return jobs.get(jobId) ?? Array.from(jobs.values()).find((job) => job.id === jobId);
}

function publicJob(job: JobRecord | AutomationJob): AutomationJob {
  const {
    mtimeMs: _mtime,
    lastSizeAt: _lastSizeAt,
    stablePasses: _passes,
    stableSince: _since,
    heldSignature: _held,
    retryAt: _retry,
    abort: _abort,
    stopRequested: _stop,
    ...visible
  } = job as JobRecord;
  return { ...visible };
}

const STAGE_ORDER: Record<AutomationJob["stage"], number> = {
  copying: 0,
  moving: 0,
  matching: 0,
  failed: 1,
  locked: 2,
  queued: 3,
  settling: 4,
  arriving: 5,
  skipped: 6,
  filed: 7
};

function compareJobs(left: AutomationJob, right: AutomationJob): number {
  return STAGE_ORDER[left.stage] - STAGE_ORDER[right.stage] || Date.parse(left.firstSeenAt) - Date.parse(right.firstSeenAt);
}

function findTempPartner(fileName: string, inboxNames: Set<string>): string | null {
  const lower = fileName.toLowerCase();
  for (const extension of TEMP_EXTENSIONS) {
    if (inboxNames.has(`${lower}${extension}`)) {
      return `${fileName}${extension}`;
    }
  }
  return null;
}

async function folderHasMedia(folder: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(folder, { withFileTypes: true });
    return entries.some((entry) => entry.isFile() && isMediaFile(entry.name) && !/sample/i.test(entry.name));
  } catch {
    return false;
  }
}

function isMediaFile(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  if (lower.includes(".folderbot-")) {
    return false;
  }
  if (TEMP_EXTENSIONS.some((extension) => lower.endsWith(extension))) {
    return false;
  }
  return MEDIA_EXTENSIONS.has(path.extname(lower));
}

async function statFile(filePath: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const stats = await fs.stat(filePath);
    return { size: stats.size, mtimeMs: stats.mtimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function signature(size: number, mtimeMs: number): string {
  return `${size}:${mtimeMs}`;
}

function driveLabel(targetPath: string): string {
  const root = path.parse(path.resolve(targetPath)).root;
  return process.platform === "win32" ? `drive ${root.replace(/\\$/, "")}` : "that drive";
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** exponent;
  return `${value >= 100 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`;
}

function formatDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes} min`;
  }
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

// ------------------------------------------------------------------ events and status

// Event logging feeds both the activity screen and the persistent automation log file.
function addEvent(message: string, level: AutomationEvent["level"] = "info", jobId?: string): void {
  recentEvents.unshift({ createdAt: new Date().toISOString(), message, level, jobId });
  recentEvents.splice(MAX_EVENTS);
  queueLogLine(`${level === "info" ? "" : `${level?.toUpperCase()}: `}${message}`);
  emitStatus();
}

// Status updates are coalesced to a few per second so a fast copy does not flood the window.
function emitStatus(immediate = false): void {
  if (!callbacks) {
    return;
  }

  const now = Date.now();
  if (immediate || now - lastStatusAt >= STATUS_THROTTLE_MS) {
    if (statusTimer) {
      clearTimeout(statusTimer);
      statusTimer = null;
    }
    lastStatusAt = now;
    callbacks.onStatus(getAutomationStatus());
    return;
  }

  if (!statusTimer) {
    statusTimer = setTimeout(() => {
      statusTimer = null;
      lastStatusAt = Date.now();
      callbacks?.onStatus(getAutomationStatus());
    }, STATUS_THROTTLE_MS - (now - lastStatusAt));
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return "Unknown error";
}

function queueLogLine(message: string): void {
  const timestamp = new Date().toISOString();
  logWriteQueue = logWriteQueue
    .catch(() => undefined)
    .then(async () => {
      const logPath = getAutomationLogPath();
      await fs.mkdir(path.dirname(logPath), { recursive: true });
      await fs.appendFile(logPath, `[${timestamp}] ${message}\n`, "utf8");
    });
}

// ------------------------------------------------------------------ season and history repair

// Move misplaced root-level episode files into season folders for one or more chosen shows.
export async function repairSeasonPlacement(selectedFolderPaths: string[]): Promise<RepairShowResult[]> {
  if (selectedFolderPaths.length === 0) {
    throw new Error("No show folders were selected for repair");
  }

  const dedupedSelections = new Map<string, string>();

  for (const selectedFolderPath of selectedFolderPaths) {
    const normalizedSelection = path.resolve(selectedFolderPath);
    const selectedShowPath = await resolveSelectedShowPath(normalizedSelection);

    if (!dedupedSelections.has(selectedShowPath)) {
      dedupedSelections.set(selectedShowPath, normalizedSelection);
    }
  }

  const results: RepairShowResult[] = [];

  for (const selectedFolderPath of dedupedSelections.values()) {
    results.push(await repairSingleSeasonPlacement(selectedFolderPath));
  }

  return results;
}

async function repairSingleSeasonPlacement(selectedFolderPath: string): Promise<RepairShowResult> {
  if (!settings) {
    throw new Error("Automation settings are not loaded yet");
  }

  if (!settings.automationSourceLibraryDirectory || !settings.automationMirrorLibraryDirectory) {
    throw new Error("Automation source and mirror library roots must be configured first");
  }

  const normalizedSelection = path.resolve(selectedFolderPath);
  const selectedShowPath = await resolveSelectedShowPath(normalizedSelection);
  const showName = path.basename(selectedShowPath);

  addEvent(`Repair requested for show: ${showName}`);

  const sourceShowPath = await resolveShowPathForLibrary(
    settings.automationSourceLibraryDirectory,
    showName,
    normalizedSelection
  );
  const mirrorShowPath = await resolveShowPathForLibrary(
    settings.automationMirrorLibraryDirectory,
    showName,
    normalizedSelection
  );

  const locations = [
    await repairShowLocation("source", sourceShowPath),
    await repairShowLocation("mirror", mirrorShowPath)
  ];

  addEvent(`Repair finished for show: ${showName}`);

  return {
    selectedShowPath,
    showName,
    locations
  };
}

// Repair one or more automation history items against a show the user selected from provider search.
export async function repairAutomationHistoryEntries(
  request: AutomationRepairRequest
): Promise<AutomationRepairResult> {
  if (!settings) {
    throw new Error("Automation settings are not loaded yet");
  }

  if (request.match.sourceId === "local") {
    throw new Error("Local parser repairs are not supported. Use TMDb or TheTVDB.");
  }

  const history = await getAutomationHistory();
  const requestedIds = new Set(request.entryIds);
  const selectedEntries = history.filter((entry) => requestedIds.has(entry.id));

  if (selectedEntries.length === 0) {
    throw new Error("No automation history items were selected for repair");
  }

  const results: AutomationRepairEntryResult[] = [];
  const options = buildRenameOptions(settings, request.match.sourceId);
  let updatedCount = 0;

  for (const entry of selectedEntries) {
    if (entry.undoneAt) {
      results.push({
        entryId: entry.id,
        sourcePath: entry.sourceLibraryPath,
        mirrorPath: entry.mirrorLibraryPath,
        success: false,
        error: "This automation item has already been undone"
      });
      continue;
    }

    if (entry.mediaKind !== "episode") {
      results.push({
        entryId: entry.id,
        sourcePath: entry.sourceLibraryPath,
        mirrorPath: entry.mirrorLibraryPath,
        success: false,
        error: "Only TV episode automation items can be repaired"
      });
      continue;
    }

    try {
      const currentSourcePath = await resolveExistingAutomationPath(entry.sourceLibraryPath, entry.originalInboxPath);
      const currentMirrorPath = await resolveExistingAutomationPath(entry.mirrorLibraryPath);
      const basisPath = currentSourcePath ?? currentMirrorPath;

      if (!basisPath) {
        throw new Error("Could not find the current source or mirror file for this automation item");
      }

      const currentName = path.basename(basisPath);
      const parsed = parseMediaName(currentName);
      if (parsed.kind !== "episode") {
        throw new Error("Only TV episode repairs are supported");
      }

      const providerResult = await resolveEpisodeFromSeriesMatch(parsed, request.match, options);
      const metadata = providerResult.metadata;

      if (!metadata) {
        throw new Error(providerResult.warnings[0] || "Provider could not resolve a repair target");
      }

      const targetFileName = buildEpisodeTargetName(currentName, parsed, metadata);
      const sourceResolution = await resolveLibraryTargetPathForPlacement(
        { metadata, parsed },
        settings.automationSourceLibraryDirectory,
        targetFileName
      );
      const mirrorResolution = await resolveLibraryTargetPathForPlacement(
        { metadata, parsed },
        settings.automationMirrorLibraryDirectory,
        targetFileName
      );

      logFolderCreationEvents("source", sourceResolution, "show");
      logFolderCreationEvents("mirror", mirrorResolution, "show");

      addEvent(`Repairing automation item to ${metadata.displayTitle}: ${currentName}`);

      if (currentSourcePath) {
        await moveFile(currentSourcePath, sourceResolution.targetPath);
      }

      if (currentMirrorPath) {
        await moveFile(currentMirrorPath, mirrorResolution.targetPath);
      } else if (!(await pathExists(mirrorResolution.targetPath))) {
        await fs.copyFile(sourceResolution.targetPath, mirrorResolution.targetPath);
      }

      if (!currentSourcePath) {
        if (!(await pathExists(mirrorResolution.targetPath))) {
          throw new Error("Could not rebuild the source library file because the mirror copy is missing");
        }

        await fs.copyFile(mirrorResolution.targetPath, sourceResolution.targetPath);
      }

      if (currentSourcePath) {
        await cleanupEmptyAncestors(path.dirname(currentSourcePath), settings.automationSourceLibraryDirectory);
      }
      if (currentMirrorPath) {
        await cleanupEmptyAncestors(path.dirname(currentMirrorPath), settings.automationMirrorLibraryDirectory);
      }

      entry.sourceLibraryPath = sourceResolution.targetPath;
      entry.mirrorLibraryPath = mirrorResolution.targetPath;
      entry.displayTitle = metadata.displayTitle;
      updatedCount += 1;

      results.push({
        entryId: entry.id,
        sourcePath: currentSourcePath ?? entry.sourceLibraryPath,
        targetSourcePath: sourceResolution.targetPath,
        mirrorPath: currentMirrorPath ?? entry.mirrorLibraryPath,
        targetMirrorPath: mirrorResolution.targetPath,
        success: true
      });
    } catch (error) {
      const errorMessage = formatError(error);
      addEvent(`Automation repair failed for ${path.basename(entry.sourceLibraryPath)}: ${errorMessage}`);
      results.push({
        entryId: entry.id,
        sourcePath: entry.sourceLibraryPath,
        mirrorPath: entry.mirrorLibraryPath,
        success: false,
        error: errorMessage
      });
    }
  }

  if (updatedCount > 0) {
    await saveAutomationHistory(history);
  }

  return {
    updatedCount,
    results
  };
}

// ------------------------------------------------------------------ library placement

async function resolveLibraryTargetPath(
  preview: Pick<RenamePreview, "metadata" | "parsed">,
  libraryRoot: string,
  fileName: string
): Promise<ResolvedLibraryTarget> {
  if (preview.parsed.kind === "movie") {
    const existed = await pathExists(libraryRoot);
    await fs.mkdir(libraryRoot, { recursive: true });
    return {
      contentDirectory: libraryRoot,
      contentCreated: !existed,
      seasonDirectory: null,
      seasonCreated: false,
      targetPath: path.join(libraryRoot, fileName)
    };
  }

  return resolveLibraryTargetPathForPlacement(preview, libraryRoot, fileName);
}

async function resolveLibraryTargetPathForPlacement(
  preview: Pick<RenamePreview, "metadata" | "parsed">,
  libraryRoot: string,
  fileName: string
): Promise<ResolvedLibraryTarget> {
  const showTitle = sanitizeDirectoryName(
    preview.metadata?.displayTitle || toDisplayTitle(preview.parsed.normalizedTitle) || "Unsorted"
  );
  const showDirectory = await findOrCreateShowDirectory(libraryRoot, showTitle);
  const seasonDirectory = await findSeasonDirectory(showDirectory.path, preview);

  return {
    contentDirectory: showDirectory.path,
    contentCreated: showDirectory.created,
    seasonDirectory: seasonDirectory?.path ?? null,
    seasonCreated: seasonDirectory?.created ?? false,
    targetPath: path.join(seasonDirectory?.path ?? showDirectory.path, fileName)
  };
}

async function findOrCreateShowDirectory(
  libraryRoot: string,
  showTitle: string
): Promise<{ path: string; created: boolean }> {
  await fs.mkdir(libraryRoot, { recursive: true });
  const entries = await fs.readdir(libraryRoot, { withFileTypes: true });
  const normalizedTitle = normalizeSeriesKey(showTitle);
  const normalizedFullTitle = normalizeMatchKey(showTitle);

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const entryKey = normalizeSeriesKey(entry.name);
    const entryFullKey = normalizeMatchKey(entry.name);

    if (normalizedFullTitle && entryFullKey === normalizedFullTitle) {
      return {
        path: path.join(libraryRoot, entry.name),
        created: false
      };
    }

    if (normalizedTitle && entryKey === normalizedTitle) {
      return {
        path: path.join(libraryRoot, entry.name),
        created: false
      };
    }
  }

  const nextDirectory = path.join(libraryRoot, showTitle);
  await fs.mkdir(nextDirectory, { recursive: true });
  return {
    path: nextDirectory,
    created: true
  };
}

async function findSeasonDirectory(
  showDirectory: string,
  preview: Pick<RenamePreview, "metadata" | "parsed">
): Promise<{ path: string; created: boolean } | null> {
  const seasonNumber = preview.metadata?.season ?? preview.parsed.season;
  if (typeof seasonNumber !== "number") {
    return null;
  }

  return findOrCreateSeasonDirectory(showDirectory, seasonNumber);
}

async function findOrCreateSeasonDirectory(
  showDirectory: string,
  seasonNumber: number
): Promise<{ path: string; created: boolean }> {
  if (!Number.isInteger(seasonNumber) || seasonNumber < 0) {
    throw new Error("Invalid season number");
  }

  const entries = await fs.readdir(showDirectory, { withFileTypes: true });
  const targetPatterns = buildSeasonPatterns(seasonNumber);

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const normalizedEntry = normalizeMatchKey(entry.name);
    if (targetPatterns.some((pattern) => normalizedEntry.includes(pattern))) {
      return {
        path: path.join(showDirectory, entry.name),
        created: false
      };
    }
  }

  const createdPath = path.join(showDirectory, `Season ${String(seasonNumber).padStart(2, "0")}`);
  await fs.mkdir(createdPath, { recursive: true });
  return {
    path: createdPath,
    created: true
  };
}

function buildSeasonPatterns(seasonNumber: number): string[] {
  const padded = String(seasonNumber).padStart(2, "0");
  const plain = String(seasonNumber);

  return [
    `season${padded}`,
    `season${plain}`,
    `series${padded}`,
    `series${plain}`,
    `s${padded}`,
    `s${plain}`
  ];
}

function shouldTrackFile(fileName: string): boolean {
  return isMediaFile(fileName);
}

function sanitizeDirectoryName(value: string): string {
  const sanitized = value
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();

  return sanitizeWindowsReservedName(sanitized || "Unsorted");
}

function normalizeMatchKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function normalizeSeriesKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b(?:19|20)\d{2}\b/g, " ")
    .replace(/[^a-z0-9]+/g, "");
}

function isPathWithinRoot(filePath: string, rootPath: string): boolean {
  const relativePath = path.relative(rootPath, filePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function isSeasonFolderName(value: string): boolean {
  return /^(season|series)\s*\d+$/i.test(value) || /^s\d+$/i.test(value);
}




async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

function buildRenameOptions(currentSettings: AppSettings, sourceId: RenameOptions["sourceId"]): RenameOptions {
  return {
    sourceId,
    tmdbToken: currentSettings.tmdbBearerToken || undefined,
    tvdbApiKey: currentSettings.tvdbApiKey || undefined,
    tvdbPin: currentSettings.tvdbPin || undefined,
    language: currentSettings.defaultLanguage
  };
}

function hasConfiguredAutomationTargets(currentSettings: AppSettings): boolean {
  return hasEpisodeTargets(currentSettings) || hasMovieTargets(currentSettings);
}

function hasEpisodeTargets(currentSettings: AppSettings): boolean {
  return Boolean(
    currentSettings.automationSourceLibraryDirectory && currentSettings.automationMirrorLibraryDirectory
  );
}

function hasMovieTargets(currentSettings: AppSettings): boolean {
  return Boolean(
    currentSettings.automationMovieSourceDirectory && currentSettings.automationMovieMirrorDirectory
  );
}

function resolveAutomationTargets(
  mediaKind: MediaKind,
  currentSettings: AppSettings
): { sourceRoot: string; mirrorRoot: string; libraryLabel: "show" | "movie" } {
  if (mediaKind === "episode") {
    if (!hasEpisodeTargets(currentSettings)) {
      throw new Error("Configure both TV automation library roots before processing episodes");
    }

    return {
      sourceRoot: currentSettings.automationSourceLibraryDirectory,
      mirrorRoot: currentSettings.automationMirrorLibraryDirectory,
      libraryLabel: "show"
    };
  }

  if (mediaKind === "movie") {
    if (!hasMovieTargets(currentSettings)) {
      throw new Error("Configure both movie automation library roots before processing movies");
    }

    return {
      sourceRoot: currentSettings.automationMovieSourceDirectory,
      mirrorRoot: currentSettings.automationMovieMirrorDirectory,
      libraryLabel: "movie"
    };
  }

  throw new Error("Automation supports TV episodes and movies only");
}

function buildEpisodeTargetName(
  currentName: string,
  parsed: ReturnType<typeof parseMediaName>,
  metadata: ResolvedMetadata
): string {
  const extension = path.extname(currentName);
  const displayTitle = sanitizeDirectoryName(metadata.displayTitle || toDisplayTitle(parsed.normalizedTitle) || "Untitled");
  const season = metadata.season ?? parsed.season;
  const episode = metadata.episode ?? parsed.episode;
  const episodeCode =
    typeof season === "number" && typeof episode === "number"
      ? `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`
      : typeof parsed.absoluteEpisode === "number"
        ? `E${String(parsed.absoluteEpisode).padStart(3, "0")}`
        : "Episode";
  const episodeTitle = sanitizeDirectoryName(metadata.episodeTitle || "");
  const suffix = episodeTitle ? ` - ${episodeTitle}` : "";
  return `${displayTitle} - ${episodeCode}${suffix}${extension}`;
}

async function resolveExistingAutomationPath(...candidatePaths: string[]): Promise<string | null> {
  for (const candidatePath of candidatePaths) {
    if (candidatePath && (await pathExists(candidatePath))) {
      return candidatePath;
    }
  }

  return null;
}

async function cleanupEmptyAncestors(startDirectory: string, libraryRoot: string): Promise<void> {
  let currentDirectory = path.resolve(startDirectory);
  const normalizedRoot = path.resolve(libraryRoot);

  while (isPathWithinRoot(currentDirectory, normalizedRoot) && currentDirectory !== normalizedRoot) {
    try {
      await fs.rmdir(currentDirectory);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOTEMPTY" || code === "ENOENT") {
        break;
      }

      throw error;
    }

    currentDirectory = path.dirname(currentDirectory);
  }
}

function logFolderCreationEvents(
  libraryLabel: "mirror" | "source",
  resolution: ResolvedLibraryTarget,
  contentLabel: "show" | "movie"
): void {
  if (resolution.contentCreated) {
    addEvent(`Created ${libraryLabel} ${contentLabel} folder: ${resolution.contentDirectory}`);
  }

  if (resolution.seasonCreated && resolution.seasonDirectory) {
    addEvent(`Created ${libraryLabel} season folder: ${resolution.seasonDirectory}`);
  }
}

// Internal representation of where a file should land inside a library root.
type ResolvedLibraryTarget = {
  contentDirectory: string;
  contentCreated: boolean;
  seasonDirectory: string | null;
  seasonCreated: boolean;
  targetPath: string;
};

async function resolveSelectedShowPath(selectedFolderPath: string): Promise<string> {
  const folderName = path.basename(selectedFolderPath);

  if (!isSeasonFolderName(folderName)) {
    return selectedFolderPath;
  }

  return path.dirname(selectedFolderPath);
}

async function resolveShowPathForLibrary(
  libraryRoot: string,
  showName: string,
  selectedFolderPath: string
): Promise<string> {
  const normalizedRoot = path.resolve(libraryRoot);
  const normalizedSelected = path.resolve(selectedFolderPath);

  if (!isPathWithinRoot(normalizedSelected, normalizedRoot)) {
    return (await findOrCreateShowDirectory(libraryRoot, showName)).path;
  }

  const selectedShowPath = await resolveSelectedShowPath(normalizedSelected);
  if (isPathWithinRoot(path.resolve(selectedShowPath), normalizedRoot)) {
    return selectedShowPath;
  }

  return (await findOrCreateShowDirectory(libraryRoot, showName)).path;
}

async function repairShowLocation(
  rootLabel: "source" | "mirror",
  showPath: string
): Promise<RepairShowLocationResult> {
  await fs.mkdir(showPath, { recursive: true });
  const entries = await fs.readdir(showPath, { withFileTypes: true });
  const createdSeasonFolders = new Set<string>();
  const errors: string[] = [];
  let movedCount = 0;
  let skippedCount = 0;

  for (const entry of entries) {
    if (!entry.isFile() || !shouldTrackFile(entry.name)) {
      continue;
    }

    const filePath = path.join(showPath, entry.name);
    const parsed = parseMediaName(entry.name);
    if (parsed.kind !== "episode" || typeof parsed.season !== "number") {
      skippedCount += 1;
      continue;
    }

    try {
      const seasonDirectory = await findOrCreateSeasonDirectory(showPath, parsed.season);
      if (seasonDirectory.created) {
        createdSeasonFolders.add(seasonDirectory.path);
        addEvent(`Created ${rootLabel} season folder during repair: ${seasonDirectory.path}`);
      }

      const targetPath = path.join(seasonDirectory.path, entry.name);
      if (path.resolve(targetPath) === path.resolve(filePath)) {
        skippedCount += 1;
        continue;
      }

      addEvent(`Repairing ${rootLabel} placement: ${filePath} -> ${targetPath}`);
      await moveFile(filePath, targetPath);
      movedCount += 1;
    } catch (error) {
      errors.push(`${entry.name}: ${formatError(error)}`);
      addEvent(`Repair failed in ${rootLabel} library for ${entry.name}: ${formatError(error)}`);
    }
  }

  return {
    rootLabel,
    showPath,
    movedCount,
    createdSeasonFolders: Array.from(createdSeasonFolders),
    skippedCount,
    errors
  };
}
