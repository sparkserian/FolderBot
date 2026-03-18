import { app, BrowserWindow, Menu, dialog, ipcMain } from "electron";
import path from "node:path";
import {
  getAutomationStatus,
  initializeAutomationService,
  repairSeasonPlacement,
  updateAutomationSettings
} from "./automation-service";
import { getAutomationHistory, undoAutomationHistoryEntry } from "./automation-history-store";
import { getRenameHistory, recordRenameHistoryBatch, undoRenameHistoryEntry } from "./history-store";
import { applyRenames, getProviderStatuses, previewRenames } from "./rename-service";
import { getSettings, saveSettings } from "./settings-store";
import type { AppSettings, ApplyRenameRequest, PreviewRequest, RenameOptions } from "../shared/types";

let mainWindow: BrowserWindow | null = null;

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: "#202020",
    titleBarStyle: "hiddenInset",
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

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }
}

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

app.whenReady().then(async () => {
  createApplicationMenu();
  createMainWindow();
  const settings = await getSettings();
  initializeAutomationService(settings, (status) => {
    mainWindow?.webContents.send("automation:status", status);
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

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

ipcMain.handle("dialog:pick-output-directory", async () => {
  const options = {
    properties: ["openDirectory", "createDirectory"]
  } satisfies Electron.OpenDialogOptions;

  const focusedWindow = mainWindow ?? BrowserWindow.getFocusedWindow();
  const result = focusedWindow ? await dialog.showOpenDialog(focusedWindow, options) : await dialog.showOpenDialog(options);

  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("media:get-provider-statuses", async (_event, options: RenameOptions) => {
  return getProviderStatuses(options);
});

ipcMain.handle("settings:get", async () => {
  return getSettings();
});

ipcMain.handle("settings:save", async (_event, payload: Partial<AppSettings>) => {
  const savedSettings = await saveSettings(payload);
  updateAutomationSettings(savedSettings);
  return savedSettings;
});

ipcMain.handle("automation:get-status", async () => {
  return getAutomationStatus();
});

ipcMain.handle("automation:repair-show", async (_event, selectedFolderPath: string) => {
  return repairSeasonPlacement(selectedFolderPath);
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
