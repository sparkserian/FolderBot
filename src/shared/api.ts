// The bridge the preload script exposes as window.folderBot. Shared so the main process and the
// renderer agree on every call.
import type {
  AppInfo,
  AppSettings,
  ApplyRenameRequest,
  AutomationHistoryEntry,
  AutomationRepairRequest,
  AutomationRepairResult,
  AutomationStatus,
  MetadataSourceId,
  PreviewRequest,
  ProviderSeriesSearchMatch,
  ProviderStatus,
  RenameHistoryEntry,
  RenamePreview,
  RenameResult,
  RepairShowResult,
  UndoAutomationHistoryResult,
  UndoRenameHistoryRequest,
  UndoRenameHistoryResult,
  UpdateState
} from "./types";

export interface FolderBotApi {
  platform: string;
  pickFiles: () => Promise<string[]>;
  pickOutputDirectory: () => Promise<string | null>;
  pickOutputDirectories: () => Promise<string[]>;
  getPathForFile: (file: File) => string | null;
  getSettings: () => Promise<AppSettings>;
  saveSettings: (payload: Partial<AppSettings>) => Promise<AppSettings>;
  getAutomationStatus: () => Promise<AutomationStatus>;
  setAutomationEnabled: (enabled: boolean) => Promise<AppSettings>;
  retryAutomationJob: (jobId: string) => Promise<void>;
  skipAutomationJob: (jobId: string) => Promise<void>;
  clearFinishedAutomationJobs: () => Promise<void>;
  repairSeasonPlacement: (selectedFolderPaths: string[]) => Promise<RepairShowResult[]>;
  searchAutomationSeries: (payload: { sourceId: MetadataSourceId; query: string }) => Promise<ProviderSeriesSearchMatch[]>;
  repairAutomationHistoryEntries: (payload: AutomationRepairRequest) => Promise<AutomationRepairResult>;
  getAutomationHistory: () => Promise<AutomationHistoryEntry[]>;
  undoAutomationHistoryEntry: (entryId: string) => Promise<UndoAutomationHistoryResult>;
  getRenameHistory: () => Promise<RenameHistoryEntry[]>;
  undoRenameHistoryEntry: (payload: UndoRenameHistoryRequest) => Promise<UndoRenameHistoryResult>;
  getProviderStatuses: (options: PreviewRequest["options"]) => Promise<ProviderStatus[]>;
  previewRenames: (payload: PreviewRequest) => Promise<RenamePreview[]>;
  applyRenames: (payload: ApplyRenameRequest) => Promise<RenameResult[]>;
  showItemInFolder: (targetPath: string) => Promise<void>;
  openFolder: (targetPath: string) => Promise<string>;
  openLog: () => Promise<string>;
  openExternal: (url: string) => Promise<void>;
  getAppInfo: () => Promise<AppInfo>;
  getUpdateState: () => Promise<UpdateState>;
  checkForUpdates: () => Promise<UpdateState>;
  installUpdate: () => Promise<void>;
  onAutomationStatus: (listener: (status: AutomationStatus) => void) => () => void;
  onUpdateState: (listener: (state: UpdateState) => void) => () => void;
  onSettingsChanged: (listener: (settings: AppSettings) => void) => () => void;
  onNavigate: (listener: (route: string) => void) => () => void;
  onAccentColor: (listener: (color: string | undefined) => void) => () => void;
}
