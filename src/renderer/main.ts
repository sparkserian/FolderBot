// Renderer entry point: builds the UI, manages in-memory state, and calls into the preload API.
import "./styles.css";
import { icon } from "./icons";
import { formatEpisodeCode, parseMediaName, toDisplayTitle } from "../shared/filename-parser";
import type {
  AppSettings,
  AutomationHistoryEntry,
  AutomationRepairResult,
  AutomationStatus,
  RepairShowResult,
  UndoAutomationHistoryResult,
  ApplyRenameRequest,
  MetadataSourceId,
  ParsedMedia,
  PreviewRequest,
  ProviderStatus,
  ProviderSeriesSearchMatch,
  RenameHistoryEntry,
  RenamePreview,
  RenameResult
} from "../shared/types";

declare global {
  interface Window {
    folderBot: {
      platform: string;
      pickFiles: () => Promise<string[]>;
      pickOutputDirectory: () => Promise<string | null>;
      pickOutputDirectories: () => Promise<string[]>;
      getPathForFile: (file: File) => string | null;
      getSettings: () => Promise<AppSettings>;
      saveSettings: (payload: Partial<AppSettings>) => Promise<AppSettings>;
      getAutomationStatus: () => Promise<AutomationStatus>;
      repairSeasonPlacement: (selectedFolderPaths: string[]) => Promise<RepairShowResult[]>;
      searchAutomationSeries: (payload: {
        sourceId: MetadataSourceId;
        query: string;
      }) => Promise<ProviderSeriesSearchMatch[]>;
      repairAutomationHistoryEntries: (payload: {
        entryIds: string[];
        match: ProviderSeriesSearchMatch;
      }) => Promise<AutomationRepairResult>;
      getAutomationHistory: () => Promise<AutomationHistoryEntry[]>;
      undoAutomationHistoryEntry: (entryId: string) => Promise<UndoAutomationHistoryResult>;
      getRenameHistory: () => Promise<RenameHistoryEntry[]>;
      undoRenameHistoryEntry: (payload: { entryId: string; itemIds?: string[] }) => Promise<{
        entryId: string;
        results: RenameResult[];
      }>;
      getProviderStatuses: (options: PreviewRequest["options"]) => Promise<ProviderStatus[]>;
      previewRenames: (payload: PreviewRequest) => Promise<RenamePreview[]>;
      applyRenames: (payload: ApplyRenameRequest) => Promise<RenameResult[]>;
      onOpenHelp: (listener: () => void) => () => void;
      onAutomationStatus: (listener: (status: AutomationStatus) => void) => () => void;
    };
  }
}

type ViewName = "workspace" | "history" | "settings" | "help";
type SettingsTab = "general" | "metadata" | "automation" | "activity" | "repair" | "about";
type StatusTone = "neutral" | "success" | "error";

// One series the user still needs to confirm before a provider lookup runs.
interface SeriesGroup {
  key: string;
  title: string;
  filePaths: string[];
}

// Shared state for both series pickers: the one before a manual match, and the one that
// repairs an automation item after the fact.
interface MatchDialogState {
  mode: "manual" | "repair" | null;
  groups: SeriesGroup[];
  index: number;
  sourceId: MetadataSourceId;
  query: string;
  results: ProviderSeriesSearchMatch[];
  selectedKey: string | null;
  hoveredKey: string | null;
  searching: boolean;
}

interface AppState {
  view: ViewName;
  settingsTab: SettingsTab;
  historyTab: "manual" | "automation";
  historyQuery: string;
  filePaths: string[];
  previews: RenamePreview[];
  providerStatuses: ProviderStatus[];
  outputDirectory: string;
  sourceId: MetadataSourceId;
  manualTitle: string;
  selectedPath: string | null;
  settings: AppSettings;
  settingsDraft: AppSettings;
  automationStatus: AutomationStatus;
  repairShowFolderPaths: string[];
  historyEntries: RenameHistoryEntry[];
  automationHistoryEntries: AutomationHistoryEntry[];
  historySelection: Record<string, string[]>;
  automationHistorySelection: string[];
  explicitSeriesMatches: Record<string, ProviderSeriesSearchMatch>;
  matchDialog: MatchDialogState;
  dragDepth: number;
  busy: boolean;
  message: string;
  messageTone: StatusTone;
}

const SOURCE_LABELS: Record<MetadataSourceId, string> = {
  local: "Local parser",
  tmdb: "TMDb",
  tvdb: "TheTVDB"
};

const MEDIA_EXTENSIONS = "mkv · mp4 · avi · mov · m4v · wmv · mpg · srt · ass";

const APP_VERSION = "1.0.21";

const DEFAULT_SETTINGS: AppSettings = {
  tmdbBearerToken: "",
  tvdbApiKey: "",
  tvdbPin: "",
  defaultLanguage: "en-US",
  launchAtLogin: false,
  automationEnabled: false,
  automationInboxDirectory: "",
  automationSourceLibraryDirectory: "",
  automationMirrorLibraryDirectory: "",
  automationMovieSourceDirectory: "",
  automationMovieMirrorDirectory: "",
  automationSourceId: "tvdb",
  automationSettleSeconds: 45
};

const DEFAULT_AUTOMATION_STATUS: AutomationStatus = {
  enabled: false,
  watching: false,
  processing: false,
  inboxDirectory: "",
  sourceLibraryDirectory: "",
  mirrorLibraryDirectory: "",
  movieSourceDirectory: "",
  movieMirrorDirectory: "",
  sourceId: "tvdb",
  settleSeconds: 45,
  pendingCount: 0,
  recentEvents: []
};

const state: AppState = {
  view: "workspace",
  settingsTab: "general",
  historyTab: "manual",
  historyQuery: "",
  filePaths: [],
  previews: [],
  providerStatuses: [],
  outputDirectory: "",
  sourceId: "local",
  manualTitle: "",
  selectedPath: null,
  settings: DEFAULT_SETTINGS,
  settingsDraft: DEFAULT_SETTINGS,
  automationStatus: DEFAULT_AUTOMATION_STATUS,
  repairShowFolderPaths: [],
  historyEntries: [],
  automationHistoryEntries: [],
  historySelection: {},
  automationHistorySelection: [],
  explicitSeriesMatches: {},
  matchDialog: {
    mode: null,
    groups: [],
    index: 0,
    sourceId: "tvdb",
    query: "",
    results: [],
    selectedKey: null,
    hoveredKey: null,
    searching: false
  },
  dragDepth: 0,
  busy: false,
  message: "Drop files in to get started.",
  messageTone: "neutral"
};

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("App root not found");
}

document.documentElement.dataset.platform = window.folderBot?.platform ?? "darwin";

app.innerHTML = `
  <div class="app-shell">
    <header class="title-bar">
      <div class="brand">
        <span class="brand-mark">${icon("robot")}</span>
        FolderBot
      </div>

      <nav class="nav" aria-label="Sections">
        <button class="nav-item" type="button" data-view="workspace">${icon("filmSlate")}Rename</button>
        <button class="nav-item" type="button" data-view="history">${icon("clockCounterClockwise")}History</button>
        <button class="nav-item" type="button" data-view="settings">${icon("gearSix")}Settings</button>
        <button class="nav-item" type="button" data-view="help">${icon("question")}Help</button>
      </nav>

      <div class="title-bar-status">
        <span id="watcherChip" class="chip"></span>
      </div>
    </header>

    <main>
      <section id="workspaceView" class="view workspace-view">
        <div class="toolbar">
          <label class="field toolbar-field-source">
            <span class="field-label">Metadata source</span>
            <select id="sourceSelect">
              <option value="local">Local parser</option>
              <option value="tmdb">TMDb</option>
              <option value="tvdb">TheTVDB</option>
            </select>
          </label>

          <label class="field toolbar-field-title">
            <span class="field-label">Series title override</span>
            <input id="manualTitleInput" type="text" placeholder="Only if the filename is unreadable" />
          </label>

          <label class="field toolbar-field-output">
            <span class="field-label">Save renamed files to</span>
            <div class="field-row">
              <input id="outputInput" type="text" placeholder="The folder each file is already in" readonly />
              <button id="outputButton" class="btn btn-secondary btn-sm" type="button">Choose</button>
              <button id="outputClearButton" class="btn btn-ghost btn-icon btn-sm" type="button" title="Rename in place" aria-label="Rename in place">${icon("x")}</button>
            </div>
          </label>

          <div class="toolbar-spacer"></div>

          <div class="toolbar-actions">
            <button id="addButton" class="btn btn-secondary" type="button">${icon("plus")}Add files</button>
            <button id="clearButton" class="btn btn-ghost" type="button">${icon("broom")}Clear</button>
            <button id="matchButton" class="btn btn-secondary" type="button">${icon("magnifyingGlass")}Match</button>
            <button id="applyButton" class="btn btn-primary" type="button">${icon("check")}Rename</button>
          </div>
        </div>

        <section class="queue">
          <div id="queueHead" class="queue-head" hidden>
            <span></span>
            <span>Current name</span>
            <span></span>
            <span>Renamed to</span>
            <span></span>
          </div>
          <div id="queueBody" class="queue-body"></div>
        </section>

        <div class="inspector">
          <div class="inspector-block">
            <span class="inspector-label">Detected</span>
            <span id="inspectDetected" class="inspector-value">Nothing selected</span>
            <span id="inspectDetectedPath" class="inspector-detail inspector-detail-mono">Add files to begin</span>
          </div>
          <div class="inspector-block">
            <span class="inspector-label">Match</span>
            <span id="inspectMatch" class="inspector-value">—</span>
            <span id="inspectMatchDetail" class="inspector-detail inspector-detail-mono">—</span>
          </div>
          <div class="inspector-block">
            <span class="inspector-label">Notes</span>
            <span id="inspectNotes" class="inspector-value">—</span>
            <span id="inspectNotesDetail" class="inspector-detail">—</span>
          </div>
          <p id="statusLine" class="status-line"></p>
        </div>
      </section>

      <section id="historyView" class="view history-view" hidden>
        <div class="history-toolbar">
          <div class="segmented" role="tablist" aria-label="History type">
            <button id="historyTabManual" type="button" role="tab" aria-selected="true">${icon("listPlus")}Manual renames</button>
            <button id="historyTabAutomation" type="button" role="tab" aria-selected="false">${icon("pulse")}Automation</button>
          </div>
          <input id="historySearch" class="history-search" type="search" placeholder="Filter by file or show name" />
          <button id="historyRefreshButton" class="btn btn-secondary" type="button">${icon("arrowsClockwise")}Refresh</button>
        </div>
        <div id="historyList" class="history-list"></div>
      </section>

      <section id="settingsView" class="view panel-view" hidden>
        <nav class="panel-nav" role="tablist" aria-orientation="vertical" aria-label="Settings sections">
          <span class="panel-nav-title">Settings</span>
          <button class="panel-tab" type="button" role="tab" data-tab="general">${icon("slidersHorizontal")}General</button>
          <button class="panel-tab" type="button" role="tab" data-tab="metadata">${icon("key")}Metadata sources</button>
          <button class="panel-tab" type="button" role="tab" data-tab="automation">${icon("robot")}Automation</button>
          <button class="panel-tab" type="button" role="tab" data-tab="activity">${icon("pulse")}Activity</button>
          <button class="panel-tab" type="button" role="tab" data-tab="repair">${icon("wrench")}Library repair</button>
          <button class="panel-tab" type="button" role="tab" data-tab="about">${icon("info")}About</button>
          <span id="settingsNavFooter" class="panel-nav-footer"></span>
        </nav>

        <div class="panel-main">
          <div class="panel-scroll">
            <div class="panel-inner">
              <section class="panel-section" data-panel="general">
                <h2 class="panel-heading">General</h2>
                <p class="panel-subheading">How FolderBot starts up and which language it asks providers for.</p>

                <div class="group">
                  <div class="group-title">${icon("hardDrives")}Startup</div>
                  <div class="group-body group-body-tight">
                    <label class="switch">
                      <span class="switch-copy">
                        <strong>Launch at login</strong>
                        <span class="field-hint">Starts FolderBot in the background with the automation watcher running. Closing the window keeps it in the tray.</span>
                      </span>
                      <input id="settingsLaunchAtLogin" type="checkbox" />
                    </label>
                  </div>
                </div>

                <div class="group">
                  <div class="group-title">${icon("linkSimple")}Provider language</div>
                  <div class="group-body">
                    <label class="field">
                      <span class="field-label">Language tag</span>
                      <input id="settingsLanguage" type="text" placeholder="en-US" />
                      <p class="field-hint">Used for every TMDb and TheTVDB lookup, including automation.</p>
                    </label>
                  </div>
                </div>
              </section>

              <section class="panel-section" data-panel="metadata" hidden>
                <h2 class="panel-heading">Metadata sources</h2>
                <p class="panel-subheading">Credentials are stored on this machine only. The local parser needs no setup and works offline.</p>

                <div class="group">
                  <div class="group-title">${icon("filmSlate")}TMDb<span id="settingsTmdbChip" class="chip"></span></div>
                  <div class="group-body">
                    <label class="field">
                      <span class="field-label">API read access token</span>
                      <input id="settingsTmdbToken" type="password" placeholder="Paste a TMDb API Read Access Token" />
                      <p id="settingsTmdbStatus" class="field-hint"></p>
                    </label>
                  </div>
                </div>

                <div class="group">
                  <div class="group-title">${icon("televisionSimple")}TheTVDB<span id="settingsTvdbChip" class="chip"></span></div>
                  <div class="group-body">
                    <label class="field">
                      <span class="field-label">API key</span>
                      <input id="settingsTvdbApiKey" type="password" placeholder="Store your TheTVDB API key here" />
                    </label>
                    <label class="field">
                      <span class="field-label">Subscriber PIN</span>
                      <input id="settingsTvdbPin" type="password" placeholder="Only if your key requires one" />
                      <p id="settingsTvdbStatus" class="field-hint"></p>
                    </label>
                  </div>
                </div>
              </section>

              <section class="panel-section" data-panel="automation" hidden>
                <h2 class="panel-heading">Automation</h2>
                <p class="panel-subheading">FolderBot watches one inbox folder. When a download finishes and settles, it renames the file, copies it to the mirror library, then moves it into the source library. Episodes get show and season folders; movies stay flat in the movie root.</p>

                <div class="group">
                  <div class="group-title">${icon("pulse")}Watcher</div>
                  <div class="group-body group-body-tight">
                    <label class="switch">
                      <span class="switch-copy">
                        <strong>Watch the inbox folder</strong>
                        <span class="field-hint">Needs an inbox and at least one library pair below.</span>
                      </span>
                      <input id="settingsAutomationEnabled" type="checkbox" />
                    </label>
                  </div>
                </div>

                <div class="group">
                  <div class="group-title">${icon("folderOpen")}Folders</div>
                  <div class="group-body">
                    <label class="field">
                      <span class="field-label">Inbox</span>
                      <div class="field-row">
                        <input id="settingsAutomationInboxDirectory" type="text" placeholder="Where downloads first land" readonly />
                        <button id="settingsAutomationInboxButton" class="btn btn-secondary btn-sm" type="button">Choose</button>
                      </div>
                    </label>
                    <label class="field">
                      <span class="field-label">TV source library</span>
                      <div class="field-row">
                        <input id="settingsAutomationSourceLibraryDirectory" type="text" placeholder="Organized library on the source drive" readonly />
                        <button id="settingsAutomationSourceLibraryButton" class="btn btn-secondary btn-sm" type="button">Choose</button>
                      </div>
                    </label>
                    <label class="field">
                      <span class="field-label">TV mirror library</span>
                      <div class="field-row">
                        <input id="settingsAutomationMirrorLibraryDirectory" type="text" placeholder="Matching library on the mirror drive" readonly />
                        <button id="settingsAutomationMirrorLibraryButton" class="btn btn-secondary btn-sm" type="button">Choose</button>
                      </div>
                    </label>
                    <label class="field">
                      <span class="field-label">Movie source library</span>
                      <div class="field-row">
                        <input id="settingsAutomationMovieSourceDirectory" type="text" placeholder="Organized movie library on the source drive" readonly />
                        <button id="settingsAutomationMovieSourceButton" class="btn btn-secondary btn-sm" type="button">Choose</button>
                      </div>
                    </label>
                    <label class="field">
                      <span class="field-label">Movie mirror library</span>
                      <div class="field-row">
                        <input id="settingsAutomationMovieMirrorDirectory" type="text" placeholder="Matching movie library on the mirror drive" readonly />
                        <button id="settingsAutomationMovieMirrorButton" class="btn btn-secondary btn-sm" type="button">Choose</button>
                      </div>
                    </label>
                  </div>
                </div>

                <div class="group">
                  <div class="group-title">${icon("slidersHorizontal")}Matching</div>
                  <div class="group-body">
                    <div class="field-grid">
                      <label class="field">
                        <span class="field-label">Metadata source</span>
                        <select id="settingsAutomationSource">
                          <option value="local">Local parser</option>
                          <option value="tmdb">TMDb</option>
                          <option value="tvdb">TheTVDB</option>
                        </select>
                      </label>
                      <label class="field">
                        <span class="field-label">Settle time (seconds)</span>
                        <input id="settingsAutomationSettleSeconds" type="number" min="10" max="600" step="5" />
                      </label>
                    </div>
                    <p class="field-hint">A file has to stay the same size for the full settle time before FolderBot touches it, so partial downloads are left alone.</p>
                  </div>
                </div>
              </section>

              <section class="panel-section" data-panel="activity" hidden>
                <h2 class="panel-heading">Activity</h2>
                <p class="panel-subheading">Live state of the automation watcher and what it did recently.</p>

                <div class="group">
                  <div class="group-title">${icon("pulse")}Watcher state</div>
                  <div class="group-body">
                    <div id="automationStatusGrid" class="status-grid"></div>
                    <dl id="automationPaths" class="path-list"></dl>
                  </div>
                </div>

                <div class="group">
                  <div class="group-title">${icon("clockCounterClockwise")}Recent events</div>
                  <div class="group-body">
                    <ul id="automationEvents" class="event-log"></ul>
                  </div>
                </div>
              </section>

              <section class="panel-section" data-panel="repair" hidden>
                <h2 class="panel-heading">Library repair</h2>
                <p class="panel-subheading">Move episodes that ended up loose in a show folder into the right season folder. Pick show folders or season folders from any drive, on both the source and mirror libraries.</p>

                <div class="group">
                  <div class="group-title">${icon("wrench")}Season placement</div>
                  <div class="group-body">
                    <div class="field-row">
                      <button id="repairShowFolderButton" class="btn btn-secondary" type="button">${icon("folderPlus")}Choose folders</button>
                      <button id="repairShowClearButton" class="btn btn-ghost" type="button">Clear list</button>
                    </div>
                    <div id="repairShowFolderList"></div>
                    <button id="repairShowRunButton" class="btn btn-primary" type="button">${icon("wrench")}Repair selected folders</button>
                  </div>
                </div>
              </section>

              <section class="panel-section" data-panel="about" hidden>
                <h2 class="panel-heading">About</h2>
                <p class="panel-subheading">FolderBot renames and files TV episodes and movies, by hand or on a watcher.</p>

                <div class="group">
                  <div class="group-title">${icon("info")}Details</div>
                  <div class="group-body">
                    <dl id="aboutList" class="about-list"></dl>
                    <p class="field-hint">Settings and history live in your user data folder and survive upgrades, so credentials carry over to every new build.</p>
                  </div>
                </div>
              </section>
            </div>
          </div>

          <div class="panel-footer">
            <p id="settingsFooterNote" class="panel-footer-note"></p>
            <div class="panel-footer-actions">
              <button id="settingsResetButton" class="btn btn-ghost" type="button">Discard changes</button>
              <button id="settingsSaveButton" class="btn btn-primary" type="button">${icon("floppyDisk")}Save settings</button>
            </div>
          </div>
        </div>
      </section>

      <section id="helpView" class="view doc-view" hidden>
        <div class="panel-main">
          <div class="panel-scroll">
            <div class="panel-inner">
              <h2 class="panel-heading">How FolderBot works</h2>
              <p class="panel-subheading">Two workflows: rename a batch by hand, or let the watcher file downloads as they land.</p>

              <div class="group">
                <div class="group-title">${icon("filmSlate")}Renaming by hand</div>
                <div class="group-body">
                  <div class="help-steps">
                    <div class="help-step">
                      <span class="help-step-number">1</span>
                      <div class="help-step-copy">
                        <strong>Add the files</strong>
                        <p>Drag them anywhere onto the window, or use <strong>Add files</strong>.</p>
                      </div>
                    </div>
                    <div class="help-step">
                      <span class="help-step-number">2</span>
                      <div class="help-step-copy">
                        <strong>Pick a metadata source</strong>
                        <p>The local parser works offline and needs no key. TMDb and TheTVDB add real episode titles once you add credentials in Settings.</p>
                      </div>
                    </div>
                    <div class="help-step">
                      <span class="help-step-number">3</span>
                      <div class="help-step-copy">
                        <strong>Match</strong>
                        <p>FolderBot reads season and episode numbers from each filename and builds the new name. With an online source it asks you to confirm the series once per show, so a whole season is one answer.</p>
                      </div>
                    </div>
                    <div class="help-step">
                      <span class="help-step-number">4</span>
                      <div class="help-step-copy">
                        <strong>Review, then rename</strong>
                        <p>Every row shows the current name beside the new one. Select a row to inspect what was detected and any warnings before you commit.</p>
                      </div>
                    </div>
                    <div class="help-step">
                      <span class="help-step-number">5</span>
                      <div class="help-step-copy">
                        <strong>Undo if needed</strong>
                        <p><strong>History</strong> keeps every batch and can put back a whole batch or just the files you pick.</p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div class="group">
                <div class="group-title">${icon("robot")}Automation</div>
                <div class="group-body">
                  <p class="field-hint">Set an inbox folder and your library roots in <strong>Settings → Automation</strong>. When a download finishes and stops changing, FolderBot renames it, copies it to the mirror library, then moves it into the source library. Episodes get show and season folders; movies go straight into the movie root. Everything it does shows up in <strong>History → Automation</strong>, where you can undo an item or fix a wrong show match.</p>
                </div>
              </div>

              <div class="group">
                <div class="group-title">${icon("question")}Filenames it understands</div>
                <div class="group-body">
                  <p class="field-hint">Season and episode markers are read no matter what sits between them: <strong>S01E02</strong>, <strong>S01 E02</strong>, <strong>S01_E02</strong>, <strong>S01.E02</strong>, <strong>S01 - E02</strong>, <strong>1x02</strong>, and <strong>Season 1 Episode 2</strong> all work. Movies are read from the year in the name, and tracker or release-group text in front of the title is ignored.</p>
                  <p class="field-hint">Press <kbd>Esc</kbd> to close a dialog or return to the rename screen.</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </main>
  </div>

  <div id="dropOverlay" class="drop-overlay" hidden>
    <div class="drop-overlay-frame">
      ${icon("folderPlus")}
      Drop to add to the queue
    </div>
  </div>

  <div id="matchScrim" class="scrim" hidden>
    <section class="dialog" role="dialog" aria-modal="true" aria-labelledby="matchDialogTitle">
      <div class="dialog-head">
        <div class="dialog-title">
          <strong id="matchDialogTitle">Confirm the series</strong>
          <span id="matchDialogSubtitle"></span>
        </div>
        <button id="matchCloseButton" class="btn btn-ghost btn-icon" type="button" aria-label="Close">${icon("x")}</button>
      </div>

      <div class="dialog-body">
        <div class="dialog-search">
          <div class="field">
            <span class="field-label">Search <span id="matchProviderName">TheTVDB</span></span>
            <div class="field-row">
              <input id="matchSearchInput" type="text" placeholder="Type the correct show title" />
              <button id="matchSearchButton" class="btn btn-secondary" type="button">${icon("magnifyingGlass")}Search</button>
            </div>
          </div>
          <div id="matchResultList" class="result-list" role="listbox" aria-label="Search results"></div>
        </div>

        <div class="dialog-side">
          <div id="matchDetailCard" class="detail-card"></div>
        </div>
      </div>

      <div class="dialog-foot">
        <p id="matchFootNote" class="dialog-foot-note"></p>
        <button id="matchSkipButton" class="btn btn-ghost" type="button">Let FolderBot choose</button>
        <button id="matchApplyButton" class="btn btn-primary" type="button">${icon("check")}Use this series</button>
      </div>
    </section>
  </div>
`;

const workspaceView = requireElement<HTMLElement>("#workspaceView");
const historyView = requireElement<HTMLElement>("#historyView");
const settingsView = requireElement<HTMLElement>("#settingsView");
const helpView = requireElement<HTMLElement>("#helpView");
const navItems = Array.from(document.querySelectorAll<HTMLButtonElement>(".nav-item"));
const settingsTabs = Array.from(document.querySelectorAll<HTMLButtonElement>(".panel-tab"));
const settingsPanels = Array.from(document.querySelectorAll<HTMLElement>(".panel-section"));
const watcherChip = requireElement<HTMLSpanElement>("#watcherChip");

const sourceSelect = requireElement<HTMLSelectElement>("#sourceSelect");
const manualTitleInput = requireElement<HTMLInputElement>("#manualTitleInput");
const outputInput = requireElement<HTMLInputElement>("#outputInput");
const outputButton = requireElement<HTMLButtonElement>("#outputButton");
const outputClearButton = requireElement<HTMLButtonElement>("#outputClearButton");
const addButton = requireElement<HTMLButtonElement>("#addButton");
const clearButton = requireElement<HTMLButtonElement>("#clearButton");
const matchButton = requireElement<HTMLButtonElement>("#matchButton");
const applyButton = requireElement<HTMLButtonElement>("#applyButton");
const queueHead = requireElement<HTMLDivElement>("#queueHead");
const queueBody = requireElement<HTMLDivElement>("#queueBody");
const dropOverlay = requireElement<HTMLDivElement>("#dropOverlay");

const inspectDetected = requireElement<HTMLSpanElement>("#inspectDetected");
const inspectDetectedPath = requireElement<HTMLSpanElement>("#inspectDetectedPath");
const inspectMatch = requireElement<HTMLSpanElement>("#inspectMatch");
const inspectMatchDetail = requireElement<HTMLSpanElement>("#inspectMatchDetail");
const inspectNotes = requireElement<HTMLSpanElement>("#inspectNotes");
const inspectNotesDetail = requireElement<HTMLSpanElement>("#inspectNotesDetail");
const statusLine = requireElement<HTMLParagraphElement>("#statusLine");

const historyTabManual = requireElement<HTMLButtonElement>("#historyTabManual");
const historyTabAutomation = requireElement<HTMLButtonElement>("#historyTabAutomation");
const historySearch = requireElement<HTMLInputElement>("#historySearch");
const historyRefreshButton = requireElement<HTMLButtonElement>("#historyRefreshButton");
const historyList = requireElement<HTMLDivElement>("#historyList");

const settingsLaunchAtLogin = requireElement<HTMLInputElement>("#settingsLaunchAtLogin");
const settingsLanguage = requireElement<HTMLInputElement>("#settingsLanguage");
const settingsTmdbToken = requireElement<HTMLInputElement>("#settingsTmdbToken");
const settingsTmdbStatus = requireElement<HTMLParagraphElement>("#settingsTmdbStatus");
const settingsTmdbChip = requireElement<HTMLSpanElement>("#settingsTmdbChip");
const settingsTvdbApiKey = requireElement<HTMLInputElement>("#settingsTvdbApiKey");
const settingsTvdbPin = requireElement<HTMLInputElement>("#settingsTvdbPin");
const settingsTvdbStatus = requireElement<HTMLParagraphElement>("#settingsTvdbStatus");
const settingsTvdbChip = requireElement<HTMLSpanElement>("#settingsTvdbChip");
const settingsAutomationEnabled = requireElement<HTMLInputElement>("#settingsAutomationEnabled");
const settingsAutomationInboxDirectory = requireElement<HTMLInputElement>("#settingsAutomationInboxDirectory");
const settingsAutomationInboxButton = requireElement<HTMLButtonElement>("#settingsAutomationInboxButton");
const settingsAutomationSourceLibraryDirectory = requireElement<HTMLInputElement>("#settingsAutomationSourceLibraryDirectory");
const settingsAutomationSourceLibraryButton = requireElement<HTMLButtonElement>("#settingsAutomationSourceLibraryButton");
const settingsAutomationMirrorLibraryDirectory = requireElement<HTMLInputElement>("#settingsAutomationMirrorLibraryDirectory");
const settingsAutomationMirrorLibraryButton = requireElement<HTMLButtonElement>("#settingsAutomationMirrorLibraryButton");
const settingsAutomationMovieSourceDirectory = requireElement<HTMLInputElement>("#settingsAutomationMovieSourceDirectory");
const settingsAutomationMovieSourceButton = requireElement<HTMLButtonElement>("#settingsAutomationMovieSourceButton");
const settingsAutomationMovieMirrorDirectory = requireElement<HTMLInputElement>("#settingsAutomationMovieMirrorDirectory");
const settingsAutomationMovieMirrorButton = requireElement<HTMLButtonElement>("#settingsAutomationMovieMirrorButton");
const settingsAutomationSource = requireElement<HTMLSelectElement>("#settingsAutomationSource");
const settingsAutomationSettleSeconds = requireElement<HTMLInputElement>("#settingsAutomationSettleSeconds");
const settingsSaveButton = requireElement<HTMLButtonElement>("#settingsSaveButton");
const settingsResetButton = requireElement<HTMLButtonElement>("#settingsResetButton");
const settingsFooterNote = requireElement<HTMLParagraphElement>("#settingsFooterNote");
const settingsNavFooter = requireElement<HTMLSpanElement>("#settingsNavFooter");

const automationStatusGrid = requireElement<HTMLDivElement>("#automationStatusGrid");
const automationPaths = requireElement<HTMLDListElement>("#automationPaths");
const automationEvents = requireElement<HTMLUListElement>("#automationEvents");
const aboutList = requireElement<HTMLDListElement>("#aboutList");

const repairShowFolderButton = requireElement<HTMLButtonElement>("#repairShowFolderButton");
const repairShowClearButton = requireElement<HTMLButtonElement>("#repairShowClearButton");
const repairShowRunButton = requireElement<HTMLButtonElement>("#repairShowRunButton");
const repairShowFolderList = requireElement<HTMLDivElement>("#repairShowFolderList");

const matchScrim = requireElement<HTMLDivElement>("#matchScrim");
const matchDialogTitle = requireElement<HTMLElement>("#matchDialogTitle");
const matchDialogSubtitle = requireElement<HTMLSpanElement>("#matchDialogSubtitle");
const matchProviderName = requireElement<HTMLSpanElement>("#matchProviderName");
const matchSearchInput = requireElement<HTMLInputElement>("#matchSearchInput");
const matchSearchButton = requireElement<HTMLButtonElement>("#matchSearchButton");
const matchResultList = requireElement<HTMLDivElement>("#matchResultList");
const matchDetailCard = requireElement<HTMLDivElement>("#matchDetailCard");
const matchCloseButton = requireElement<HTMLButtonElement>("#matchCloseButton");
const matchSkipButton = requireElement<HTMLButtonElement>("#matchSkipButton");
const matchApplyButton = requireElement<HTMLButtonElement>("#matchApplyButton");
const matchFootNote = requireElement<HTMLParagraphElement>("#matchFootNote");

bindEvents();
render();
void initialize();

// Pull initial settings, history, and automation status from the preload bridge.
async function initialize(): Promise<void> {
  state.settings = await window.folderBot.getSettings();
  state.settingsDraft = { ...state.settings };
  state.automationStatus = await window.folderBot.getAutomationStatus();
  await loadHistory();
  await refreshProviderStatuses();

  window.folderBot.onOpenHelp(() => {
    state.view = "help";
    render();
  });

  window.folderBot.onAutomationStatus((status) => {
    state.automationStatus = status;
    render();
  });

  render();
}

// Register all DOM event handlers in one place so state transitions are easier to follow.
function bindEvents(): void {
  for (const item of navItems) {
    item.addEventListener("click", () => {
      setView(item.dataset.view as ViewName);
    });
  }

  for (const tab of settingsTabs) {
    tab.addEventListener("click", () => {
      state.settingsTab = tab.dataset.tab as SettingsTab;
      render();
    });

    tab.addEventListener("keydown", (event) => {
      const offset = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
      if (offset === 0) {
        return;
      }

      event.preventDefault();
      const index = settingsTabs.indexOf(tab);
      const next = settingsTabs[(index + offset + settingsTabs.length) % settingsTabs.length];
      state.settingsTab = next.dataset.tab as SettingsTab;
      render();
      next.focus();
    });
  }

  sourceSelect.addEventListener("change", async () => {
    state.sourceId = sourceSelect.value as MetadataSourceId;
    state.explicitSeriesMatches = {};
    await refreshProviderStatuses();
    const provider = getProviderStatus(state.sourceId);
    setMessage(
      provider?.ready
        ? `Matching against ${provider.label}.`
        : `${provider?.label ?? "That source"} needs credentials. Add them in Settings.`,
      provider?.ready ? "neutral" : "error"
    );
  });

  manualTitleInput.addEventListener("input", () => {
    state.manualTitle = manualTitleInput.value.trim();
  });

  outputButton.addEventListener("click", async () => {
    const directory = await window.folderBot.pickOutputDirectory();
    if (directory) {
      state.outputDirectory = directory;
      render();
    }
  });

  outputClearButton.addEventListener("click", () => {
    state.outputDirectory = "";
    render();
  });

  addButton.addEventListener("click", async () => {
    mergeFiles(await window.folderBot.pickFiles());
  });

  clearButton.addEventListener("click", () => {
    state.filePaths = [];
    state.previews = [];
    state.explicitSeriesMatches = {};
    state.selectedPath = null;
    setMessage("Queue cleared.");
  });

  matchButton.addEventListener("click", () => {
    void startMatch();
  });

  applyButton.addEventListener("click", () => {
    void applyRenameBatch();
  });

  queueBody.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }

    const removeButton = target.closest<HTMLButtonElement>("[data-remove-path]");
    if (removeButton?.dataset.removePath) {
      removeFile(removeButton.dataset.removePath);
      return;
    }

    if (target.closest("#queueDropzone")) {
      void window.folderBot.pickFiles().then(mergeFiles);
      return;
    }

    const row = target.closest<HTMLElement>("[data-path]");
    if (row?.dataset.path) {
      state.selectedPath = row.dataset.path;
      render();
    }
  });

  // Drag tracking uses a counter because dragenter and dragleave fire for every child.
  document.addEventListener("dragenter", (event) => {
    event.preventDefault();
    state.dragDepth += 1;
    renderDropOverlay();
  });

  document.addEventListener("dragover", (event) => {
    event.preventDefault();
  });

  document.addEventListener("dragleave", (event) => {
    event.preventDefault();
    state.dragDepth = Math.max(0, state.dragDepth - 1);
    renderDropOverlay();
  });

  document.addEventListener("drop", async (event) => {
    event.preventDefault();
    state.dragDepth = 0;
    renderDropOverlay();

    if (state.view !== "workspace") {
      setView("workspace");
    }

    mergeFiles(await getDroppedPaths(event));
  });

  historyTabManual.addEventListener("click", () => {
    state.historyTab = "manual";
    render();
  });

  historyTabAutomation.addEventListener("click", () => {
    state.historyTab = "automation";
    render();
  });

  historySearch.addEventListener("input", () => {
    state.historyQuery = historySearch.value;
    renderHistory();
  });

  historyRefreshButton.addEventListener("click", async () => {
    await loadHistory();
    setMessage("History reloaded.");
  });

  historyList.addEventListener("click", (event) => {
    void handleHistoryClick(event);
  });

  historyList.addEventListener("change", (event) => {
    handleHistoryChange(event);
  });

  bindSettingsInput(settingsTmdbToken, (value) => {
    state.settingsDraft.tmdbBearerToken = value;
  });
  bindSettingsInput(settingsTvdbApiKey, (value) => {
    state.settingsDraft.tvdbApiKey = value;
  });
  bindSettingsInput(settingsTvdbPin, (value) => {
    state.settingsDraft.tvdbPin = value;
  });
  bindSettingsInput(settingsLanguage, (value) => {
    state.settingsDraft.defaultLanguage = value;
  });
  bindSettingsInput(settingsAutomationSettleSeconds, (value) => {
    state.settingsDraft.automationSettleSeconds = Number(value) || 45;
  });

  settingsLaunchAtLogin.addEventListener("change", () => {
    state.settingsDraft.launchAtLogin = settingsLaunchAtLogin.checked;
    render();
  });

  settingsAutomationEnabled.addEventListener("change", () => {
    state.settingsDraft.automationEnabled = settingsAutomationEnabled.checked;
    render();
  });

  settingsAutomationSource.addEventListener("change", () => {
    state.settingsDraft.automationSourceId = settingsAutomationSource.value as MetadataSourceId;
    render();
  });

  bindDirectoryPicker(settingsAutomationInboxButton, "automationInboxDirectory");
  bindDirectoryPicker(settingsAutomationSourceLibraryButton, "automationSourceLibraryDirectory");
  bindDirectoryPicker(settingsAutomationMirrorLibraryButton, "automationMirrorLibraryDirectory");
  bindDirectoryPicker(settingsAutomationMovieSourceButton, "automationMovieSourceDirectory");
  bindDirectoryPicker(settingsAutomationMovieMirrorButton, "automationMovieMirrorDirectory");

  settingsSaveButton.addEventListener("click", () => {
    void saveSettings();
  });

  settingsResetButton.addEventListener("click", () => {
    state.settingsDraft = { ...state.settings };
    setMessage("Unsaved changes discarded.");
  });

  repairShowFolderButton.addEventListener("click", async () => {
    const selected = await window.folderBot.pickOutputDirectories();
    if (selected.length === 0) {
      return;
    }

    const existing = new Set(state.repairShowFolderPaths);
    const added = selected.filter((folderPath) => !existing.has(folderPath));

    if (added.length === 0) {
      setMessage("Those folders are already in the list.");
      return;
    }

    state.repairShowFolderPaths = [...state.repairShowFolderPaths, ...added];
    setMessage(`Added ${added.length} folder${added.length === 1 ? "" : "s"}.`);
  });

  repairShowClearButton.addEventListener("click", () => {
    state.repairShowFolderPaths = [];
    setMessage("Repair list cleared.");
  });

  repairShowRunButton.addEventListener("click", () => {
    void runSeasonRepair();
  });

  repairShowFolderList.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }

    const button = target.closest<HTMLButtonElement>("[data-remove-folder]");
    const folderPath = button?.dataset.removeFolder;
    if (!folderPath) {
      return;
    }

    state.repairShowFolderPaths = state.repairShowFolderPaths.filter((entry) => entry !== folderPath);
    render();
  });

  matchSearchInput.addEventListener("input", () => {
    state.matchDialog.query = matchSearchInput.value;
    renderMatchDialog();
  });

  matchSearchInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void runMatchSearch();
    }
  });

  matchSearchButton.addEventListener("click", () => {
    void runMatchSearch();
  });

  matchResultList.addEventListener("click", (event) => {
    const key = findMatchKey(event.target);
    if (!key) {
      return;
    }

    state.matchDialog.selectedKey = key;
    state.matchDialog.hoveredKey = key;
    renderMatchDialog();
  });

  matchResultList.addEventListener("mouseover", (event) => {
    const key = findMatchKey(event.target);
    if (!key || key === state.matchDialog.hoveredKey) {
      return;
    }

    state.matchDialog.hoveredKey = key;
    renderMatchDetail();
  });

  matchApplyButton.addEventListener("click", () => {
    void confirmMatchSelection();
  });

  matchSkipButton.addEventListener("click", () => {
    void advanceMatchQueue();
  });

  matchCloseButton.addEventListener("click", () => {
    closeMatchDialog();
  });

  matchScrim.addEventListener("mousedown", (event) => {
    if (event.target === matchScrim) {
      closeMatchDialog();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") {
      return;
    }

    if (state.matchDialog.mode) {
      closeMatchDialog();
      return;
    }

    if (state.view !== "workspace") {
      setView("workspace");
    }
  });
}

function bindSettingsInput(element: HTMLInputElement, apply: (value: string) => void): void {
  element.addEventListener("input", () => {
    apply(element.value);
    renderSettingsFooter();
  });
}

function bindDirectoryPicker(button: HTMLButtonElement, key: keyof AppSettings): void {
  button.addEventListener("click", async () => {
    const directory = await window.folderBot.pickOutputDirectory();
    if (!directory) {
      return;
    }

    (state.settingsDraft[key] as string) = directory;
    render();
  });
}

// ------------------------------------------------------------------ actions

function setView(view: ViewName): void {
  state.view = view;

  if (view === "settings") {
    state.settingsDraft = { ...state.settings };
  }

  if (view === "history") {
    void loadHistory();
  }

  render();
}

function setMessage(message: string, tone: StatusTone = "neutral"): void {
  state.message = message;
  state.messageTone = tone;
  render();
}

function mergeFiles(paths: string[]): void {
  if (paths.length === 0) {
    return;
  }

  const before = state.filePaths.length;
  state.filePaths = Array.from(new Set([...state.filePaths, ...paths]));
  const added = state.filePaths.length - before;

  state.explicitSeriesMatches = {};
  state.selectedPath = state.selectedPath ?? state.filePaths[0] ?? null;

  setMessage(
    added === 0
      ? "Those files are already queued."
      : `${added} file${added === 1 ? "" : "s"} added.`
  );
}

function removeFile(filePath: string): void {
  state.filePaths = state.filePaths.filter((entry) => entry !== filePath);
  state.previews = state.previews.filter((preview) => preview.sourcePath !== filePath);
  delete state.explicitSeriesMatches[filePath];

  if (state.selectedPath === filePath) {
    state.selectedPath = state.filePaths[0] ?? null;
  }

  render();
}

async function refreshProviderStatuses(): Promise<void> {
  state.providerStatuses = await window.folderBot.getProviderStatuses(buildOptions());
}

// With an online source, confirm each distinct series once before building previews.
async function startMatch(): Promise<void> {
  if (state.filePaths.length === 0) {
    setMessage("Add files before matching.", "error");
    return;
  }

  const groups = state.sourceId === "local" ? [] : buildSeriesGroups();

  if (groups.length === 0) {
    await generatePreview();
    return;
  }

  state.matchDialog = {
    mode: "manual",
    groups,
    index: 0,
    sourceId: state.sourceId,
    query: groups[0].title,
    results: [],
    selectedKey: null,
    hoveredKey: null,
    searching: false
  };

  render();
  await runMatchSearch();
}

// Group queued episodes by the series title the parser found, so a full season is one prompt.
function buildSeriesGroups(): SeriesGroup[] {
  const groups = new Map<string, SeriesGroup>();

  for (const filePath of state.filePaths) {
    const parsed = parseMediaName(splitPath(filePath).name);
    if (parsed.kind !== "episode") {
      continue;
    }

    const title = state.manualTitle || toDisplayTitle(parsed.normalizedTitle);
    const key = title.toLowerCase();
    const existing = groups.get(key);

    if (existing) {
      existing.filePaths.push(filePath);
      continue;
    }

    groups.set(key, { key, title, filePaths: [filePath] });
  }

  return Array.from(groups.values());
}

async function runMatchSearch(): Promise<void> {
  const dialog = state.matchDialog;
  const query = dialog.query.trim();

  if (!dialog.mode || !query) {
    return;
  }

  if (dialog.sourceId === "local") {
    setMessage("Series search needs TMDb or TheTVDB.", "error");
    return;
  }

  dialog.searching = true;
  renderMatchDialog();

  try {
    dialog.results = await window.folderBot.searchAutomationSeries({
      sourceId: dialog.sourceId,
      query
    });
    dialog.selectedKey = dialog.results[0] ? buildMatchKey(dialog.results[0], 0) : null;
    dialog.hoveredKey = dialog.selectedKey;
  } catch (error) {
    dialog.results = [];
    setMessage(error instanceof Error ? `Search failed: ${error.message}` : "Search failed.", "error");
  } finally {
    dialog.searching = false;
    render();
  }
}

async function confirmMatchSelection(): Promise<void> {
  const dialog = state.matchDialog;
  const match = getActiveMatch();

  if (!dialog.mode || !match) {
    setMessage("Pick a series first.", "error");
    return;
  }

  if (dialog.mode === "repair") {
    await applyAutomationRepair(match);
    return;
  }

  const group = dialog.groups[dialog.index];
  if (group) {
    for (const filePath of group.filePaths) {
      state.explicitSeriesMatches[filePath] = match;
    }
  }

  await advanceMatchQueue();
}

// Move to the next series that needs confirming, or run the preview once they are all answered.
async function advanceMatchQueue(): Promise<void> {
  const dialog = state.matchDialog;

  if (dialog.mode !== "manual") {
    closeMatchDialog();
    return;
  }

  if (dialog.index < dialog.groups.length - 1) {
    dialog.index += 1;
    dialog.query = dialog.groups[dialog.index].title;
    dialog.results = [];
    dialog.selectedKey = null;
    dialog.hoveredKey = null;
    render();
    await runMatchSearch();
    return;
  }

  dialog.mode = null;
  render();
  await generatePreview();
}

function closeMatchDialog(): void {
  const wasManual = state.matchDialog.mode === "manual";
  state.matchDialog.mode = null;
  state.matchDialog.groups = [];
  state.matchDialog.results = [];
  state.matchDialog.selectedKey = null;
  state.matchDialog.hoveredKey = null;

  if (wasManual) {
    state.explicitSeriesMatches = {};
    setMessage("Series confirmation cancelled. Nothing was renamed.");
    return;
  }

  render();
}

async function generatePreview(): Promise<void> {
  if (state.filePaths.length === 0) {
    setMessage("Add files before matching.", "error");
    return;
  }

  state.busy = true;
  setMessage("Reading filenames and building new names...");

  try {
    state.previews = await window.folderBot.previewRenames({
      filePaths: state.filePaths,
      options: buildOptions()
    });

    const issueCount = state.previews.reduce(
      (count, item) => count + item.warnings.length + item.conflicts.length,
      0
    );

    state.busy = false;
    setMessage(
      issueCount > 0
        ? `${state.previews.length} matched, ${issueCount} note${issueCount === 1 ? "" : "s"} to review.`
        : `${state.previews.length} file${state.previews.length === 1 ? "" : "s"} ready to rename.`,
      issueCount > 0 ? "neutral" : "success"
    );
  } catch (error) {
    state.busy = false;
    setMessage(error instanceof Error ? `Match failed: ${error.message}` : "Match failed.", "error");
  }
}

async function applyRenameBatch(): Promise<void> {
  if (state.previews.length === 0) {
    setMessage("Match the files first so there is something to rename.", "error");
    return;
  }

  state.busy = true;
  setMessage("Renaming files...");

  try {
    const results = await window.folderBot.applyRenames({
      items: state.previews,
      sourceId: state.sourceId
    });

    const failed = results.filter((result) => !result.success);
    const succeeded = results.length - failed.length;

    state.filePaths = failed.map((result) => result.sourcePath);
    state.previews = state.previews.filter((item) => state.filePaths.includes(item.sourcePath));
    state.selectedPath = state.filePaths[0] ?? null;
    state.explicitSeriesMatches = {};
    await loadHistory();

    state.busy = false;
    setMessage(
      failed.length > 0
        ? `${succeeded} renamed, ${failed.length} failed${failed[0]?.error ? `: ${failed[0].error}` : "."}`
        : `Renamed ${results.length} file${results.length === 1 ? "" : "s"}.`,
      failed.length > 0 ? "error" : "success"
    );
  } catch (error) {
    state.busy = false;
    setMessage(error instanceof Error ? `Rename failed: ${error.message}` : "Rename failed.", "error");
  }
}

async function saveSettings(): Promise<void> {
  state.busy = true;
  setMessage("Saving settings...");

  try {
    state.settings = await window.folderBot.saveSettings(state.settingsDraft);
    state.settingsDraft = { ...state.settings };
    await refreshProviderStatuses();
    state.busy = false;
    setMessage("Settings saved.", "success");
  } catch (error) {
    state.busy = false;
    setMessage(error instanceof Error ? `Could not save: ${error.message}` : "Could not save settings.", "error");
  }
}

async function runSeasonRepair(): Promise<void> {
  if (state.repairShowFolderPaths.length === 0) {
    setMessage("Choose at least one folder first.", "error");
    return;
  }

  state.busy = true;
  setMessage("Moving episodes into season folders...");

  try {
    const results = await window.folderBot.repairSeasonPlacement(state.repairShowFolderPaths);
    const movedCount = results.reduce(
      (sum, result) => sum + result.locations.reduce((inner, location) => inner + location.movedCount, 0),
      0
    );
    const errorCount = results.reduce(
      (sum, result) => sum + result.locations.reduce((inner, location) => inner + location.errors.length, 0),
      0
    );

    state.busy = false;
    setMessage(
      errorCount > 0
        ? `Repaired ${results.length} show${results.length === 1 ? "" : "s"}, moved ${movedCount} file${movedCount === 1 ? "" : "s"}, ${errorCount} error${errorCount === 1 ? "" : "s"}.`
        : `Repaired ${results.length} show${results.length === 1 ? "" : "s"} and moved ${movedCount} file${movedCount === 1 ? "" : "s"}.`,
      errorCount > 0 ? "error" : "success"
    );
  } catch (error) {
    state.busy = false;
    setMessage(error instanceof Error ? `Repair failed: ${error.message}` : "Repair failed.", "error");
  }
}

async function handleHistoryClick(event: Event): Promise<void> {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }

  const undoAutomation = target.closest<HTMLButtonElement>("[data-undo-automation]")?.dataset.undoAutomation;
  if (undoAutomation) {
    await undoAutomationEntry(undoAutomation);
    return;
  }

  const fixAutomation = target.closest<HTMLButtonElement>("[data-fix-automation]")?.dataset.fixAutomation;
  if (fixAutomation) {
    openAutomationRepair(fixAutomation);
    return;
  }

  const selectAll = target.closest<HTMLButtonElement>("[data-select-all]")?.dataset.selectAll;
  if (selectAll) {
    const entry = state.historyEntries.find((item) => item.id === selectAll);
    if (!entry) {
      return;
    }

    const pendingIds = entry.items.filter((item) => !item.undoneAt).map((item) => item.id);
    const selected = state.historySelection[selectAll] ?? [];
    state.historySelection[selectAll] = selected.length === pendingIds.length ? [] : pendingIds;
    render();
    return;
  }

  const undoButton = target.closest<HTMLButtonElement>("[data-undo-entry]");
  const entryId = undoButton?.dataset.undoEntry;
  const mode = undoButton?.dataset.undoMode;

  if (entryId && mode) {
    await undoHistoryEntry(entryId, mode === "selected" ? state.historySelection[entryId] ?? [] : undefined);
  }
}

function handleHistoryChange(event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || target.type !== "checkbox") {
    return;
  }

  const automationEntryId = target.dataset.automationEntryId;
  if (automationEntryId) {
    const selected = new Set(state.automationHistorySelection);
    target.checked ? selected.add(automationEntryId) : selected.delete(automationEntryId);
    state.automationHistorySelection = Array.from(selected);
    render();
    return;
  }

  const entryId = target.dataset.entryId;
  const itemId = target.dataset.itemId;
  if (!entryId || !itemId) {
    return;
  }

  const selected = new Set(state.historySelection[entryId] ?? []);
  target.checked ? selected.add(itemId) : selected.delete(itemId);
  state.historySelection[entryId] = Array.from(selected);
  render();
}

async function undoHistoryEntry(entryId: string, itemIds?: string[]): Promise<void> {
  state.busy = true;
  setMessage("Putting files back...");

  try {
    const result = await window.folderBot.undoRenameHistoryEntry({
      entryId,
      itemIds: itemIds && itemIds.length > 0 ? itemIds : undefined
    });
    const failed = result.results.filter((entry) => !entry.success);
    const succeeded = result.results.length - failed.length;

    await loadHistory();
    state.busy = false;
    setMessage(
      failed.length > 0
        ? `${succeeded} restored, ${failed.length} could not be put back.`
        : `Restored ${result.results.length} file${result.results.length === 1 ? "" : "s"}.`,
      failed.length > 0 ? "error" : "success"
    );
  } catch (error) {
    state.busy = false;
    setMessage(error instanceof Error ? `Undo failed: ${error.message}` : "Undo failed.", "error");
  }
}

async function undoAutomationEntry(entryId: string): Promise<void> {
  state.busy = true;
  setMessage("Returning the file to the inbox...");

  try {
    const result = await window.folderBot.undoAutomationHistoryEntry(entryId);
    const failed = result.results.filter((entry) => !entry.success);

    await loadHistory();
    state.busy = false;
    setMessage(
      failed.length > 0
        ? `Undo finished with ${failed.length} failed step${failed.length === 1 ? "" : "s"}.`
        : "File returned to the inbox. The watcher will leave it alone until it changes.",
      failed.length > 0 ? "error" : "success"
    );
  } catch (error) {
    state.busy = false;
    setMessage(error instanceof Error ? `Undo failed: ${error.message}` : "Undo failed.", "error");
  }
}

function openAutomationRepair(entryId: string): void {
  const entry = state.automationHistoryEntries.find((item) => item.id === entryId);
  if (!entry) {
    return;
  }

  state.automationHistorySelection = [entryId];
  const parsed = parseMediaName(splitPath(entry.originalInboxPath).name);

  state.matchDialog = {
    mode: "repair",
    groups: [{ key: entryId, title: entry.displayTitle, filePaths: [entry.sourceLibraryPath] }],
    index: 0,
    sourceId: entry.sourceId === "local" ? state.settings.automationSourceId : entry.sourceId,
    query: toDisplayTitle(parsed.normalizedTitle) || entry.displayTitle,
    results: [],
    selectedKey: null,
    hoveredKey: null,
    searching: false
  };

  render();
  void runMatchSearch();
}

async function applyAutomationRepair(match: ProviderSeriesSearchMatch): Promise<void> {
  const entryIds = state.automationHistorySelection;

  if (entryIds.length === 0) {
    setMessage("Nothing selected to repair.", "error");
    return;
  }

  state.busy = true;
  setMessage("Renaming and moving the files to the new show...");

  try {
    const result = await window.folderBot.repairAutomationHistoryEntries({ entryIds, match });
    const failedCount = result.results.filter((entry) => !entry.success).length;

    state.matchDialog.mode = null;
    state.automationHistorySelection = [];
    await loadHistory();
    state.busy = false;
    setMessage(
      failedCount > 0
        ? `Repaired ${result.updatedCount} item${result.updatedCount === 1 ? "" : "s"}, ${failedCount} failed.`
        : `Repaired ${result.updatedCount} item${result.updatedCount === 1 ? "" : "s"}.`,
      failedCount > 0 ? "error" : "success"
    );
  } catch (error) {
    state.busy = false;
    setMessage(error instanceof Error ? `Repair failed: ${error.message}` : "Repair failed.", "error");
  }
}

// Reload both history views from disk after any rename, undo, or repair action.
async function loadHistory(): Promise<void> {
  state.historyEntries = await window.folderBot.getRenameHistory();
  state.automationHistoryEntries = await window.folderBot.getAutomationHistory();

  state.historySelection = Object.fromEntries(
    state.historyEntries.map((entry) => [
      entry.id,
      (state.historySelection[entry.id] ?? []).filter((itemId) =>
        entry.items.some((item) => item.id === itemId && !item.undoneAt)
      )
    ])
  );

  state.automationHistorySelection = state.automationHistorySelection.filter((entryId) =>
    state.automationHistoryEntries.some((entry) => entry.id === entryId && !entry.undoneAt)
  );

  render();
}

// ------------------------------------------------------------------ rendering

function render(): void {
  workspaceView.hidden = state.view !== "workspace";
  historyView.hidden = state.view !== "history";
  settingsView.hidden = state.view !== "settings";
  helpView.hidden = state.view !== "help";

  for (const item of navItems) {
    const isCurrent = item.dataset.view === state.view;
    item.setAttribute("aria-current", isCurrent ? "page" : "false");
  }

  renderWatcherChip();
  renderToolbar();
  renderQueue();
  renderInspector();
  renderStatusLine();
  renderHistory();
  renderSettings();
  renderMatchDialog();
  renderDropOverlay();
}

function renderDropOverlay(): void {
  dropOverlay.hidden = state.dragDepth === 0;
}

function renderWatcherChip(): void {
  const status = state.automationStatus;

  if (!status.enabled) {
    watcherChip.className = "chip";
    watcherChip.innerHTML = `${icon("robot")}Watcher off`;
    return;
  }

  if (status.processing) {
    watcherChip.className = "chip chip-accent";
    watcherChip.innerHTML = `${icon("arrowsClockwise")}Filing ${status.pendingCount || 1}`;
    return;
  }

  if (status.watching) {
    watcherChip.className = "chip chip-success chip-dot";
    watcherChip.textContent = status.pendingCount > 0 ? `Watching · ${status.pendingCount} waiting` : "Watching";
    return;
  }

  watcherChip.className = "chip chip-warning";
  watcherChip.innerHTML = `${icon("warningCircle")}Watcher needs folders`;
}

function renderToolbar(): void {
  setSelectValue(sourceSelect, state.sourceId);
  setInputValue(manualTitleInput, state.manualTitle);
  setInputValue(outputInput, state.outputDirectory);

  const provider = getProviderStatus(state.sourceId);
  const providerReady = state.sourceId === "local" || Boolean(provider?.ready);

  outputClearButton.hidden = state.outputDirectory.length === 0;
  addButton.disabled = state.busy;
  clearButton.disabled = state.busy || state.filePaths.length === 0;
  matchButton.disabled = state.busy || state.filePaths.length === 0 || !providerReady;
  applyButton.disabled = state.busy || state.previews.length === 0;
  outputButton.disabled = state.busy;

  matchButton.classList.toggle("is-busy", state.busy && state.previews.length === 0);
  applyButton.classList.toggle("is-busy", state.busy && state.previews.length > 0);
}

function renderQueue(): void {
  if (state.filePaths.length === 0) {
    queueHead.hidden = true;
    queueBody.innerHTML = `
      <button id="queueDropzone" class="dropzone" type="button">
        <span class="dropzone-art">${icon("folderPlus")}</span>
        <span class="dropzone-title">Drop episodes or movies here</span>
        <span class="dropzone-copy">FolderBot reads the season and episode numbers out of each filename, then builds a clean name you can review before anything is written.</span>
        <span class="dropzone-formats">${MEDIA_EXTENSIONS}</span>
      </button>
    `;
    return;
  }

  queueHead.hidden = false;
  queueBody.innerHTML = state.filePaths
    .map((filePath, index) => {
      const parts = splitPath(filePath);
      const preview = findPreview(filePath);
      const parsed = preview?.parsed ?? parseMediaName(parts.name);
      const hasIssue = (preview?.conflicts.length ?? 0) > 0;
      const rowClass = [
        "queue-row",
        filePath === state.selectedPath ? "is-selected" : "",
        preview ? (hasIssue ? "is-issue" : "is-ready") : ""
      ]
        .filter(Boolean)
        .join(" ");

      return `
        <div class="${rowClass}" data-path="${escapeHtml(filePath)}" role="button" tabindex="0">
          <span class="queue-index">${String(index + 1).padStart(2, "0")}</span>

          <span class="queue-cell">
            <span class="queue-name" title="${escapeHtml(parts.name)}">${escapeHtml(parts.name)}</span>
            <span class="queue-meta">${escapeHtml(buildDetectedLabel(parsed))}</span>
          </span>

          <span class="queue-arrow">${icon(preview ? (hasIssue ? "warningCircle" : "arrowRight") : "arrowRight")}</span>

          <span class="queue-cell">
            <span class="queue-name${preview ? "" : " queue-name-pending"}" title="${escapeHtml(preview?.targetName ?? "")}">${escapeHtml(preview?.targetName || "Not matched yet")}</span>
            <span class="queue-meta">${escapeHtml(buildResultLabel(preview))}</span>
          </span>

          <button class="btn btn-ghost btn-icon btn-sm queue-remove" type="button" data-remove-path="${escapeHtml(filePath)}" aria-label="Remove ${escapeHtml(parts.name)}">${icon("x")}</button>
        </div>
      `;
    })
    .join("");
}

function renderInspector(): void {
  const selectedPath = state.selectedPath ?? state.filePaths[0];

  if (!selectedPath) {
    inspectDetected.textContent = "Nothing selected";
    inspectDetectedPath.textContent = state.filePaths.length === 0 ? "Add files to begin" : "Select a row";
    inspectMatch.textContent = "—";
    inspectMatchDetail.textContent = "—";
    inspectNotes.textContent = "—";
    inspectNotesDetail.textContent = "—";
    return;
  }

  const preview = findPreview(selectedPath);
  const parsed = preview?.parsed ?? parseMediaName(splitPath(selectedPath).name);
  const notes = preview ? [...preview.warnings, ...preview.conflicts] : parsed.warnings;

  inspectDetected.textContent = buildDetectedLabel(parsed);
  inspectDetectedPath.textContent = selectedPath;
  inspectMatch.textContent = preview?.metadata?.displayTitle || "Not matched yet";
  inspectMatchDetail.textContent = preview?.targetPath || "Run Match to build the new name";
  inspectNotes.textContent = notes.length > 0 ? `${notes.length} to review` : "Nothing to flag";
  inspectNotesDetail.textContent = notes[0] || "This file is ready to rename.";
}

function renderStatusLine(): void {
  const glyph =
    state.messageTone === "error"
      ? icon("warningCircle")
      : state.messageTone === "success"
        ? icon("checkCircle")
        : "";

  statusLine.className = `status-line${state.messageTone === "error" ? " is-error" : state.messageTone === "success" ? " is-success" : ""}`;
  statusLine.innerHTML = `${glyph}<span>${escapeHtml(state.message)}</span>`;
}

function renderHistory(): void {
  historyTabManual.setAttribute("aria-selected", String(state.historyTab === "manual"));
  historyTabAutomation.setAttribute("aria-selected", String(state.historyTab === "automation"));
  setInputValue(historySearch, state.historyQuery);
  historyRefreshButton.disabled = state.busy;

  const query = state.historyQuery.trim().toLowerCase();
  historyList.innerHTML =
    state.historyTab === "manual" ? renderManualHistory(query) : renderAutomationHistory(query);
}

function renderManualHistory(query: string): string {
  const entries = state.historyEntries.filter((entry) =>
    query
      ? entry.items.some(
          (item) =>
            splitPath(item.sourcePath).name.toLowerCase().includes(query) ||
            splitPath(item.targetPath).name.toLowerCase().includes(query)
        )
      : true
  );

  if (entries.length === 0) {
    return emptyState(
      "clockCounterClockwise",
      state.historyEntries.length === 0 ? "No renames yet" : "No matching batches",
      state.historyEntries.length === 0
        ? "Every batch you rename is recorded here so you can put the files back."
        : "Try a different search term."
    );
  }

  return entries
    .map((entry) => {
      const pendingItems = entry.items.filter((item) => !item.undoneAt);
      const selectedIds = state.historySelection[entry.id] ?? [];
      const selectedCount = pendingItems.filter((item) => selectedIds.includes(item.id)).length;
      const allSelected = pendingItems.length > 0 && selectedCount === pendingItems.length;

      return `
        <article class="history-entry">
          <div class="history-entry-head">
            <div class="history-entry-title">
              <strong>${entry.itemCount} file${entry.itemCount === 1 ? "" : "s"} renamed</strong>
              <span>${escapeHtml(formatTimestamp(entry.createdAt))} · ${escapeHtml(SOURCE_LABELS[entry.sourceId] ?? entry.sourceId)}</span>
            </div>
            <span class="chip ${pendingItems.length === 0 ? "" : "chip-success"}">${pendingItems.length === 0 ? "All undone" : `${pendingItems.length} in place`}</span>
            <div class="history-entry-actions">
              <button class="btn btn-ghost btn-sm" type="button" data-select-all="${escapeHtml(entry.id)}" ${pendingItems.length === 0 ? "disabled" : ""}>${allSelected ? "Clear selection" : "Select all"}</button>
              <button class="btn btn-secondary btn-sm" type="button" data-undo-entry="${escapeHtml(entry.id)}" data-undo-mode="selected" ${selectedCount === 0 ? "disabled" : ""}>Undo${selectedCount > 0 ? ` ${selectedCount}` : " selected"}</button>
              <button class="btn btn-secondary btn-sm" type="button" data-undo-entry="${escapeHtml(entry.id)}" data-undo-mode="all" ${pendingItems.length === 0 ? "disabled" : ""}>Undo all</button>
            </div>
          </div>
          <div class="history-items">
            ${entry.items
              .map(
                (item) => `
                  <label class="history-item${item.undoneAt ? " is-undone" : ""}">
                    <input class="checkbox" type="checkbox" data-entry-id="${escapeHtml(entry.id)}" data-item-id="${escapeHtml(item.id)}" ${selectedIds.includes(item.id) ? "checked" : ""} ${item.undoneAt ? "disabled" : ""} />
                    <span class="history-item-name" title="${escapeHtml(item.sourcePath)}">${escapeHtml(splitPath(item.sourcePath).name)}</span>
                    <span class="history-item-arrow">${icon("arrowRight")}</span>
                    <span class="history-item-name" title="${escapeHtml(item.targetPath)}">${escapeHtml(splitPath(item.targetPath).name)}</span>
                    <span class="history-item-tag">${item.undoneAt ? "Undone" : "Renamed"}</span>
                  </label>
                `
              )
              .join("")}
          </div>
        </article>
      `;
    })
    .join("");
}

function renderAutomationHistory(query: string): string {
  const entries = state.automationHistoryEntries.filter((entry) =>
    query
      ? entry.displayTitle.toLowerCase().includes(query) ||
        splitPath(entry.originalInboxPath).name.toLowerCase().includes(query)
      : true
  );

  if (entries.length === 0) {
    return emptyState(
      "robot",
      state.automationHistoryEntries.length === 0 ? "The watcher has not filed anything yet" : "No matching items",
      state.automationHistoryEntries.length === 0
        ? "Turn on the watcher in Settings and point it at your inbox folder. Everything it files shows up here."
        : "Try a different search term."
    );
  }

  return entries
    .map((entry) => {
      const isEpisode = entry.mediaKind === "episode";

      return `
        <article class="history-entry">
          <div class="history-entry-head">
            <div class="history-entry-title">
              <strong>${escapeHtml(entry.displayTitle)}</strong>
              <span>${escapeHtml(formatTimestamp(entry.createdAt))} · ${isEpisode ? "Episode" : "Movie"} · ${escapeHtml(SOURCE_LABELS[entry.sourceId] ?? entry.sourceId)}</span>
            </div>
            <span class="chip ${entry.undoneAt ? "" : "chip-success"}">${entry.undoneAt ? "Undone" : "Filed"}</span>
            <div class="history-entry-actions">
              <button class="btn btn-ghost btn-sm" type="button" data-fix-automation="${escapeHtml(entry.id)}" ${entry.undoneAt || !isEpisode ? "disabled" : ""} title="${isEpisode ? "Pick the correct show and move the files" : "Only episodes can be re-matched"}">${icon("wrench")}Fix show</button>
              <button class="btn btn-secondary btn-sm" type="button" data-undo-automation="${escapeHtml(entry.id)}" ${entry.undoneAt ? "disabled" : ""}>Undo</button>
            </div>
          </div>
          <div class="history-items">
            ${[
              { label: "From inbox", path: entry.originalInboxPath },
              { label: "Source library", path: entry.sourceLibraryPath },
              { label: "Mirror library", path: entry.mirrorLibraryPath }
            ]
              .map(
                (row) => `
                  <div class="history-item${entry.undoneAt ? " is-undone" : ""}">
                    <span class="history-item-label">${row.label}</span>
                    <span class="history-item-name" title="${escapeHtml(row.path)}">${escapeHtml(splitPath(row.path).name)}</span>
                    <span class="history-item-arrow"></span>
                    <span class="history-item-name" title="${escapeHtml(row.path)}">${escapeHtml(splitPath(row.path).directory || row.path)}</span>
                    <span class="history-item-tag"></span>
                  </div>
                `
              )
              .join("")}
          </div>
        </article>
      `;
    })
    .join("");
}

function renderSettings(): void {
  for (const tab of settingsTabs) {
    tab.setAttribute("aria-selected", String(tab.dataset.tab === state.settingsTab));
  }

  for (const panel of settingsPanels) {
    panel.hidden = panel.dataset.panel !== state.settingsTab;
  }

  const draft = state.settingsDraft;
  settingsLaunchAtLogin.checked = draft.launchAtLogin;
  setInputValue(settingsLanguage, draft.defaultLanguage);
  setInputValue(settingsTmdbToken, draft.tmdbBearerToken);
  setInputValue(settingsTvdbApiKey, draft.tvdbApiKey);
  setInputValue(settingsTvdbPin, draft.tvdbPin);
  settingsAutomationEnabled.checked = draft.automationEnabled;
  setInputValue(settingsAutomationInboxDirectory, draft.automationInboxDirectory);
  setInputValue(settingsAutomationSourceLibraryDirectory, draft.automationSourceLibraryDirectory);
  setInputValue(settingsAutomationMirrorLibraryDirectory, draft.automationMirrorLibraryDirectory);
  setInputValue(settingsAutomationMovieSourceDirectory, draft.automationMovieSourceDirectory);
  setInputValue(settingsAutomationMovieMirrorDirectory, draft.automationMovieMirrorDirectory);
  setSelectValue(settingsAutomationSource, draft.automationSourceId);
  setInputValue(settingsAutomationSettleSeconds, String(draft.automationSettleSeconds));

  const tmdb = getProviderStatus("tmdb");
  const tvdb = getProviderStatus("tvdb");
  settingsTmdbStatus.textContent = tmdb?.details ?? "";
  settingsTvdbStatus.textContent = tvdb?.details ?? "";
  renderReadyChip(settingsTmdbChip, tmdb);
  renderReadyChip(settingsTvdbChip, tvdb);

  renderAutomationStatus();
  renderRepairFolders();
  renderAbout();
  renderSettingsFooter();
}

function renderReadyChip(element: HTMLSpanElement, status?: ProviderStatus): void {
  element.className = status?.ready ? "chip chip-success" : "chip";
  element.textContent = status?.ready ? "Connected" : "Not configured";
}

function renderSettingsFooter(): void {
  const isDirty = JSON.stringify(state.settings) !== JSON.stringify(state.settingsDraft);

  settingsFooterNote.textContent = isDirty
    ? "You have unsaved changes."
    : "Everything here is saved on this machine.";
  settingsSaveButton.disabled = state.busy || !isDirty;
  settingsResetButton.disabled = state.busy || !isDirty;
  settingsSaveButton.classList.toggle("is-busy", state.busy);
  settingsNavFooter.textContent = isDirty ? "Unsaved changes" : "";
}

function renderAutomationStatus(): void {
  const status = state.automationStatus;

  const cells: [string, string][] = [
    ["Watcher", status.enabled ? "Enabled" : "Disabled"],
    ["Inbox", status.watching ? "Watching" : "Not watching"],
    ["Right now", status.processing ? "Filing a file" : "Idle"],
    ["Waiting to settle", String(status.pendingCount)]
  ];

  automationStatusGrid.innerHTML = cells
    .map(
      ([label, value]) => `
        <div class="status-cell">
          <span class="status-cell-label">${label}</span>
          <span class="status-cell-value">${escapeHtml(value)}</span>
        </div>
      `
    )
    .join("");

  const paths: [string, string][] = [
    ["Inbox", status.inboxDirectory],
    ["TV source", status.sourceLibraryDirectory],
    ["TV mirror", status.mirrorLibraryDirectory],
    ["Movie source", status.movieSourceDirectory],
    ["Movie mirror", status.movieMirrorDirectory]
  ];

  automationPaths.innerHTML = paths
    .map(
      ([label, value]) => `
        <div class="path-row">
          <dt>${label}</dt>
          <dd class="${value ? "" : "is-unset"}">${escapeHtml(value || "Not set")}</dd>
        </div>
      `
    )
    .join("");

  automationEvents.innerHTML =
    status.recentEvents.length > 0
      ? status.recentEvents
          .map(
            (event) => `
              <li>
                <time>${escapeHtml(formatTime(event.createdAt))}</time>
                <span>${escapeHtml(event.message)}</span>
              </li>
            `
          )
          .join("")
      : `<li><time>—</time><span>Nothing yet. Events appear here as the watcher works.</span></li>`;
}

function renderRepairFolders(): void {
  repairShowClearButton.disabled = state.busy || state.repairShowFolderPaths.length === 0;
  repairShowRunButton.disabled = state.busy || state.repairShowFolderPaths.length === 0;
  repairShowFolderButton.disabled = state.busy;
  repairShowRunButton.classList.toggle("is-busy", state.busy);

  if (state.repairShowFolderPaths.length === 0) {
    repairShowFolderList.innerHTML = `<p class="field-hint">No folders chosen yet. Pick the show folders you want tidied up.</p>`;
    return;
  }

  repairShowFolderList.innerHTML = `
    <div class="folder-list">
      ${state.repairShowFolderPaths
        .map(
          (folderPath) => `
            <div class="folder-item">
              <span class="folder-item-copy">
                <strong>${escapeHtml(splitPath(folderPath).name)}</strong>
                <span>${escapeHtml(folderPath)}</span>
              </span>
              <button class="btn btn-ghost btn-icon btn-sm" type="button" data-remove-folder="${escapeHtml(folderPath)}" aria-label="Remove ${escapeHtml(splitPath(folderPath).name)}">${icon("x")}</button>
            </div>
          `
        )
        .join("")}
    </div>
  `;
}

function renderAbout(): void {
  aboutList.innerHTML = [
    ["Version", APP_VERSION],
    ["Metadata sources", "Local parser, TMDb, TheTVDB"],
    ["Icons", "Phosphor Icons, MIT licensed"]
  ]
    .map(
      ([label, value]) => `
        <div>
          <dt>${label}</dt>
          <dd>${escapeHtml(value)}</dd>
        </div>
      `
    )
    .join("");
}

function renderMatchDialog(): void {
  const dialog = state.matchDialog;
  matchScrim.hidden = dialog.mode === null;

  if (!dialog.mode) {
    return;
  }

  const group = dialog.groups[dialog.index];
  const isManual = dialog.mode === "manual";

  matchDialogTitle.textContent = isManual ? "Confirm the series" : "Pick the correct show";
  matchDialogSubtitle.textContent = isManual
    ? `${dialog.index + 1} of ${dialog.groups.length} · ${group?.filePaths.length ?? 0} file${(group?.filePaths.length ?? 0) === 1 ? "" : "s"} detected as "${group?.title ?? ""}"`
    : `Renames and moves the filed copies in both libraries`;
  matchProviderName.textContent = SOURCE_LABELS[dialog.sourceId] ?? dialog.sourceId;
  matchFootNote.textContent = isManual
    ? "Your choice applies to every file in this group."
    : "The source and mirror copies are both updated.";
  matchSkipButton.hidden = !isManual;

  setInputValue(matchSearchInput, dialog.query);
  matchSearchButton.disabled = dialog.searching || dialog.query.trim().length === 0;
  matchSearchButton.classList.toggle("is-busy", dialog.searching);
  matchApplyButton.disabled = state.busy || dialog.searching || !getActiveMatch();
  matchApplyButton.classList.toggle("is-busy", state.busy);

  renderMatchResults();
  renderMatchDetail();
}

function renderMatchResults(): void {
  const dialog = state.matchDialog;

  if (dialog.searching) {
    matchResultList.innerHTML = emptyState("magnifyingGlass", "Searching...", "Looking up matching shows.");
    return;
  }

  if (dialog.results.length === 0) {
    matchResultList.innerHTML = emptyState(
      "magnifyingGlass",
      "No results",
      dialog.query.trim() ? "Try a shorter or more exact title." : "Type a show title and search."
    );
    return;
  }

  matchResultList.innerHTML = dialog.results
    .map((match, index) => {
      const key = buildMatchKey(match, index);
      return `
        <button class="result-item" type="button" role="option" aria-selected="${key === dialog.selectedKey}" data-match-key="${escapeHtml(key)}">
          <strong>${escapeHtml(match.title)}</strong>
          <span>${escapeHtml(match.year ? String(match.year) : "—")}</span>
        </button>
      `;
    })
    .join("");
}

function renderMatchDetail(): void {
  const match = getActiveMatch();

  if (!match) {
    matchDetailCard.innerHTML = emptyState(
      "eye",
      "No series selected",
      "Pick a result to see its year and summary before you commit."
    );
    return;
  }

  matchDetailCard.innerHTML = `
    <div>
      <h3>${escapeHtml(match.title)}</h3>
      <div class="detail-card-meta">
        <span class="chip">${escapeHtml(match.year ? String(match.year) : "Year unknown")}</span>
        <span class="chip">${escapeHtml(SOURCE_LABELS[match.sourceId] ?? match.sourceId)}</span>
      </div>
    </div>
    <p>${escapeHtml(match.summary || "This provider has no summary for the show.")}</p>
  `;
}

// ------------------------------------------------------------------ helpers

function emptyState(iconName: Parameters<typeof icon>[0], title: string, copy: string): string {
  return `
    <div class="empty">
      <span class="empty-art">${icon(iconName)}</span>
      <span class="empty-title">${escapeHtml(title)}</span>
      <span class="empty-copy">${escapeHtml(copy)}</span>
    </div>
  `;
}

function findMatchKey(target: EventTarget | null): string | undefined {
  if (!(target instanceof Element)) {
    return undefined;
  }

  return target.closest<HTMLElement>("[data-match-key]")?.dataset.matchKey;
}

// Several results can share a provider ID, so rows are keyed by position as well.
function buildMatchKey(match: ProviderSeriesSearchMatch, index: number): string {
  return `${match.sourceId}:${match.providerSeriesId}:${match.year ?? ""}:${index}`;
}

function getActiveMatch(): ProviderSeriesSearchMatch | undefined {
  const dialog = state.matchDialog;
  const activeKey = dialog.selectedKey ?? dialog.hoveredKey;

  if (!activeKey) {
    return undefined;
  }

  return dialog.results.find((match, index) => buildMatchKey(match, index) === activeKey);
}

function buildDetectedLabel(parsed: ParsedMedia): string {
  if (parsed.kind === "episode") {
    return `${formatEpisodeCode(parsed.season, parsed.episode, parsed.absoluteEpisode)} · ${toDisplayTitle(parsed.normalizedTitle)}`;
  }

  if (parsed.kind === "movie") {
    const details = [parsed.sourceTag, ...(parsed.videoTags ?? []), parsed.videoCodecTag, parsed.resolution]
      .filter(Boolean)
      .join(" · ");
    return `Movie · ${toDisplayTitle(parsed.normalizedTitle)}${parsed.year ? ` (${parsed.year})` : ""}${details ? ` · ${details}` : ""}`;
  }

  return `Not recognized · ${toDisplayTitle(parsed.normalizedTitle)}`;
}

function buildResultLabel(preview?: RenamePreview): string {
  if (!preview) {
    return "Waiting for Match";
  }

  const sourceLabel = SOURCE_LABELS[preview.metadata?.sourceId ?? "local"];
  const noteCount = preview.warnings.length + preview.conflicts.length;

  return noteCount > 0
    ? `${sourceLabel} · ${noteCount} note${noteCount === 1 ? "" : "s"}`
    : `${sourceLabel} · Ready`;
}

function findPreview(filePath: string): RenamePreview | undefined {
  return state.previews.find((item) => item.sourcePath === filePath);
}

function getProviderStatus(providerId: MetadataSourceId): ProviderStatus | undefined {
  return state.providerStatuses.find((status) => status.id === providerId);
}

function buildOptions(): PreviewRequest["options"] {
  return {
    sourceId: state.sourceId,
    tmdbToken: state.settings.tmdbBearerToken || undefined,
    tvdbApiKey: state.settings.tvdbApiKey || undefined,
    tvdbPin: state.settings.tvdbPin || undefined,
    language: state.settings.defaultLanguage,
    destinationDirectory: state.outputDirectory || undefined,
    manualTitle: state.manualTitle || undefined,
    explicitSeriesMatches:
      Object.keys(state.explicitSeriesMatches).length > 0 ? state.explicitSeriesMatches : undefined
  };
}

function splitPath(fullPath: string): { name: string; directory: string } {
  const parts = fullPath.split(/[\\/]/);
  return {
    name: parts.at(-1) ?? fullPath,
    directory: parts.slice(0, -1).join("/")
  };
}

function formatTimestamp(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// Writing to an input the user is typing in would move the caret, so focused fields are left alone.
function setInputValue(element: HTMLInputElement, value: string): void {
  if (document.activeElement === element || element.value === value) {
    return;
  }

  element.value = value;
}

function setSelectValue(element: HTMLSelectElement, value: string): void {
  if (element.value !== value) {
    element.value = value;
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);

  if (!element) {
    throw new Error(`Required element not found: ${selector}`);
  }

  return element;
}

async function getDroppedPaths(event: DragEvent): Promise<string[]> {
  const files = Array.from(event.dataTransfer?.files ?? []);
  const paths = files
    .map((file) => window.folderBot.getPathForFile(file))
    .filter((value): value is string => Boolean(value));

  return Array.from(new Set(paths));
}
