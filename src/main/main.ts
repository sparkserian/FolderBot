// Electron main process: the window, tray, notifications, updates, native dialogs and IPC.
import {
  app,
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  shell,
  systemPreferences
} from "electron";
import path from "node:path";
import {
  clearFinishedAutomationJobs,
  formatBytes,
  getAutomationLogPath,
  getAutomationStatus,
  initializeAutomationService,
  repairAutomationHistoryEntries,
  repairSeasonPlacement,
  retryAutomationJob,
  skipAutomationJob,
  suppressAutomationInboxFile,
  updateAutomationSettings
} from "./automation-service";
import { getAutomationHistory, undoAutomationHistoryEntry } from "./automation-history-store";
import { getRenameHistory, recordRenameHistoryBatch, undoRenameHistoryEntry } from "./history-store";
import { searchSeriesMatches } from "./providers";
import { applyRenames, getProviderStatuses, previewRenames } from "./rename-service";
import { getSettings, saveSettings } from "./settings-store";
import { APP_ICON_256, TRAY_ICON_COLOR, TRAY_ICON_TEMPLATE } from "./tray-icon";
import { checkForUpdates, getUpdateState, installUpdateNow, startUpdater } from "./updater";
import type {
  AppInfo,
  AppSettings,
  ApplyRenameRequest,
  AutomationJob,
  AutomationRepairRequest,
  AutomationStatus,
  PreviewRequest,
  RenameOptions,
  SearchSeriesRequest
} from "../shared/types";

const APP_ID = "com.folderbot.app";
const LOGIN_BACKGROUND_ARG = "--background";
const TITLE_BAR_HEIGHT = 48;
const NOTIFY_BATCH_MS = 6_000;
const MEDIA_EXTENSIONS = ["mkv", "mp4", "avi", "mov", "m4v", "wmv", "srt", "ass", "mpg", "mpeg"];

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let currentSettings: AppSettings | null = null;
let lastStatus: AutomationStatus | null = null;
let toldAboutTray = false;
let filedBatch: AutomationJob[] = [];
let filedBatchTimer: NodeJS.Timeout | null = null;

const launchedInBackground = process.argv.includes(LOGIN_BACKGROUND_ARG);

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// Windows shows notifications and groups taskbar windows under this ID; it must match the
// installer's appId.
app.setAppUserModelId(APP_ID);

// ------------------------------------------------------------------ window

function themeColors() {
  const dark = nativeTheme.shouldUseDarkColors;
  return dark
    ? { background: "#202020", overlay: "#00000000", symbols: "#FFFFFF" }
    : { background: "#F3F3F3", overlay: "#00000000", symbols: "#1A1A1A" };
}

function createMainWindow(showWindow = true): void {
  const colors = themeColors();

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 620,
    title: "FolderBot",
    backgroundColor: process.platform === "win32" ? "#00000000" : colors.background,
    // Windows 11 draws its Mica material behind the window; older Windows falls back to the
    // background colour.
    ...(process.platform === "win32" ? { backgroundMaterial: "mica" as const } : {}),
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    ...(process.platform === "darwin"
      ? {}
      : {
          titleBarOverlay: { color: colors.overlay, symbolColor: colors.symbols, height: TITLE_BAR_HEIGHT },
          icon: createAppIconImage()
        }),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.once("ready-to-show", () => {
    if (showWindow) {
      mainWindow?.show();
    }
  });

  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl) {
    void mainWindow.loadURL(rendererUrl);
  } else {
    void mainWindow.loadFile(path.join(__dirname, "..", "..", "dist", "renderer", "index.html"));
  }

  // Links open in the browser, never inside the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  mainWindow.on("close", (event) => {
    if (!isQuitting && keepsRunningInTray()) {
      event.preventDefault();
      mainWindow?.hide();
      ensureTray();

      if (!toldAboutTray) {
        toldAboutTray = true;
        showNotification(
          "FolderBot is still running",
          "It keeps watching your inbox from the tray. Right-click the tray icon to quit."
        );
      }
    }
  });

  // Windows raises this on shutdown, restart, or log off. Without it the tray-resident window
  // keeps refusing to close and holds up the whole session.
  mainWindow.on("session-end", () => {
    isQuitting = true;
    app.exit(0);
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// The window closes to the tray whenever something should keep running in the background.
function keepsRunningInTray(): boolean {
  return Boolean(currentSettings?.launchAtLogin || currentSettings?.automationEnabled);
}

function showMainWindow(route?: string): void {
  if (!mainWindow) {
    createMainWindow(true);
  }

  if (!mainWindow) {
    return;
  }

  if (!mainWindow.isVisible()) {
    mainWindow.show();
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.focus();

  if (route) {
    sendToWindow("app:navigate", route);
  }
}

function sendToWindow(channel: string, payload?: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

nativeTheme.on("updated", () => {
  const colors = themeColors();
  if (mainWindow && process.platform !== "darwin") {
    mainWindow.setTitleBarOverlay({ color: colors.overlay, symbolColor: colors.symbols, height: TITLE_BAR_HEIGHT });
  }
});

// ------------------------------------------------------------------ menu

function createApplicationMenu(): void {
  if (process.platform !== "darwin") {
    // Windows and Linux draw the window's own title bar, so a native menu strip would sit on
    // top of it.
    Menu.setApplicationMenu(null);
    return;
  }

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: "about" },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" }
        ]
      },
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" }
        ]
      },
      { label: "View", submenu: [{ role: "reload" }, { role: "toggleDevTools" }] },
      { label: "Window", submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "close" }] }
    ])
  );
}

// ------------------------------------------------------------------ tray

function ensureTray(): void {
  if (tray) {
    refreshTray();
    return;
  }

  tray = new Tray(createTrayImage());
  tray.on("click", () => showMainWindow());
  refreshTray();
}

function refreshTray(): void {
  if (!tray) {
    return;
  }

  const summary = describeStatus(lastStatus);
  tray.setToolTip(`FolderBot · ${summary}`.slice(0, 127));
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: summary, enabled: false },
      { type: "separator" },
      { label: "Open FolderBot", click: () => showMainWindow("activity") },
      {
        label: currentSettings?.automationEnabled ? "Pause watching" : "Resume watching",
        click: () => void setAutomationEnabled(!currentSettings?.automationEnabled)
      },
      {
        label: "Open inbox folder",
        enabled: Boolean(currentSettings?.automationInboxDirectory),
        click: () => void shell.openPath(currentSettings?.automationInboxDirectory ?? "")
      },
      { type: "separator" },
      {
        label: "Quit FolderBot",
        click: () => {
          isQuitting = true;
          app.quit();
        }
      }
    ])
  );
}

function describeStatus(status: AutomationStatus | null): string {
  if (!status || !status.enabled) {
    return "Watcher paused";
  }

  const active = status.jobs.find((job) => job.stage === "copying" || job.stage === "moving" || job.stage === "matching");
  if (active) {
    const progress = active.progress;
    const percent = progress && progress.bytesTotal > 0 ? ` ${Math.floor((progress.bytesDone / progress.bytesTotal) * 100)}%` : "";
    return `Filing ${active.title || active.fileName}${percent}`;
  }

  if (status.problems.length > 0) {
    return status.problems[0].message;
  }

  const failed = status.jobs.filter((job) => job.stage === "failed").length;
  if (failed > 0) {
    return `${failed} file${failed === 1 ? "" : "s"} need attention`;
  }

  if (status.pendingCount > 0) {
    return `${status.pendingCount} file${status.pendingCount === 1 ? "" : "s"} waiting`;
  }

  return "Watching the inbox";
}

// Build the tray image from embedded PNGs. SVG data URLs render as an empty slot on
// Windows because nativeImage has no SVG decoder there, which is why this uses PNG.
function createTrayImage(): Electron.NativeImage {
  const artwork = process.platform === "darwin" ? TRAY_ICON_TEMPLATE : TRAY_ICON_COLOR;
  const image = nativeImage.createFromBuffer(Buffer.from(artwork[16], "base64"), {
    width: 16,
    height: 16,
    scaleFactor: 1
  });

  for (const [size, scaleFactor] of [
    [24, 1.5],
    [32, 2]
  ] as const) {
    image.addRepresentation({ scaleFactor, width: size, height: size, buffer: Buffer.from(artwork[size], "base64") });
  }

  if (process.platform === "darwin") {
    image.setTemplateImage(true);
  }

  return image;
}

function createAppIconImage(): Electron.NativeImage {
  return nativeImage.createFromBuffer(Buffer.from(APP_ICON_256, "base64"), { width: 256, height: 256, scaleFactor: 1 });
}

// ------------------------------------------------------------------ notifications

function showNotification(title: string, body: string, route = "activity"): void {
  if (!Notification.isSupported()) {
    return;
  }

  const notification = new Notification({ title, body, icon: createAppIconImage(), silent: false });
  notification.on("click", () => showMainWindow(route));
  notification.show();
}

// Filed files are announced in one notification per burst, so a season does not produce
// twenty pop-ups. Failures are announced one by one.
function announceFinishedJob(job: AutomationJob): void {
  const windowFocused = Boolean(mainWindow?.isVisible() && mainWindow.isFocused());

  if (job.stage === "failed") {
    if (currentSettings?.notifyOnFailure && !windowFocused) {
      showNotification(`Could not file ${job.fileName}`, job.error?.message ?? job.detail);
    }
    return;
  }

  if (job.stage !== "filed" || !currentSettings?.notifyOnFiled || windowFocused) {
    return;
  }

  filedBatch.push(job);
  if (filedBatchTimer) {
    return;
  }

  filedBatchTimer = setTimeout(() => {
    const batch = filedBatch;
    filedBatch = [];
    filedBatchTimer = null;

    if (batch.length === 1) {
      showNotification(`Filed ${batch[0].title || batch[0].fileName}`, `${batch[0].targetName ?? batch[0].fileName} · ${formatBytes(batch[0].size)}`);
    } else {
      const names = batch.slice(0, 3).map((item) => item.targetName ?? item.fileName);
      showNotification(`Filed ${batch.length} files`, `${names.join("\n")}${batch.length > 3 ? `\nand ${batch.length - 3} more` : ""}`);
    }
  }, NOTIFY_BATCH_MS);
}

// ------------------------------------------------------------------ settings helpers

async function applySettings(saved: AppSettings): Promise<void> {
  currentSettings = saved;
  configureLaunchAtLogin(saved);
  updateAutomationSettings(saved);

  if (keepsRunningInTray()) {
    ensureTray();
  } else if (tray && mainWindow?.isVisible()) {
    tray.destroy();
    tray = null;
  }

  refreshTray();
}

async function setAutomationEnabled(enabled: boolean): Promise<AppSettings> {
  const saved = await saveSettings({ automationEnabled: enabled });
  await applySettings(saved);
  sendToWindow("settings:changed", saved);
  return saved;
}

function configureLaunchAtLogin(settings: AppSettings): void {
  if (!app.isPackaged) {
    return;
  }

  app.setLoginItemSettings({
    openAtLogin: settings.launchAtLogin,
    openAsHidden: settings.launchAtLogin,
    path: process.execPath,
    args: [LOGIN_BACKGROUND_ARG]
  });
}

// ------------------------------------------------------------------ startup

app.whenReady().then(async () => {
  createApplicationMenu();
  currentSettings = await getSettings();
  configureLaunchAtLogin(currentSettings);
  createMainWindow(!launchedInBackground);

  if (launchedInBackground || keepsRunningInTray()) {
    ensureTray();
  }

  initializeAutomationService(currentSettings, {
    onStatus: (status) => {
      lastStatus = status;
      // The watcher keeps running while the window is closed to the tray, so the target can be
      // gone by the time a status arrives.
      sendToWindow("automation:status", status);
      refreshTray();
    },
    onJobFinished: announceFinishedJob
  });

  startUpdater((state) => sendToWindow("update:state", state));

  app.on("activate", () => showMainWindow());
});

app.on("second-instance", () => showMainWindow());

app.on("before-quit", () => {
  isQuitting = true;
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && !keepsRunningInTray()) {
    app.quit();
  }
});

// ------------------------------------------------------------------ IPC

ipcMain.handle("dialog:pick-files", async () => {
  const options = {
    properties: ["openFile", "multiSelections"],
    filters: [
      { name: "Videos and subtitles", extensions: MEDIA_EXTENSIONS },
      { name: "All files", extensions: ["*"] }
    ]
  } satisfies Electron.OpenDialogOptions;
  const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
  return result.canceled ? [] : result.filePaths;
});

ipcMain.handle("dialog:pick-output-directory", async () => {
  const options = { properties: ["openDirectory", "createDirectory"] } satisfies Electron.OpenDialogOptions;
  const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("dialog:pick-output-directories", async () => {
  const options = {
    buttonLabel: "Select folders",
    properties: ["openDirectory", "multiSelections"]
  } satisfies Electron.OpenDialogOptions;
  const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
  return result.canceled ? [] : result.filePaths;
});

ipcMain.handle("media:get-provider-statuses", async (_event, options: RenameOptions) => getProviderStatuses(options));

ipcMain.handle("settings:get", async () => getSettings());

ipcMain.handle("settings:save", async (_event, payload: Partial<AppSettings>) => {
  const saved = await saveSettings(payload);
  await applySettings(saved);
  return saved;
});

ipcMain.handle("automation:get-status", async () => getAutomationStatus());
ipcMain.handle("automation:set-enabled", async (_event, enabled: boolean) => setAutomationEnabled(enabled));
ipcMain.handle("automation:retry", async (_event, jobId: string) => retryAutomationJob(jobId));
ipcMain.handle("automation:skip", async (_event, jobId: string) => skipAutomationJob(jobId));
ipcMain.handle("automation:clear-finished", async () => clearFinishedAutomationJobs());
ipcMain.handle("automation:repair-show", async (_event, selectedFolderPaths: string[]) => repairSeasonPlacement(selectedFolderPaths));

ipcMain.handle("automation:search-series", async (_event, payload: Pick<SearchSeriesRequest, "sourceId" | "query">) => {
  const settings = await getSettings();
  return searchSeriesMatches({
    sourceId: payload.sourceId,
    query: payload.query,
    language: settings.defaultLanguage,
    tmdbToken: settings.tmdbBearerToken || undefined,
    tvdbApiKey: settings.tvdbApiKey || undefined,
    tvdbPin: settings.tvdbPin || undefined
  });
});

ipcMain.handle("automation:repair-history", async (_event, payload: AutomationRepairRequest) => repairAutomationHistoryEntries(payload));
ipcMain.handle("automation-history:list", async () => getAutomationHistory());

ipcMain.handle("automation-history:undo", async (_event, entryId: string) => {
  const result = await undoAutomationHistoryEntry(entryId);
  // A restored file lands back in the watched inbox, so hold it until the user changes it again.
  for (const action of result.results) {
    if (action.kind === "move-back" && action.success && action.targetPath) {
      await suppressAutomationInboxFile(action.targetPath);
    }
  }
  return result;
});

ipcMain.handle("history:list", async () => getRenameHistory());
ipcMain.handle("history:undo", async (_event, payload: { entryId: string; itemIds?: string[] }) => undoRenameHistoryEntry(payload));
ipcMain.handle("media:preview-renames", async (_event, payload: PreviewRequest) => previewRenames(payload));

ipcMain.handle("media:apply-renames", async (_event, payload: ApplyRenameRequest) => {
  const results = await applyRenames(payload);
  await recordRenameHistoryBatch({ sourceId: payload.sourceId ?? "local", results });
  return results;
});

// Reveal a file in Explorer, or open a folder. Only absolute paths are accepted.
ipcMain.handle("shell:show-item", async (_event, targetPath: string) => {
  if (typeof targetPath !== "string" || !path.isAbsolute(targetPath)) {
    return;
  }
  shell.showItemInFolder(targetPath);
});

ipcMain.handle("shell:open-folder", async (_event, targetPath: string) => {
  if (typeof targetPath !== "string" || !path.isAbsolute(targetPath)) {
    return "";
  }
  return shell.openPath(targetPath);
});

ipcMain.handle("shell:open-log", async () => shell.openPath(getAutomationLogPath()));

ipcMain.handle("shell:open-external", async (_event, url: string) => {
  if (typeof url === "string" && /^https:\/\//i.test(url)) {
    await shell.openExternal(url);
  }
});

ipcMain.handle("app:info", async (): Promise<AppInfo> => ({
  version: app.getVersion(),
  platform: process.platform,
  userDataPath: app.getPath("userData"),
  logPath: getAutomationLogPath(),
  packaged: app.isPackaged,
  accentColor: readAccentColor()
}));

function readAccentColor(): string | undefined {
  try {
    const value = systemPreferences.getAccentColor?.();
    return value ? `#${value.slice(0, 6)}` : undefined;
  } catch {
    return undefined;
  }
}

systemPreferences.on?.("accent-color-changed", () => sendToWindow("app:accent", readAccentColor()));

ipcMain.handle("update:get-state", async () => getUpdateState());
ipcMain.handle("update:check", async () => checkForUpdates());
ipcMain.handle("update:install", async () => {
  isQuitting = true;
  installUpdateNow();
});
