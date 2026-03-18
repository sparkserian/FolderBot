import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  AppSettings,
  RepairShowResult,
  AutomationHistoryEntry,
  AutomationStatus,
  ApplyRenameRequest,
  PreviewRequest,
  RenameHistoryEntry,
  UndoAutomationHistoryResult,
  UndoRenameHistoryRequest,
  UndoRenameHistoryResult
} from "../shared/types";

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
  repairSeasonPlacement: (selectedFolderPath: string) =>
    ipcRenderer.invoke("automation:repair-show", selectedFolderPath) as Promise<RepairShowResult>,
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
