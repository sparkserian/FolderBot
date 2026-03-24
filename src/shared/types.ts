// Shared type definitions used across the renderer, main process, and IPC boundary.
export type MediaKind = "episode" | "movie" | "unknown";
export type MetadataSourceId = "local" | "tmdb" | "tvdb";

// The parser's best guess about a file before any online lookup happens.
export interface ParsedMedia {
  kind: MediaKind;
  originalTitle: string;
  normalizedTitle: string;
  year?: number;
  season?: number;
  episode?: number;
  absoluteEpisode?: number;
  sourceTag?: string;
  videoTags?: string[];
  videoCodecTag?: string;
  resolution?: string;
  confidence: number;
  warnings: string[];
}

// Metadata returned after a provider or local fallback resolves a file.
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

// Common options passed into preview generation and provider lookups.
export interface RenameOptions {
  sourceId: MetadataSourceId;
  tmdbToken?: string;
  tvdbApiKey?: string;
  tvdbPin?: string;
  language: string;
  destinationDirectory?: string;
  manualTitle?: string;
}

// A fully prepared preview row used by the manual rename screen.
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

// The outcome of a file operation after a rename or undo attempt.
export interface RenameResult {
  sourcePath: string;
  targetPath: string;
  success: boolean;
  error?: string;
}

// Renderer request used to build rename previews for a set of file paths.
export interface PreviewRequest {
  filePaths: string[];
  options: RenameOptions;
}

// Renderer request used to apply already-prepared rename previews.
export interface ApplyRenameRequest {
  items: RenamePreview[];
  sourceId?: MetadataSourceId;
}

// Lightweight status shown in the UI for each metadata source.
export interface ProviderStatus {
  id: MetadataSourceId;
  label: string;
  ready: boolean;
  details: string;
}

// Search result shown in the automation repair picker before a user chooses a show.
export interface ProviderSeriesSearchMatch {
  sourceId: MetadataSourceId;
  providerSeriesId: string;
  title: string;
  year?: number;
  summary?: string;
}

// Everything the app persists for provider setup and automation configuration.
export interface AppSettings {
  tmdbBearerToken: string;
  tvdbApiKey: string;
  tvdbPin: string;
  defaultLanguage: string;
  launchAtLogin: boolean;
  automationEnabled: boolean;
  automationInboxDirectory: string;
  automationSourceLibraryDirectory: string;
  automationMirrorLibraryDirectory: string;
  automationMovieSourceDirectory: string;
  automationMovieMirrorDirectory: string;
  automationSourceId: MetadataSourceId;
  automationSettleSeconds: number;
}

// One log entry in the live automation status panel.
export interface AutomationEvent {
  createdAt: string;
  message: string;
}

// Snapshot of the automation watcher's state for the renderer.
export interface AutomationStatus {
  enabled: boolean;
  watching: boolean;
  processing: boolean;
  inboxDirectory: string;
  sourceLibraryDirectory: string;
  mirrorLibraryDirectory: string;
  movieSourceDirectory: string;
  movieMirrorDirectory: string;
  sourceId: MetadataSourceId;
  settleSeconds: number;
  pendingCount: number;
  recentEvents: AutomationEvent[];
}

// Persistent record of one completed automation item.
export interface AutomationHistoryEntry {
  id: string;
  createdAt: string;
  sourceId: MetadataSourceId;
  mediaKind: Extract<MediaKind, "episode" | "movie">;
  originalInboxPath: string;
  sourceLibraryPath: string;
  mirrorLibraryPath: string;
  displayTitle: string;
  undoneAt?: string;
}

// Individual steps produced while undoing an automation history item.
export interface AutomationActionResult {
  kind: "move-back" | "delete-mirror";
  sourcePath: string;
  targetPath?: string;
  success: boolean;
  error?: string;
}

// Response returned after undoing an automation item.
export interface UndoAutomationHistoryResult {
  entryId: string;
  results: AutomationActionResult[];
}

// Search request used when the user repairs an automation match.
export interface SearchSeriesRequest {
  sourceId: MetadataSourceId;
  query: string;
  language: string;
  tmdbToken?: string;
  tvdbApiKey?: string;
  tvdbPin?: string;
}

// Repair request for one or more automation history items.
export interface AutomationRepairRequest {
  entryIds: string[];
  match: ProviderSeriesSearchMatch;
}

// Per-item result returned from a repair batch.
export interface AutomationRepairEntryResult {
  entryId: string;
  sourcePath: string;
  targetSourcePath?: string;
  mirrorPath: string;
  targetMirrorPath?: string;
  success: boolean;
  error?: string;
}

// Aggregate result returned from the automation repair flow.
export interface AutomationRepairResult {
  updatedCount: number;
  results: AutomationRepairEntryResult[];
}

// Per-library outcome from the season-placement repair helper.
export interface RepairShowLocationResult {
  rootLabel: "source" | "mirror";
  showPath: string;
  movedCount: number;
  createdSeasonFolders: string[];
  skippedCount: number;
  errors: string[];
}

// Combined result from running season repair across source and mirror libraries.
export interface RepairShowResult {
  selectedShowPath: string;
  showName: string;
  locations: RepairShowLocationResult[];
}

// One file inside a manually renamed batch.
export interface RenameHistoryItem {
  id: string;
  sourcePath: string;
  targetPath: string;
  undoneAt?: string;
}

// Persistent record of a manual rename batch.
export interface RenameHistoryEntry {
  id: string;
  createdAt: string;
  sourceId: MetadataSourceId;
  itemCount: number;
  items: RenameHistoryItem[];
  undoneAt?: string;
}

// Response returned after undoing one or more files from a manual batch.
export interface UndoRenameHistoryResult {
  entryId: string;
  results: RenameResult[];
}

// Request used to undo either all items or a selected subset from a batch.
export interface UndoRenameHistoryRequest {
  entryId: string;
  itemIds?: string[];
}
