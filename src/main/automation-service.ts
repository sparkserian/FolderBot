import { promises as fs } from "node:fs";
import path from "node:path";
import { app } from "electron";
import { parseMediaName, toDisplayTitle } from "../shared/filename-parser";
import type {
  AppSettings,
  AutomationEvent,
  RepairShowLocationResult,
  RepairShowResult,
  AutomationStatus,
  RenamePreview
} from "../shared/types";
import { recordAutomationHistoryEntry } from "./automation-history-store";
import { moveFile, sanitizeWindowsReservedName } from "./file-ops";
import { applyRenames, previewRenames } from "./rename-service";

const MEDIA_EXTENSIONS = new Set([".mkv", ".mp4", ".avi", ".mov", ".m4v", ".wmv", ".srt", ".ass", ".mpg", ".mpeg"]);
const TEMP_EXTENSIONS = new Set([".part", ".crdownload", ".tmp", ".partial", ".download"]);
const SCAN_INTERVAL_MS = 5_000;
const MIN_STABLE_PASSES = 2;
const MAX_EVENTS = 16;

type CandidateEntry = {
  path: string;
  size: number;
  mtimeMs: number;
  stableSince: number;
  stablePasses: number;
  processing: boolean;
  lastAttemptSignature?: string;
};

let settings: AppSettings | null = null;
let statusListener: ((status: AutomationStatus) => void) | null = null;
let scanTimer: NodeJS.Timeout | null = null;
let scanInFlight = false;
let processingCount = 0;
const candidates = new Map<string, CandidateEntry>();
const recentEvents: AutomationEvent[] = [];
let logWriteQueue = Promise.resolve();

export function initializeAutomationService(
  nextSettings: AppSettings,
  listener: (status: AutomationStatus) => void
): void {
  statusListener = listener;
  settings = nextSettings;
  restartWatcher();
}

export function updateAutomationSettings(nextSettings: AppSettings): void {
  settings = nextSettings;
  restartWatcher();
}

export function getAutomationStatus(): AutomationStatus {
  const currentSettings = settings;

  return {
    enabled: currentSettings?.automationEnabled ?? false,
    watching: isWatcherActive(),
    processing: processingCount > 0,
    inboxDirectory: currentSettings?.automationInboxDirectory ?? "",
    sourceLibraryDirectory: currentSettings?.automationSourceLibraryDirectory ?? "",
    mirrorLibraryDirectory: currentSettings?.automationMirrorLibraryDirectory ?? "",
    sourceId: currentSettings?.automationSourceId ?? "tvdb",
    settleSeconds: currentSettings?.automationSettleSeconds ?? 45,
    pendingCount: Array.from(candidates.values()).filter((entry) => !entry.processing).length,
    recentEvents: [...recentEvents]
  };
}

export async function repairSeasonPlacement(selectedFolderPath: string): Promise<RepairShowResult> {
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

function restartWatcher(): void {
  stopWatcher();
  candidates.clear();

  if (!isConfigured()) {
    emitStatus();
    return;
  }

  scanTimer = setInterval(() => {
    void scanInboxDirectory();
  }, SCAN_INTERVAL_MS);

  void resetAutomationLog();
  void scanInboxDirectory();
  addEvent("Automation watcher started.");
}

function stopWatcher(): void {
  if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
  }
}

function isConfigured(): boolean {
  return Boolean(
    settings?.automationEnabled &&
      settings.automationInboxDirectory &&
      settings.automationSourceLibraryDirectory &&
      settings.automationMirrorLibraryDirectory
  );
}

function isWatcherActive(): boolean {
  return Boolean(scanTimer) && isConfigured();
}

async function scanInboxDirectory(): Promise<void> {
  if (!settings || !isConfigured() || scanInFlight) {
    return;
  }

  scanInFlight = true;

  try {
    const entries = await fs.readdir(settings.automationInboxDirectory, { withFileTypes: true });
    const now = Date.now();
    const seenPaths = new Set<string>();
    const readyCandidates: CandidateEntry[] = [];

    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }

      const filePath = path.join(settings.automationInboxDirectory, entry.name);
      if (!shouldTrackFile(entry.name)) {
        continue;
      }

      seenPaths.add(filePath);

      const stats = await safeStat(filePath);
      if (!stats) {
        candidates.delete(filePath);
        continue;
      }

      const candidate = candidates.get(filePath);

      if (!candidate) {
        candidates.set(filePath, {
          path: filePath,
          size: stats.size,
          mtimeMs: stats.mtimeMs,
          stableSince: now,
          stablePasses: 0,
          processing: false
        });
        continue;
      }

      if (candidate.processing) {
        continue;
      }

      if (candidate.size !== stats.size || candidate.mtimeMs !== stats.mtimeMs) {
        candidate.size = stats.size;
        candidate.mtimeMs = stats.mtimeMs;
        candidate.stableSince = now;
        candidate.stablePasses = 0;
        candidate.lastAttemptSignature = undefined;
        continue;
      }

      candidate.stablePasses += 1;

      if (
        candidate.stablePasses >= MIN_STABLE_PASSES &&
        now - candidate.stableSince >= settings.automationSettleSeconds * 1000 &&
        candidate.lastAttemptSignature !== buildSignature(stats.size, stats.mtimeMs)
      ) {
        readyCandidates.push(candidate);
      }
    }

    for (const candidatePath of [...candidates.keys()]) {
      if (!seenPaths.has(candidatePath)) {
        candidates.delete(candidatePath);
      }
    }

    emitStatus();

    for (const candidate of readyCandidates) {
      await processSettledFile(candidate);
    }
  } catch (error) {
    addEvent(`Automation scan failed: ${formatError(error)}`);
  } finally {
    scanInFlight = false;
    emitStatus();
  }
}

async function processSettledFile(candidate: CandidateEntry): Promise<void> {
  if (!settings) {
    return;
  }

  const currentCandidate = candidates.get(candidate.path);
  if (!currentCandidate || currentCandidate.processing) {
    return;
  }

  const currentStats = await safeStat(candidate.path);
  if (!currentStats) {
    candidates.delete(candidate.path);
    emitStatus();
    return;
  }

  const attemptSignature = buildSignature(currentStats.size, currentStats.mtimeMs);
  if (!(await canOpenForRead(candidate.path))) {
    currentCandidate.lastAttemptSignature = undefined;
    return;
  }

  currentCandidate.processing = true;
  currentCandidate.lastAttemptSignature = attemptSignature;
  processingCount += 1;
  emitStatus();

  try {
    addEvent(`Detected settled file: ${path.basename(candidate.path)}`);

    const preview = await buildRenamePreview(candidate.path, settings);
    const renamedPath = await renameInInbox(preview, settings);
    addEvent(`Renamed in inbox: ${path.basename(renamedPath)}`);

    const mirrorTargetPath = await copyToLibraryRoot(renamedPath, preview, settings.automationMirrorLibraryDirectory);
    addEvent(`Copied to mirror library: ${mirrorTargetPath}`);

    const sourceTargetPath = await moveToLibraryRoot(renamedPath, preview, settings.automationSourceLibraryDirectory);
    addEvent(`Moved to source library: ${sourceTargetPath}`);

    await recordAutomationHistoryEntry({
      sourceId: settings.automationSourceId,
      originalInboxPath: candidate.path,
      sourceLibraryPath: sourceTargetPath,
      mirrorLibraryPath: mirrorTargetPath,
      displayTitle: preview.metadata?.displayTitle || toDisplayTitle(preview.parsed.normalizedTitle)
    });

    candidates.delete(candidate.path);
  } catch (error) {
    addEvent(`Automation failed for ${path.basename(candidate.path)}: ${formatError(error)}`);
  } finally {
    currentCandidate.processing = false;
    processingCount = Math.max(0, processingCount - 1);
    emitStatus();
  }
}

async function buildRenamePreview(filePath: string, currentSettings: AppSettings): Promise<RenamePreview> {
  const previews = await previewRenames({
    filePaths: [filePath],
    options: {
      sourceId: currentSettings.automationSourceId,
      tmdbToken: currentSettings.tmdbBearerToken || undefined,
      tvdbApiKey: currentSettings.tvdbApiKey || undefined,
      tvdbPin: currentSettings.tvdbPin || undefined,
      language: currentSettings.defaultLanguage
    }
  });

  const preview = previews[0];
  if (!preview) {
    throw new Error("No preview result was generated");
  }

  if (preview.parsed.kind !== "episode") {
    throw new Error("Automation currently supports TV episodes only");
  }

  if (preview.conflicts.length > 0) {
    throw new Error(preview.conflicts[0]);
  }

  return preview;
}

async function renameInInbox(preview: RenamePreview, currentSettings: AppSettings): Promise<string> {
  const results = await applyRenames({
    items: [preview],
    sourceId: currentSettings.automationSourceId
  });
  const result = results[0];

  if (!result?.success) {
    throw new Error(result?.error || "Rename failed");
  }

  return result.targetPath;
}

async function copyToLibraryRoot(
  sourcePath: string,
  preview: RenamePreview,
  libraryRoot: string
): Promise<string> {
  const resolution = await resolveLibraryTargetPath(preview, libraryRoot, path.basename(sourcePath));
  logFolderCreationEvents("mirror", resolution);

  if (await pathExists(resolution.targetPath)) {
    addEvent(`Mirror file already exists, skipping copy: ${resolution.targetPath}`);
    return resolution.targetPath;
  }

  addEvent(`Copying to mirror library: ${resolution.targetPath}`);
  await fs.copyFile(sourcePath, resolution.targetPath);
  return resolution.targetPath;
}

async function moveToLibraryRoot(
  sourcePath: string,
  preview: RenamePreview,
  libraryRoot: string
): Promise<string> {
  const resolution = await resolveLibraryTargetPath(preview, libraryRoot, path.basename(sourcePath));
  logFolderCreationEvents("source", resolution);
  addEvent(`Moving into source library: ${resolution.targetPath}`);
  await moveFile(sourcePath, resolution.targetPath);
  return resolution.targetPath;
}

async function resolveLibraryTargetPath(
  preview: RenamePreview,
  libraryRoot: string,
  fileName: string
): Promise<ResolvedLibraryTarget> {
  const showTitle = sanitizeDirectoryName(
    preview.metadata?.displayTitle || toDisplayTitle(preview.parsed.normalizedTitle) || "Unsorted"
  );
  const showDirectory = await findOrCreateShowDirectory(libraryRoot, showTitle);
  const seasonDirectory = await findSeasonDirectory(showDirectory.path, preview);

  return {
    showDirectory: showDirectory.path,
    showCreated: showDirectory.created,
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
  preview: RenamePreview
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
  const extension = path.extname(fileName).toLowerCase();
  return MEDIA_EXTENSIONS.has(extension) && !TEMP_EXTENSIONS.has(extension);
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

async function safeStat(filePath: string): Promise<{ size: number; mtimeMs: number } | null> {
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

async function canOpenForRead(filePath: string): Promise<boolean> {
  try {
    const handle = await fs.open(filePath, "r");
    await handle.close();
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES" || code === "EBUSY") {
      return false;
    }

    throw error;
  }
}

function buildSignature(size: number, mtimeMs: number): string {
  return `${size}:${mtimeMs}`;
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

function addEvent(message: string): void {
  recentEvents.unshift({
    createdAt: new Date().toISOString(),
    message
  });
  recentEvents.splice(MAX_EVENTS);
  queueLogWrite(message);
  emitStatus();
}

function emitStatus(): void {
  statusListener?.(getAutomationStatus());
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown error";
}

function logFolderCreationEvents(
  libraryLabel: "mirror" | "source",
  resolution: ResolvedLibraryTarget
): void {
  if (resolution.showCreated) {
    addEvent(`Created ${libraryLabel} show folder: ${resolution.showDirectory}`);
  }

  if (resolution.seasonCreated && resolution.seasonDirectory) {
    addEvent(`Created ${libraryLabel} season folder: ${resolution.seasonDirectory}`);
  }
}

function queueLogWrite(message: string): void {
  const timestamp = new Date().toISOString();
  logWriteQueue = logWriteQueue
    .catch(() => undefined)
    .then(async () => {
      const logPath = getAutomationLogPath();
      await fs.mkdir(path.dirname(logPath), { recursive: true });
      await fs.appendFile(logPath, `[${timestamp}] ${message}\n`, "utf8");
    });
}

async function resetAutomationLog(): Promise<void> {
  const logPath = getAutomationLogPath();
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.appendFile(logPath, `\n[${new Date().toISOString()}] ---- watcher restarted ----\n`, "utf8");
}

function getAutomationLogPath(): string {
  return path.join(app.getPath("userData"), "automation.log");
}

type ResolvedLibraryTarget = {
  showDirectory: string;
  showCreated: boolean;
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
