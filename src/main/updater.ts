// Self-updates from the project's GitHub Releases. New versions download quietly; the app shows
// "Update ready" and installs when the user restarts, or on the next quit if they never do.
import { app } from "electron";
import { autoUpdater } from "electron-updater";
import type { UpdateState } from "../shared/types";

const FIRST_CHECK_DELAY_MS = 15_000;
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

let state: UpdateState = { kind: "idle" };
let listener: ((next: UpdateState) => void) | null = null;
let started = false;

export function startUpdater(onState: (next: UpdateState) => void): void {
  listener = onState;

  if (started) {
    return;
  }
  started = true;

  if (!app.isPackaged) {
    setState({ kind: "unsupported", reason: "Updates are checked in the installed app, not in a development build." });
    return;
  }

  if (process.platform !== "win32") {
    setState({ kind: "unsupported", reason: "Automatic updates are set up for the Windows installer." });
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.logger = null;

  autoUpdater.on("checking-for-update", () => setState({ kind: "checking" }));
  autoUpdater.on("update-available", (info) => setState({ kind: "available", version: info.version }));
  autoUpdater.on("update-not-available", () => setState({ kind: "idle", checkedAt: new Date().toISOString() }));
  autoUpdater.on("download-progress", (progress) => {
    const version = state.kind === "available" || state.kind === "downloading" ? state.version : "";
    setState({
      kind: "downloading",
      version,
      percent: Math.round(progress.percent),
      bytesPerSecond: progress.bytesPerSecond
    });
  });
  autoUpdater.on("update-downloaded", (info) => setState({ kind: "ready", version: info.version }));
  autoUpdater.on("error", (error) => {
    setState({ kind: "error", message: describeUpdateError(error), checkedAt: new Date().toISOString() });
  });

  setTimeout(() => void checkForUpdates(), FIRST_CHECK_DELAY_MS);
  setInterval(() => void checkForUpdates(), CHECK_INTERVAL_MS);
}

export function getUpdateState(): UpdateState {
  return state;
}

export async function checkForUpdates(): Promise<UpdateState> {
  if (state.kind === "unsupported" || state.kind === "downloading" || state.kind === "ready") {
    return state;
  }

  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    setState({ kind: "error", message: describeUpdateError(error), checkedAt: new Date().toISOString() });
  }

  return state;
}

// Quit and run the downloaded installer silently, then reopen FolderBot.
export function installUpdateNow(): void {
  if (state.kind !== "ready") {
    return;
  }

  setImmediate(() => autoUpdater.quitAndInstall(true, true));
}

function setState(next: UpdateState): void {
  state = next;
  listener?.(state);
}

function describeUpdateError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  if (/ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|net::/i.test(message)) {
    return "Could not reach GitHub to check for updates. FolderBot will try again later.";
  }

  if (/404|No published versions/i.test(message)) {
    return "No published release was found on GitHub yet.";
  }

  return `The update check failed: ${message.split("\n")[0]}`;
}
