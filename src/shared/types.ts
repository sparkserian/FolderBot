export type MediaKind = "episode" | "movie" | "unknown";
export type MetadataSourceId = "local" | "tmdb" | "tvdb";

export interface ParsedMedia {
  kind: MediaKind;
  originalTitle: string;
  normalizedTitle: string;
  year?: number;
  season?: number;
  episode?: number;
  absoluteEpisode?: number;
  confidence: number;
  warnings: string[];
}

export interface ResolvedMetadata {
  sourceId: MetadataSourceId;
  displayTitle: string;
  year?: number;
  season?: number;
  episode?: number;
  episodeTitle?: string;
  summary?: string;
  matchConfidence?: number;
}

export interface RenameOptions {
  sourceId: MetadataSourceId;
  tmdbToken?: string;
  tvdbApiKey?: string;
  tvdbPin?: string;
  language: string;
  destinationDirectory?: string;
  manualTitle?: string;
}

export interface RenamePreview {
  id: string;
  sourcePath: string;
  currentName: string;
  currentDirectory: string;
  parsed: ParsedMedia;
  metadata: ResolvedMetadata | null;
  targetName: string;
  targetPath: string;
  warnings: string[];
  conflicts: string[];
}

export interface RenameResult {
  sourcePath: string;
  targetPath: string;
  success: boolean;
  error?: string;
}

export interface PreviewRequest {
  filePaths: string[];
  options: RenameOptions;
}

export interface ApplyRenameRequest {
  items: RenamePreview[];
  sourceId?: MetadataSourceId;
}

export interface ProviderStatus {
  id: MetadataSourceId;
  label: string;
  ready: boolean;
  details: string;
}

export interface AppSettings {
  tmdbBearerToken: string;
  tvdbApiKey: string;
  tvdbPin: string;
  defaultLanguage: string;
  automationEnabled: boolean;
  automationInboxDirectory: string;
  automationSourceLibraryDirectory: string;
  automationMirrorLibraryDirectory: string;
  automationSourceId: MetadataSourceId;
  automationSettleSeconds: number;
}

export interface AutomationEvent {
  createdAt: string;
  message: string;
}

export interface AutomationStatus {
  enabled: boolean;
  watching: boolean;
  processing: boolean;
  inboxDirectory: string;
  sourceLibraryDirectory: string;
  mirrorLibraryDirectory: string;
  sourceId: MetadataSourceId;
  settleSeconds: number;
  pendingCount: number;
  recentEvents: AutomationEvent[];
}

export interface AutomationHistoryEntry {
  id: string;
  createdAt: string;
  sourceId: MetadataSourceId;
  originalInboxPath: string;
  sourceLibraryPath: string;
  mirrorLibraryPath: string;
  displayTitle: string;
  undoneAt?: string;
}

export interface AutomationActionResult {
  kind: "move-back" | "delete-mirror";
  sourcePath: string;
  targetPath?: string;
  success: boolean;
  error?: string;
}

export interface UndoAutomationHistoryResult {
  entryId: string;
  results: AutomationActionResult[];
}

export interface RepairShowLocationResult {
  rootLabel: "source" | "mirror";
  showPath: string;
  movedCount: number;
  createdSeasonFolders: string[];
  skippedCount: number;
  errors: string[];
}

export interface RepairShowResult {
  selectedShowPath: string;
  showName: string;
  locations: RepairShowLocationResult[];
}

export interface RenameHistoryItem {
  id: string;
  sourcePath: string;
  targetPath: string;
  undoneAt?: string;
}

export interface RenameHistoryEntry {
  id: string;
  createdAt: string;
  sourceId: MetadataSourceId;
  itemCount: number;
  items: RenameHistoryItem[];
  undoneAt?: string;
}

export interface UndoRenameHistoryResult {
  entryId: string;
  results: RenameResult[];
}

export interface UndoRenameHistoryRequest {
  entryId: string;
  itemIds?: string[];
}
