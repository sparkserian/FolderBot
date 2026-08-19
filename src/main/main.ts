// Electron main-process bootstrap: window creation, menus, native dialogs, and IPC handlers.
import { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage } from "electron";
import path from "node:path";
import {
  getAutomationStatus,
  initializeAutomationService,
  repairAutomationHistoryEntries,
  repairSeasonPlacement,
  suppressAutomationInboxFile,
  updateAutomationSettings
} from "./automation-service";
import { getAutomationHistory, undoAutomationHistoryEntry } from "./automation-history-store";
import { getRenameHistory, recordRenameHistoryBatch, undoRenameHistoryEntry } from "./history-store";
import { searchSeriesMatches } from "./providers";
import { applyRenames, getProviderStatuses, previewRenames } from "./rename-service";
import { getSettings, saveSettings } from "./settings-store";
import { APP_ICON_256, TRAY_ICON_COLOR, TRAY_ICON_TEMPLATE } from "./tray-icon";
import type {
  AppSettings,
  ApplyRenameRequest,
  AutomationRepairRequest,
  PreviewRequest,
  RenameOptions,
  SearchSeriesRequest
} from "../shared/types";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let currentSettings: AppSettings | null = null;
const LOGIN_BACKGROUND_ARG = "--background";
const TITLE_BAR_HEIGHT = 44;
const launchedInBackground = process.argv.includes(LOGIN_BACKGROUND_ARG);

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}

// Create the single application window used for the desktop UI.
function createMainWindow(showWindow = true): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 940,
    minHeight: 640,
    backgroundColor: "#0F1116",
    // macOS insets the traffic lights into the custom top bar. Windows and Linux hide the
    // native frame and overlay the system buttons instead, so the app draws its own bar
    // without a second title bar stacked above it.
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    ...(process.platform === "darwin"
      ? {}
      : {
          titleBarOverlay: {
            color: "#12141A",
            symbolColor: "#C8CDD8",
            height: TITLE_BAR_HEIGHT
          },
          icon: createAppIconImage()
        }),
    show: showWindow,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl) {
    void mainWindow.loadURL(rendererUrl);
  } else {
    void mainWindow.loadFile(path.join(__dirname, "..", "..", "dist", "renderer", "index.html"));
  }

  if (process.env.ELECTRON_RENDERER_URL && showWindow) {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }

  mainWindow.on("close", (event) => {
    if (!isQuitting && currentSettings?.launchAtLogin) {
      event.preventDefault();
      mainWindow?.hide();
      ensureTray();
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

// Build the native application menu and wire Help -> How To back into the renderer.
function createApplicationMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: "File",
      submenu: [{ role: "quit" }]
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
    {
      label: "View",
      submenu: [{ role: "reload" }, { role: "forceReload" }, { role: "toggleDevTools" }]
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "close" }]
    },
    {
      label: "Help",
      submenu: [
        {
          label: "How To",
          click: () => {
            mainWindow?.webContents.send("app:open-help");
          }
        }
      ]
    }
  ];

  if (process.platform === "darwin") {
    template.unshift({
      label: app.name,
      submenu: [{ role: "about" }, { type: "separator" }, { role: "services" }, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" }]
    });
  }

  if (process.platform !== "darwin") {
    // Windows and Linux draw the window's own title bar, so a native menu strip would sit
    // on top of it. Help lives in the app's own navigation instead.
    Menu.setApplicationMenu(null);
    return;
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Start Electron, create the main window, and initialize the automation watcher with saved settings.
app.whenReady().then(async () => {
  createApplicationMenu();
  currentSettings = await getSettings();
  configureLaunchAtLogin(currentSettings);
  createMainWindow(!launchedInBackground);
  if (launchedInBackground) {
    ensureTray();
  }

  initializeAutomationService(currentSettings, (status) => {
    mainWindow?.webContents.send("automation:status", status);
  });

  app.on("activate", () => {
    showMainWindow();
  });
});

app.on("second-instance", () => {
  showMainWindow();
});

app.on("before-quit", () => {
  isQuitting = true;
});

// Standard Electron shutdown behavior: quit on non-macOS once all windows are closed.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

// Native file picker used by the manual import flow.
ipcMain.handle("dialog:pick-files", async () => {
  const options = {
    properties: ["openFile", "multiSelections"],
    filters: [
      {
        name: "Media files",
        extensions: [
          "mkv",
          "mp4",
          "avi",
          "mov",
          "m4v",
          "wmv",
          "srt",
          "ass",
          "mpg",
          "mpeg"
        ]
      },
      { name: "All files", extensions: ["*"] }
    ]
  } satisfies Electron.OpenDialogOptions;

  const focusedWindow = mainWindow ?? BrowserWindow.getFocusedWindow();
  const result = focusedWindow ? await dialog.showOpenDialog(focusedWindow, options) : await dialog.showOpenDialog(options);

  return result.canceled ? [] : result.filePaths;
});

// Shared directory picker used by output-folder selection and automation settings.
ipcMain.handle("dialog:pick-output-directory", async () => {
  const options = {
    properties: ["openDirectory", "createDirectory"]
  } satisfies Electron.OpenDialogOptions;

  const focusedWindow = mainWindow ?? BrowserWindow.getFocusedWindow();
  const result = focusedWindow ? await dialog.showOpenDialog(focusedWindow, options) : await dialog.showOpenDialog(options);

  return result.canceled ? null : result.filePaths[0];
});

// Native multi-directory picker used by repair so several show folders can be chosen in one browse action.
ipcMain.handle("dialog:pick-output-directories", async () => {
  const options = {
    buttonLabel: "Select folders",
    properties: ["openDirectory", "multiSelections"]
  } satisfies Electron.OpenDialogOptions;

  const focusedWindow = mainWindow ?? BrowserWindow.getFocusedWindow();
  const result = focusedWindow ? await dialog.showOpenDialog(focusedWindow, options) : await dialog.showOpenDialog(options);

  return result.canceled ? [] : result.filePaths;
});

// The remaining IPC handlers expose app features to the renderer through the preload bridge.
ipcMain.handle("media:get-provider-statuses", async (_event, options: RenameOptions) => {
  return getProviderStatuses(options);
});

ipcMain.handle("settings:get", async () => {
  return getSettings();
});

ipcMain.handle("settings:save", async (_event, payload: Partial<AppSettings>) => {
  const savedSettings = await saveSettings(payload);
  currentSettings = savedSettings;
  configureLaunchAtLogin(savedSettings);
  updateAutomationSettings(savedSettings);
  return savedSettings;
});

ipcMain.handle("automation:get-status", async () => {
  return getAutomationStatus();
});

ipcMain.handle("automation:repair-show", async (_event, selectedFolderPaths: string[]) => {
  return repairSeasonPlacement(selectedFolderPaths);
});

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

ipcMain.handle("automation:repair-history", async (_event, payload: AutomationRepairRequest) => {
  return repairAutomationHistoryEntries(payload);
});

ipcMain.handle("automation-history:list", async () => {
  return getAutomationHistory();
});

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

ipcMain.handle("history:list", async () => {
  return getRenameHistory();
});

ipcMain.handle("history:undo", async (_event, payload: { entryId: string; itemIds?: string[] }) => {
  return undoRenameHistoryEntry(payload);
});

ipcMain.handle("media:preview-renames", async (_event, payload: PreviewRequest) => {
  return previewRenames(payload);
});

ipcMain.handle("media:apply-renames", async (_event, payload: ApplyRenameRequest) => {
  const results = await applyRenames(payload);
  await recordRenameHistoryBatch({
    sourceId: payload.sourceId ?? "local",
    results
  });
  return results;
});

function showMainWindow(): void {
  if (!mainWindow) {
    createMainWindow(true);
    return;
  }

  if (!mainWindow.isVisible()) {
    mainWindow.show();
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  mainWindow.focus();
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

  if (settings.launchAtLogin) {
    ensureTray();
  } else if (!mainWindow || mainWindow.isVisible()) {
    tray?.destroy();
    tray = null;
  }
}

function ensureTray(): void {
  if (tray) {
    return;
  }

  tray = new Tray(createTrayImage());
  tray.setToolTip("FolderBot");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "Open FolderBot",
        click: () => showMainWindow()
      },
      {
        label: "Quit",
        click: () => {
          isQuitting = true;
          app.quit();
        }
      }
    ])
  );

  tray.on("click", () => {
    showMainWindow();
  });
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

  // Extra representations keep the icon sharp on scaled displays.
  for (const [size, scaleFactor] of [
    [24, 1.5],
    [32, 2]
  ] as const) {
    image.addRepresentation({
      scaleFactor,
      width: size,
      height: size,
      buffer: Buffer.from(artwork[size], "base64")
    });
  }

  if (process.platform === "darwin") {
    image.setTemplateImage(true);
  }

  return image;
}

function createAppIconImage(): Electron.NativeImage {
  return nativeImage.createFromBuffer(Buffer.from(APP_ICON_256, "base64"), {
    width: 256,
    height: 256,
    scaleFactor: 1
  });
}
