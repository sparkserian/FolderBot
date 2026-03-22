// Safe, typed bridge that exposes a narrow Electron API to the renderer.
import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  AppSettings,
  ApplyRenameRequest,
  AutomationHistoryEntry,
  AutomationRepairRequest,
  AutomationRepairResult,
  AutomationStatus,
  MetadataSourceId,
  PreviewRequest,
  ProviderSeriesSearchMatch,
  RenameHistoryEntry,
  RepairShowResult,
  UndoAutomationHistoryResult,
  UndoRenameHistoryRequest,
  UndoRenameHistoryResult
} from "../shared/types";

// Only a narrow, typed surface is exposed to the renderer to keep the browser context isolated.
contextBridge.exposeInMainWorld("folderBot", {
  pickFiles: () => ipcRenderer.invoke("dialog:pick-files"),
  pickOutputDirectory: () => ipcRenderer.invoke("dialog:pick-output-directory"),
  getPathForFile: (file: Parameters<typeof webUtils.getPathForFile>[0]) => {
    const path = webUtils.getPathForFile(file);
    return path || null;
  },
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (payload: Partial<AppSettings>) => ipcRenderer.invoke("settings:save", payload),
  getAutomationStatus: () => ipcRenderer.invoke("automation:get-status") as Promise<AutomationStatus>,
  listRepairDirectories: (rootPath: string) =>
    ipcRenderer.invoke("automation:list-repair-directories", rootPath) as Promise<string[]>,
  repairSeasonPlacement: (selectedFolderPaths: string[]) =>
    ipcRenderer.invoke("automation:repair-show", selectedFolderPaths) as Promise<RepairShowResult[]>,
  searchAutomationSeries: (payload: { sourceId: MetadataSourceId; query: string }) =>
    ipcRenderer.invoke("automation:search-series", payload) as Promise<ProviderSeriesSearchMatch[]>,
  repairAutomationHistoryEntries: (payload: AutomationRepairRequest) =>
    ipcRenderer.invoke("automation:repair-history", payload) as Promise<AutomationRepairResult>,
  getAutomationHistory: () => ipcRenderer.invoke("automation-history:list") as Promise<AutomationHistoryEntry[]>,
  undoAutomationHistoryEntry: (entryId: string) =>
    ipcRenderer.invoke("automation-history:undo", entryId) as Promise<UndoAutomationHistoryResult>,
  getRenameHistory: () => ipcRenderer.invoke("history:list") as Promise<RenameHistoryEntry[]>,
  undoRenameHistoryEntry: (payload: UndoRenameHistoryRequest) =>
    ipcRenderer.invoke("history:undo", payload) as Promise<UndoRenameHistoryResult>,
  getProviderStatuses: (options: PreviewRequest["options"]) =>
    ipcRenderer.invoke("media:get-provider-statuses", options),
  previewRenames: (payload: PreviewRequest) => ipcRenderer.invoke("media:preview-renames", payload),
  applyRenames: (payload: ApplyRenameRequest) => ipcRenderer.invoke("media:apply-renames", payload),
  onOpenHelp: (listener: () => void) => {
    const wrappedListener = () => listener();
    ipcRenderer.on("app:open-help", wrappedListener);
    return () => ipcRenderer.off("app:open-help", wrappedListener);
  },
  onAutomationStatus: (listener: (status: AutomationStatus) => void) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, status: AutomationStatus) => listener(status);
    ipcRenderer.on("automation:status", wrappedListener);
    return () => ipcRenderer.off("automation:status", wrappedListener);
  }
});
