// Electron main-process bootstrap: window creation, menus, native dialogs, and IPC handlers.
import { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage } from "electron";
import path from "node:path";
import {
  getAutomationStatus,
  initializeAutomationService,
  repairAutomationHistoryEntries,
  repairSeasonPlacement,
  updateAutomationSettings
} from "./automation-service";
import { getAutomationHistory, undoAutomationHistoryEntry } from "./automation-history-store";
import { getRenameHistory, recordRenameHistoryBatch, undoRenameHistoryEntry } from "./history-store";
import { searchSeriesMatches } from "./providers";
import { applyRenames, getProviderStatuses, previewRenames } from "./rename-service";
import { getSettings, saveSettings } from "./settings-store";
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
const launchedInBackground = process.argv.includes(LOGIN_BACKGROUND_ARG);

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}

// Create the single application window used for the desktop UI.
function createMainWindow(showWindow = true): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: "#202020",
    titleBarStyle: "hiddenInset",
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
  return undoAutomationHistoryEntry(entryId);
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

function createTrayImage() {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
      <rect x="1" y="4" width="14" height="10" rx="2" fill="#d9d9d9"/>
      <path d="M1 6h14" stroke="#1f1f1f" stroke-width="1"/>
      <path d="M3 2h4l1 2H3z" fill="#d9d9d9"/>
    </svg>
  `.trim();

  return nativeImage
    .createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`)
    .resize({ width: 16, height: 16 });
}
