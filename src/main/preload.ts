// Safe, typed bridge that exposes a narrow Electron API to the renderer.
import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { FolderBotApi } from "../shared/api";

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const wrapped = (_event: Electron.IpcRendererEvent, payload: T) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.off(channel, wrapped);
}

const api: FolderBotApi = {
  // The renderer draws its own title bar, so it needs to know which platform layout to use.
  platform: process.platform,
  pickFiles: () => ipcRenderer.invoke("dialog:pick-files"),
  pickOutputDirectory: () => ipcRenderer.invoke("dialog:pick-output-directory"),
  pickOutputDirectories: () => ipcRenderer.invoke("dialog:pick-output-directories"),
  getPathForFile: (file) => webUtils.getPathForFile(file) || null,
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (payload) => ipcRenderer.invoke("settings:save", payload),
  getAutomationStatus: () => ipcRenderer.invoke("automation:get-status"),
  setAutomationEnabled: (enabled) => ipcRenderer.invoke("automation:set-enabled", enabled),
  retryAutomationJob: (jobId) => ipcRenderer.invoke("automation:retry", jobId),
  skipAutomationJob: (jobId) => ipcRenderer.invoke("automation:skip", jobId),
  clearFinishedAutomationJobs: () => ipcRenderer.invoke("automation:clear-finished"),
  repairSeasonPlacement: (paths) => ipcRenderer.invoke("automation:repair-show", paths),
  searchAutomationSeries: (payload) => ipcRenderer.invoke("automation:search-series", payload),
  repairAutomationHistoryEntries: (payload) => ipcRenderer.invoke("automation:repair-history", payload),
  getAutomationHistory: () => ipcRenderer.invoke("automation-history:list"),
  undoAutomationHistoryEntry: (entryId) => ipcRenderer.invoke("automation-history:undo", entryId),
  getRenameHistory: () => ipcRenderer.invoke("history:list"),
  undoRenameHistoryEntry: (payload) => ipcRenderer.invoke("history:undo", payload),
  getProviderStatuses: (options) => ipcRenderer.invoke("media:get-provider-statuses", options),
  previewRenames: (payload) => ipcRenderer.invoke("media:preview-renames", payload),
  applyRenames: (payload) => ipcRenderer.invoke("media:apply-renames", payload),
  showItemInFolder: (targetPath) => ipcRenderer.invoke("shell:show-item", targetPath),
  openFolder: (targetPath) => ipcRenderer.invoke("shell:open-folder", targetPath),
  openLog: () => ipcRenderer.invoke("shell:open-log"),
  openExternal: (url) => ipcRenderer.invoke("shell:open-external", url),
  getAppInfo: () => ipcRenderer.invoke("app:info"),
  getUpdateState: () => ipcRenderer.invoke("update:get-state"),
  checkForUpdates: () => ipcRenderer.invoke("update:check"),
  installUpdate: () => ipcRenderer.invoke("update:install"),
  onAutomationStatus: (listener) => subscribe("automation:status", listener),
  onUpdateState: (listener) => subscribe("update:state", listener),
  onSettingsChanged: (listener) => subscribe("settings:changed", listener),
  onNavigate: (listener) => subscribe("app:navigate", listener),
  onAccentColor: (listener) => subscribe("app:accent", listener)
};

contextBridge.exposeInMainWorld("folderBot", api);
