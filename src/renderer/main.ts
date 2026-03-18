import "./styles.css";
import { formatEpisodeCode, parseMediaName, toDisplayTitle } from "../shared/filename-parser";
import type {
  AppSettings,
  AutomationHistoryEntry,
  AutomationStatus,
  RepairShowResult,
  UndoAutomationHistoryResult,
  ApplyRenameRequest,
  MetadataSourceId,
  ParsedMedia,
  PreviewRequest,
  ProviderStatus,
  RenameHistoryEntry,
  RenamePreview,
  RenameResult
} from "../shared/types";

declare global {
  interface Window {
    folderBot: {
      pickFiles: () => Promise<string[]>;
      pickOutputDirectory: () => Promise<string | null>;
      getPathForFile: (file: File) => string | null;
      getSettings: () => Promise<AppSettings>;
      saveSettings: (payload: Partial<AppSettings>) => Promise<AppSettings>;
      getAutomationStatus: () => Promise<AutomationStatus>;
      repairSeasonPlacement: (selectedFolderPath: string) => Promise<RepairShowResult>;
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

interface AppState {
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
  repairShowFolderPath: string;
  historyEntries: RenameHistoryEntry[];
  automationHistoryEntries: AutomationHistoryEntry[];
  historySelection: Record<string, string[]>;
  historyTab: "manual" | "automation";
  modal: "none" | "settings" | "history" | "help";
  busy: boolean;
  message: string;
}

const DEFAULT_SETTINGS: AppSettings = {
  tmdbBearerToken: "",
  tvdbApiKey: "",
  tvdbPin: "",
  defaultLanguage: "en-US",
  automationEnabled: false,
  automationInboxDirectory: "",
  automationSourceLibraryDirectory: "",
  automationMirrorLibraryDirectory: "",
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
  sourceId: "tvdb",
  settleSeconds: 45,
  pendingCount: 0,
  recentEvents: []
};

const state: AppState = {
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
  repairShowFolderPath: "",
  historyEntries: [],
  automationHistoryEntries: [],
  historySelection: {},
  historyTab: "manual",
  modal: "none",
  busy: false,
  message: "Add files on the left, choose a source in the center, then match."
};

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("App root not found");
}

app.innerHTML = `
  <main class="app-shell">
    <header class="topbar">
      <div class="window-title">FolderBot</div>
      <p id="message" class="message"></p>
      <div class="status-inline">
        <span id="fileCount" class="count-pill"></span>
        <button id="historyButton" class="text-button" type="button">History</button>
        <button id="settingsButton" class="text-button" type="button">Settings</button>
        <button id="clearButton" class="text-button" type="button">Clear</button>
      </div>
    </header>

    <section id="workspaceView" class="view">
      <section class="workspace">
        <section class="pane pane-source">
          <header class="pane-header">
            <span class="pane-title">Original</span>
            <button id="importButton" class="quiet-button" type="button">Add files</button>
          </header>

          <button id="dropzone" class="dropzone" type="button">
            <span>Drop files here or click Add files</span>
          </button>

          <div id="sourceList" class="file-list empty-state"></div>
        </section>

        <aside class="action-rail">
          <span class="pane-title">Actions</span>

          <label class="control">
            <span>Source</span>
            <select id="sourceSelect">
              <option value="local">Local parser</option>
              <option value="tmdb">TMDb</option>
              <option value="tvdb">TheTVDB</option>
            </select>
          </label>

          <label class="control">
            <span>Title override</span>
            <input
              id="manualTitleInput"
              type="text"
              placeholder="Type the show title if the filename is messy"
            />
          </label>

          <button id="matchButton" class="action-primary" type="button">Match</button>
          <button id="applyButton" class="action-secondary" type="button">Rename</button>

          <p id="providerNote" class="provider-note"></p>

          <details class="advanced-panel">
            <summary>Options</summary>

            <label class="control compact">
              <span>Output folder</span>
              <div class="inline-control">
                <input id="outputInput" type="text" placeholder="Rename in place" readonly />
                <button id="outputButton" class="quiet-button" type="button">Choose</button>
              </div>
            </label>
          </details>
        </aside>

        <section class="pane pane-result">
          <header class="pane-header">
            <span class="pane-title">Renamed</span>
            <span id="resultCount" class="count-pill count-pill-subtle"></span>
          </header>

          <div id="resultList" class="file-list empty-state"></div>
        </section>
      </section>

      <section class="inspector">
        <div id="detailSummary" class="detail-summary empty-state">
          Select a file to inspect what was detected and what will change.
        </div>
      </section>
    </section>

    <section id="settingsView" class="overlay view-hidden">
      <section class="settings-page modal-panel" role="dialog" aria-modal="true" aria-labelledby="settingsTitle">
        <div class="settings-header">
          <span id="settingsTitle" class="pane-title">Settings</span>
          <button id="settingsBackButton" class="quiet-button" type="button">Close</button>
        </div>

        <div class="settings-grid">
          <section class="settings-section">
            <span class="pane-title">TMDb</span>
            <label class="control">
              <span>Token</span>
              <input id="settingsTmdbToken" type="password" placeholder="Paste a TMDb API Read Access Token" />
            </label>
            <p id="settingsTmdbStatus" class="provider-note"></p>
          </section>

          <section class="settings-section">
            <span class="pane-title">TheTVDB</span>
            <label class="control">
              <span>API key</span>
              <input id="settingsTvdbApiKey" type="password" placeholder="Store your TVDB API key here" />
            </label>
            <label class="control">
              <span>Subscriber PIN</span>
              <input id="settingsTvdbPin" type="password" placeholder="Optional, if your TVDB key requires a PIN" />
            </label>
            <p id="settingsTvdbStatus" class="provider-note"></p>
          </section>

          <section class="settings-section">
            <span class="pane-title">Defaults</span>
            <label class="control">
              <span>Language</span>
              <input id="settingsLanguage" type="text" placeholder="en-US" />
            </label>
            <p class="provider-note">This language is used for provider lookups from the main match screen.</p>
          </section>

          <section class="settings-section settings-section-wide">
            <span class="pane-title">Automation</span>
            <p class="provider-note">Manual renaming stays on the main screen. This section is only for the separate watcher workflow and currently supports TV episodes only.</p>
            <label class="control checkbox-control">
              <span>Enable watcher</span>
              <input id="settingsAutomationEnabled" type="checkbox" />
            </label>
            <label class="control">
              <span>Inbox folder</span>
              <div class="inline-control">
                <input id="settingsAutomationInboxDirectory" type="text" placeholder="Folder where downloads first land" readonly />
                <button id="settingsAutomationInboxButton" class="quiet-button" type="button">Choose</button>
              </div>
            </label>
            <label class="control">
              <span>Source library root</span>
              <div class="inline-control">
                <input id="settingsAutomationSourceLibraryDirectory" type="text" placeholder="Organized library on the source drive" readonly />
                <button id="settingsAutomationSourceLibraryButton" class="quiet-button" type="button">Choose</button>
              </div>
            </label>
            <label class="control">
              <span>Mirror library root</span>
              <div class="inline-control">
                <input id="settingsAutomationMirrorLibraryDirectory" type="text" placeholder="Matching library on the mirror drive" readonly />
                <button id="settingsAutomationMirrorLibraryButton" class="quiet-button" type="button">Choose</button>
              </div>
            </label>
            <div class="settings-inline-grid">
              <label class="control">
                <span>Source</span>
                <select id="settingsAutomationSource">
                  <option value="local">Local parser</option>
                  <option value="tmdb">TMDb</option>
                  <option value="tvdb">TheTVDB</option>
                </select>
              </label>
              <label class="control">
                <span>Settle seconds</span>
                <input id="settingsAutomationSettleSeconds" type="number" min="10" max="600" step="5" />
              </label>
            </div>
            <p class="provider-note">Flow: detect a completed TV episode in the inbox, rename it, copy it to the mirror library, then move it into the organized source library.</p>
            <div id="automationStatusPanel" class="automation-status-panel"></div>
            <div class="automation-repair-panel">
              <span class="pane-title">Repair Existing Show</span>
              <p class="provider-note">Pick one show folder once, then move misplaced episode files into the correct season folders in both the source and mirror libraries.</p>
              <label class="control">
                <span>Selected show folder</span>
                <div class="inline-control">
                  <input id="repairShowFolderInput" type="text" placeholder="Choose a show folder or one of its season folders" readonly />
                  <button id="repairShowFolderButton" class="quiet-button" type="button">Choose</button>
                </div>
              </label>
              <button id="repairShowRunButton" class="action-secondary" type="button">Repair season placement</button>
            </div>
          </section>
        </div>

        <div class="settings-actions">
          <button id="settingsSaveButton" class="action-primary" type="button">Save settings</button>
        </div>
      </section>
    </section>

    <section id="historyView" class="overlay view-hidden">
      <section class="history-page modal-panel" role="dialog" aria-modal="true" aria-labelledby="historyTitle">
        <div class="settings-header">
          <div class="history-header-copy">
            <span id="historyTitle" class="pane-title">History</span>
            <div class="history-tabs">
              <button id="historyTabManual" class="quiet-button" type="button">Manual</button>
              <button id="historyTabAutomation" class="quiet-button" type="button">Automation</button>
            </div>
          </div>
          <button id="historyBackButton" class="quiet-button" type="button">Close</button>
        </div>

        <div id="historyList" class="history-list empty-state">
          No rename batches recorded yet.
        </div>
      </section>
    </section>

    <section id="helpView" class="overlay view-hidden">
      <section class="help-page modal-panel" role="dialog" aria-modal="true" aria-labelledby="helpTitle">
        <div class="settings-header">
          <span id="helpTitle" class="pane-title">How To Use FolderBot</span>
          <button id="helpBackButton" class="quiet-button" type="button">Close</button>
        </div>

        <div class="help-copy">
          <p>1. Add files on the left by dragging them in or using <strong>Add files</strong>.</p>
          <p>2. Pick a metadata source in the center rail. Use <strong>Settings</strong> first if TMDb or TheTVDB needs credentials.</p>
          <p>3. If the filename is messy, type the real show title in <strong>Title override</strong>.</p>
          <p>4. Click <strong>Match</strong> to preview the renamed results on the right.</p>
          <p>5. Review the preview, then click <strong>Rename</strong> to apply the changes.</p>
          <p>6. Open <strong>History</strong> if you need to undo the whole batch or only selected items.</p>
          <p>Automation is configured separately in Settings. It currently watches TV episodes only, waits for a file to settle, renames it, copies it to the mirror library, then moves it into the organized source library.</p>
        </div>
      </section>
    </section>
  </main>
`;

const workspaceView = requireElement<HTMLElement>("#workspaceView");
const settingsView = requireElement<HTMLElement>("#settingsView");
const historyView = requireElement<HTMLElement>("#historyView");
const helpView = requireElement<HTMLElement>("#helpView");
const historyButton = requireElement<HTMLButtonElement>("#historyButton");
const historyBackButton = requireElement<HTMLButtonElement>("#historyBackButton");
const historyTabManual = requireElement<HTMLButtonElement>("#historyTabManual");
const historyTabAutomation = requireElement<HTMLButtonElement>("#historyTabAutomation");
const historyList = requireElement<HTMLDivElement>("#historyList");
const settingsButton = requireElement<HTMLButtonElement>("#settingsButton");
const settingsBackButton = requireElement<HTMLButtonElement>("#settingsBackButton");
const settingsSaveButton = requireElement<HTMLButtonElement>("#settingsSaveButton");
const settingsTmdbToken = requireElement<HTMLInputElement>("#settingsTmdbToken");
const settingsTvdbApiKey = requireElement<HTMLInputElement>("#settingsTvdbApiKey");
const settingsTvdbPin = requireElement<HTMLInputElement>("#settingsTvdbPin");
const settingsLanguage = requireElement<HTMLInputElement>("#settingsLanguage");
const settingsAutomationEnabled = requireElement<HTMLInputElement>("#settingsAutomationEnabled");
const settingsAutomationInboxDirectory = requireElement<HTMLInputElement>("#settingsAutomationInboxDirectory");
const settingsAutomationInboxButton = requireElement<HTMLButtonElement>("#settingsAutomationInboxButton");
const settingsAutomationSourceLibraryDirectory = requireElement<HTMLInputElement>("#settingsAutomationSourceLibraryDirectory");
const settingsAutomationSourceLibraryButton = requireElement<HTMLButtonElement>("#settingsAutomationSourceLibraryButton");
const settingsAutomationMirrorLibraryDirectory = requireElement<HTMLInputElement>("#settingsAutomationMirrorLibraryDirectory");
const settingsAutomationMirrorLibraryButton = requireElement<HTMLButtonElement>("#settingsAutomationMirrorLibraryButton");
const settingsAutomationSource = requireElement<HTMLSelectElement>("#settingsAutomationSource");
const settingsAutomationSettleSeconds = requireElement<HTMLInputElement>("#settingsAutomationSettleSeconds");
const automationStatusPanel = requireElement<HTMLDivElement>("#automationStatusPanel");
const repairShowFolderInput = requireElement<HTMLInputElement>("#repairShowFolderInput");
const repairShowFolderButton = requireElement<HTMLButtonElement>("#repairShowFolderButton");
const repairShowRunButton = requireElement<HTMLButtonElement>("#repairShowRunButton");
const settingsTmdbStatus = requireElement<HTMLParagraphElement>("#settingsTmdbStatus");
const settingsTvdbStatus = requireElement<HTMLParagraphElement>("#settingsTvdbStatus");
const helpBackButton = requireElement<HTMLButtonElement>("#helpBackButton");
const sourcePane = requireElement<HTMLElement>(".pane-source");
const sourceSelect = requireElement<HTMLSelectElement>("#sourceSelect");
const manualTitleInput = requireElement<HTMLInputElement>("#manualTitleInput");
const outputInput = requireElement<HTMLInputElement>("#outputInput");
const outputButton = requireElement<HTMLButtonElement>("#outputButton");
const importButton = requireElement<HTMLButtonElement>("#importButton");
const clearButton = requireElement<HTMLButtonElement>("#clearButton");
const dropzone = requireElement<HTMLButtonElement>("#dropzone");
const matchButton = requireElement<HTMLButtonElement>("#matchButton");
const applyButton = requireElement<HTMLButtonElement>("#applyButton");
const providerNote = requireElement<HTMLParagraphElement>("#providerNote");
const sourceList = requireElement<HTMLDivElement>("#sourceList");
const resultList = requireElement<HTMLDivElement>("#resultList");
const detailSummary = requireElement<HTMLDivElement>("#detailSummary");
const fileCount = requireElement<HTMLSpanElement>("#fileCount");
const resultCount = requireElement<HTMLSpanElement>("#resultCount");
const message = requireElement<HTMLParagraphElement>("#message");

bindEvents();
render();
void initialize();

async function initialize(): Promise<void> {
  state.settings = await window.folderBot.getSettings();
  state.settingsDraft = { ...state.settings };
  state.automationStatus = await window.folderBot.getAutomationStatus();
  state.historyEntries = await window.folderBot.getRenameHistory();
  state.automationHistoryEntries = await window.folderBot.getAutomationHistory();
  await refreshProviderStatuses();
  window.folderBot.onOpenHelp(() => {
    state.modal = "help";
    render();
  });
  window.folderBot.onAutomationStatus((status) => {
    state.automationStatus = status;
    render();
  });
  render();
}

function bindEvents(): void {
  historyButton.addEventListener("click", async () => {
    await loadHistory();
    state.modal = "history";
    render();
  });

  historyTabManual.addEventListener("click", () => {
    state.historyTab = "manual";
    render();
  });

  historyTabAutomation.addEventListener("click", () => {
    state.historyTab = "automation";
    render();
  });

  historyBackButton.addEventListener("click", () => {
    state.modal = "none";
    render();
  });

  settingsButton.addEventListener("click", () => {
    state.settingsDraft = { ...state.settings };
    state.modal = "settings";
    render();
  });

  settingsBackButton.addEventListener("click", () => {
    state.modal = "none";
    render();
  });

  helpBackButton.addEventListener("click", () => {
    state.modal = "none";
    render();
  });

  settingsSaveButton.addEventListener("click", async () => {
    const nextDraft: AppSettings = {
      tmdbBearerToken: settingsTmdbToken.value,
      tvdbApiKey: settingsTvdbApiKey.value,
      tvdbPin: settingsTvdbPin.value,
      defaultLanguage: settingsLanguage.value,
      automationEnabled: settingsAutomationEnabled.checked,
      automationInboxDirectory: settingsAutomationInboxDirectory.value,
      automationSourceLibraryDirectory: settingsAutomationSourceLibraryDirectory.value,
      automationMirrorLibraryDirectory: settingsAutomationMirrorLibraryDirectory.value,
      automationSourceId: settingsAutomationSource.value as MetadataSourceId,
      automationSettleSeconds: Number(settingsAutomationSettleSeconds.value) || 45
    };

    state.settingsDraft = nextDraft;
    state.busy = true;
    state.message = "Saving settings...";
    render();

    try {
      state.settings = await window.folderBot.saveSettings(nextDraft);
      state.settingsDraft = { ...state.settings };

      await refreshProviderStatuses();
      state.modal = "none";
      state.message = "Settings saved.";
    } finally {
      state.busy = false;
      render();
    }
  });

  sourceSelect.addEventListener("change", async () => {
    state.sourceId = sourceSelect.value as MetadataSourceId;
    await refreshProviderStatuses();
    const provider = getProviderStatus(state.sourceId);
    state.message = provider?.ready
      ? `Source set to ${provider.label}.`
      : `Source set to ${provider?.label ?? "selected provider"}. Check settings if matching is unavailable.`;
    render();
  });

  manualTitleInput.addEventListener("input", () => {
    state.manualTitle = manualTitleInput.value.trim();
  });

  settingsTmdbToken.addEventListener("input", () => {
    state.settingsDraft.tmdbBearerToken = settingsTmdbToken.value;
  });

  settingsTvdbApiKey.addEventListener("input", () => {
    state.settingsDraft.tvdbApiKey = settingsTvdbApiKey.value;
  });

  settingsTvdbPin.addEventListener("input", () => {
    state.settingsDraft.tvdbPin = settingsTvdbPin.value;
  });

  settingsLanguage.addEventListener("input", () => {
    state.settingsDraft.defaultLanguage = settingsLanguage.value;
  });

  settingsAutomationEnabled.addEventListener("change", () => {
    state.settingsDraft.automationEnabled = settingsAutomationEnabled.checked;
  });

  settingsAutomationInboxButton.addEventListener("click", async () => {
    const inboxDirectory = await window.folderBot.pickOutputDirectory();
    if (!inboxDirectory) {
      return;
    }

    state.settingsDraft.automationInboxDirectory = inboxDirectory;
    render();
  });

  settingsAutomationSourceLibraryButton.addEventListener("click", async () => {
    const sourceLibraryDirectory = await window.folderBot.pickOutputDirectory();
    if (!sourceLibraryDirectory) {
      return;
    }

    state.settingsDraft.automationSourceLibraryDirectory = sourceLibraryDirectory;
    render();
  });

  settingsAutomationMirrorLibraryButton.addEventListener("click", async () => {
    const mirrorLibraryDirectory = await window.folderBot.pickOutputDirectory();
    if (!mirrorLibraryDirectory) {
      return;
    }

    state.settingsDraft.automationMirrorLibraryDirectory = mirrorLibraryDirectory;
    render();
  });

  settingsAutomationSource.addEventListener("change", () => {
    state.settingsDraft.automationSourceId = settingsAutomationSource.value as MetadataSourceId;
  });

  settingsAutomationSettleSeconds.addEventListener("input", () => {
    state.settingsDraft.automationSettleSeconds = Number(settingsAutomationSettleSeconds.value) || 45;
  });

  repairShowFolderButton.addEventListener("click", async () => {
    const selectedFolder = await window.folderBot.pickOutputDirectory();
    if (!selectedFolder) {
      return;
    }

    state.repairShowFolderPath = selectedFolder;
    render();
  });

  repairShowRunButton.addEventListener("click", async () => {
    await runRepairSeasonPlacement();
  });

  outputButton.addEventListener("click", async () => {
    const outputDirectory = await window.folderBot.pickOutputDirectory();
    if (outputDirectory) {
      state.outputDirectory = outputDirectory;
      render();
    }
  });

  importButton.addEventListener("click", async () => {
    mergeFiles(await window.folderBot.pickFiles());
  });

  clearButton.addEventListener("click", () => {
    state.filePaths = [];
    state.previews = [];
    state.selectedPath = null;
    state.message = "Queue cleared.";
    render();
  });

  dropzone.addEventListener("click", async () => {
    mergeFiles(await window.folderBot.pickFiles());
  });

  for (const element of [sourcePane, dropzone]) {
    element.addEventListener("dragover", (event) => {
      event.preventDefault();
      dropzone.classList.add("dropzone-active");
    });

    element.addEventListener("dragleave", (event) => {
      const relatedTarget = event.relatedTarget;
      if (!(relatedTarget instanceof Node) || !sourcePane.contains(relatedTarget)) {
        dropzone.classList.remove("dropzone-active");
      }
    });

    element.addEventListener("drop", async (event) => {
      event.preventDefault();
      dropzone.classList.remove("dropzone-active");
      mergeFiles(await getDroppedPaths(event));
    });
  }

  document.addEventListener("dragover", (event) => {
    event.preventDefault();
  });

  document.addEventListener("drop", (event) => {
    event.preventDefault();
  });

  matchButton.addEventListener("click", async () => {
    await generatePreview();
  });

  applyButton.addEventListener("click", async () => {
    await applyRenameBatch();
  });

  sourceList.addEventListener("click", (event) => {
    updateSelectionFromEvent(event);
  });

  resultList.addEventListener("click", (event) => {
    updateSelectionFromEvent(event);
  });

  historyList.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }

    const automationButton = target.closest<HTMLButtonElement>("[data-undo-automation-entry]");
    const automationEntryId = automationButton?.dataset.undoAutomationEntry;

    if (automationEntryId) {
      await undoAutomationHistoryEntry(automationEntryId);
      return;
    }

    const toggleAllButton = target.closest<HTMLButtonElement>("[data-select-all-entry]");
    if (toggleAllButton) {
      const entryId = toggleAllButton.dataset.selectAllEntry;
      if (!entryId) {
        return;
      }

      const entry = state.historyEntries.find((item) => item.id === entryId);
      if (!entry) {
        return;
      }

      const pendingIds = entry.items.filter((item) => !item.undoneAt).map((item) => item.id);
      const selectedIds = state.historySelection[entryId] ?? [];
      state.historySelection[entryId] =
        selectedIds.length === pendingIds.length ? [] : pendingIds;
      render();
      return;
    }

    const button = target.closest<HTMLButtonElement>("[data-undo-entry]");
    const entryId = button?.dataset.undoEntry;
    const undoMode = button?.dataset.undoMode;

    if (!entryId || !undoMode) {
      return;
    }

    await undoHistoryEntry(
      entryId,
      undoMode === "selected" ? state.historySelection[entryId] ?? [] : undefined
    );
  });

  historyList.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.type !== "checkbox") {
      return;
    }

    const entryId = target.dataset.entryId;
    const itemId = target.dataset.itemId;

    if (!entryId || !itemId) {
      return;
    }

    const selected = new Set(state.historySelection[entryId] ?? []);
    if (target.checked) {
      selected.add(itemId);
    } else {
      selected.delete(itemId);
    }

    state.historySelection[entryId] = Array.from(selected);
    render();
  });

  settingsView.addEventListener("click", (event) => {
    if (event.target === settingsView) {
      state.modal = "none";
      render();
    }
  });

  historyView.addEventListener("click", (event) => {
    if (event.target === historyView) {
      state.modal = "none";
      render();
    }
  });

  helpView.addEventListener("click", (event) => {
    if (event.target === helpView) {
      state.modal = "none";
      render();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.modal !== "none") {
      state.modal = "none";
      render();
    }
  });
}

async function refreshProviderStatuses(): Promise<void> {
  state.providerStatuses = await window.folderBot.getProviderStatuses(buildOptions());
}

async function generatePreview(): Promise<void> {
  if (state.filePaths.length === 0) {
    state.message = "Add files before matching.";
    render();
    return;
  }

  state.busy = true;
  state.message = "Matching filenames...";
  render();

  try {
    state.previews = await window.folderBot.previewRenames({
      filePaths: state.filePaths,
      options: buildOptions()
    });

    const issueCount = state.previews.reduce(
      (count, item) => count + item.warnings.length + item.conflicts.length,
      0
    );

    state.message =
      issueCount > 0
        ? `Match finished with ${issueCount} note${issueCount === 1 ? "" : "s"}.`
        : "Match finished. Review the right column, then rename.";
  } finally {
    state.busy = false;
    render();
  }
}

async function applyRenameBatch(): Promise<void> {
  if (state.previews.length === 0) {
    state.message = "Match files first so there is something to rename.";
    render();
    return;
  }

  state.busy = true;
  state.message = "Renaming files...";
  render();

  try {
    const results = await window.folderBot.applyRenames({
      items: state.previews,
      sourceId: state.sourceId
    });
    const failed = results.filter((result) => !result.success);
    const succeeded = results.length - failed.length;

    state.message =
      failed.length > 0
        ? `${succeeded} renamed, ${failed.length} failed${failed[0]?.error ? `: ${failed[0].error}` : "."}`
        : `All ${results.length} item${results.length === 1 ? "" : "s"} renamed.`;

    state.filePaths = failed.map((result) => result.sourcePath);
    state.previews = state.previews.filter((item) => state.filePaths.includes(item.sourcePath));
    state.selectedPath = state.filePaths[0] ?? null;
    await loadHistory();
  } finally {
    state.busy = false;
    render();
  }
}

function mergeFiles(paths: string[]): void {
  if (paths.length === 0) {
    return;
  }

  state.filePaths = Array.from(new Set([...state.filePaths, ...paths]));
  state.selectedPath = state.selectedPath ?? state.filePaths[0] ?? null;
  state.message = `${paths.length} file${paths.length === 1 ? "" : "s"} added.`;
  render();
}

function render(): void {
  workspaceView.classList.remove("view-hidden");
  settingsView.classList.toggle("view-hidden", state.modal !== "settings");
  historyView.classList.toggle("view-hidden", state.modal !== "history");
  helpView.classList.toggle("view-hidden", state.modal !== "help");
  sourceSelect.value = state.sourceId;
  manualTitleInput.value = state.manualTitle;
  outputInput.value = state.outputDirectory;
  settingsTmdbToken.value = state.settingsDraft.tmdbBearerToken;
  settingsTvdbApiKey.value = state.settingsDraft.tvdbApiKey;
  settingsTvdbPin.value = state.settingsDraft.tvdbPin;
  settingsLanguage.value = state.settingsDraft.defaultLanguage;
  settingsAutomationEnabled.checked = state.settingsDraft.automationEnabled;
  settingsAutomationInboxDirectory.value = state.settingsDraft.automationInboxDirectory;
  settingsAutomationSourceLibraryDirectory.value = state.settingsDraft.automationSourceLibraryDirectory;
  settingsAutomationMirrorLibraryDirectory.value = state.settingsDraft.automationMirrorLibraryDirectory;
  settingsAutomationSource.value = state.settingsDraft.automationSourceId;
  settingsAutomationSettleSeconds.value = String(state.settingsDraft.automationSettleSeconds);
  repairShowFolderInput.value = state.repairShowFolderPath;
  message.textContent = state.message;
  fileCount.textContent = `${state.filePaths.length} queued`;
  resultCount.textContent =
    state.previews.length > 0 ? `${state.previews.length} matched` : "Waiting";

  const selectedProvider = getProviderStatus(state.sourceId);
  providerNote.textContent = selectedProvider?.details ?? "";
  settingsTmdbStatus.textContent = getProviderStatus("tmdb")?.details ?? "";
  settingsTvdbStatus.textContent = getProviderStatus("tvdb")?.details ?? "";
  matchButton.textContent = state.busy
    ? "Matching..."
    : `Match${selectedProvider ? ` from ${selectedProvider.label}` : ""}`;

  renderSourceList();
  renderResultList();
  renderInspector();
  renderHistoryList();
  renderAutomationStatus();

  matchButton.disabled =
    state.busy ||
    state.filePaths.length === 0 ||
    (state.sourceId !== "local" && !selectedProvider?.ready);
  applyButton.disabled = state.busy || state.previews.length === 0;
  importButton.disabled = state.busy;
  outputButton.disabled = state.busy;
  dropzone.disabled = state.busy;
  clearButton.disabled = state.busy;
  historyButton.disabled = state.busy && state.modal === "history";
  settingsButton.disabled = state.busy && state.modal === "settings";
  historyBackButton.disabled = state.busy;
  settingsBackButton.disabled = state.busy;
  settingsSaveButton.disabled = state.busy;
  settingsAutomationInboxButton.disabled = state.busy;
  settingsAutomationSourceLibraryButton.disabled = state.busy;
  settingsAutomationMirrorLibraryButton.disabled = state.busy;
  repairShowFolderButton.disabled = state.busy;
  repairShowRunButton.disabled = state.busy || !state.repairShowFolderPath;
  helpBackButton.disabled = state.busy;
}

function renderSourceList(): void {
  if (state.filePaths.length === 0) {
    sourceList.className = "file-list empty-state";
    sourceList.textContent = "Nothing queued yet.";
    return;
  }

  sourceList.className = "file-list";
  sourceList.innerHTML = state.filePaths
    .map((filePath, index) => {
      const parts = splitPath(filePath);
      const preview = findPreview(filePath);
      const parsed = preview?.parsed ?? parseMediaName(parts.name);
      const selectedClass = filePath === state.selectedPath ? " is-selected" : "";

      return `
        <button class="file-row${selectedClass}" type="button" data-path="${escapeHtml(filePath)}">
          <span class="row-index">${String(index + 1).padStart(2, "0")}</span>
          <div class="row-copy">
            <strong>${escapeHtml(parts.name)}</strong>
            <span class="row-meta">${escapeHtml(buildDetectedLabel(parsed))}</span>
            <small>${escapeHtml(parts.directory || "Current folder")}</small>
          </div>
        </button>
      `;
    })
    .join("");
}

function renderResultList(): void {
  if (state.filePaths.length === 0) {
    resultList.className = "file-list empty-state";
    resultList.textContent = "Matched names will appear here.";
    return;
  }

  resultList.className = "file-list";
  resultList.innerHTML = state.filePaths
    .map((filePath, index) => {
      const preview = findPreview(filePath);
      const selectedClass = filePath === state.selectedPath ? " is-selected" : "";
      const rowStateClass = preview
        ? preview.conflicts.length > 0
          ? " row-has-issue"
          : " row-ready"
        : " row-pending";

      return `
        <button class="file-row result-row${selectedClass}${rowStateClass}" type="button" data-path="${escapeHtml(filePath)}">
          <span class="row-index">${String(index + 1).padStart(2, "0")}</span>
          <div class="row-copy">
            <strong>${escapeHtml(preview?.targetName || "Waiting for match")}</strong>
            <span class="row-meta">${escapeHtml(buildResultLabel(preview))}</span>
            <small>${escapeHtml(preview?.targetPath || "Choose a source and click Match in the center rail")}</small>
          </div>
        </button>
      `;
    })
    .join("");
}

function renderHistoryList(): void {
  historyTabManual.classList.toggle("is-active", state.historyTab === "manual");
  historyTabAutomation.classList.toggle("is-active", state.historyTab === "automation");

  if (state.historyTab === "automation") {
    renderAutomationHistoryList();
    return;
  }

  if (state.historyEntries.length === 0) {
    historyList.className = "history-list empty-state";
    historyList.textContent = "No rename batches recorded yet.";
    return;
  }

  historyList.className = "history-list";
  historyList.innerHTML = state.historyEntries
    .map((entry) => {
      const createdAt = new Date(entry.createdAt).toLocaleString();
      const pendingItems = entry.items.filter((item) => !item.undoneAt);
      const selectedIds = state.historySelection[entry.id] ?? [];
      const pendingSelectedCount = pendingItems.filter((item) => selectedIds.includes(item.id)).length;

      return `
        <article class="history-entry">
          <div class="history-entry-top">
            <div>
              <strong>${escapeHtml(entry.sourceId.toUpperCase())}</strong>
              <span class="row-meta">${escapeHtml(createdAt)}</span>
            </div>
            <div class="history-actions">
              <button
                class="quiet-button"
                type="button"
                data-select-all-entry="${escapeHtml(entry.id)}"
                ${pendingItems.length === 0 ? "disabled" : ""}
              >
                ${
                  pendingItems.length > 0 && pendingSelectedCount === pendingItems.length
                    ? "Clear selection"
                    : "Select all"
                }
              </button>
              <button
                class="quiet-button"
                type="button"
                data-undo-entry="${escapeHtml(entry.id)}"
                data-undo-mode="selected"
                ${pendingSelectedCount === 0 ? "disabled" : ""}
              >
                Undo selected
              </button>
              <button
                class="quiet-button"
                type="button"
                data-undo-entry="${escapeHtml(entry.id)}"
                data-undo-mode="all"
                ${pendingItems.length === 0 ? "disabled" : ""}
              >
                ${pendingItems.length === 0 ? "Undone" : "Undo all"}
              </button>
            </div>
          </div>
          <p class="history-summary">
            ${entry.itemCount} item${entry.itemCount === 1 ? "" : "s"} renamed
            · ${pendingItems.length} pending
          </p>
          <div class="history-preview-list">
            ${entry.items
              .map(
                (item) => `
                  <label class="history-preview-item ${item.undoneAt ? "history-preview-item-undone" : ""}">
                    <input
                      type="checkbox"
                      data-entry-id="${escapeHtml(entry.id)}"
                      data-item-id="${escapeHtml(item.id)}"
                      ${selectedIds.includes(item.id) ? "checked" : ""}
                      ${item.undoneAt ? "disabled" : ""}
                    />
                    <span>${escapeHtml(splitPath(item.sourcePath).name)}</span>
                    <span>${escapeHtml(splitPath(item.targetPath).name)}</span>
                    <span>${item.undoneAt ? "Undone" : "Renamed"}</span>
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

function renderAutomationHistoryList(): void {
  if (state.automationHistoryEntries.length === 0) {
    historyList.className = "history-list empty-state";
    historyList.textContent = "No automation items recorded yet.";
    return;
  }

  historyList.className = "history-list";
  historyList.innerHTML = state.automationHistoryEntries
    .map((entry) => {
      const createdAt = new Date(entry.createdAt).toLocaleString();

      return `
        <article class="history-entry">
          <div class="history-entry-top">
            <div>
              <strong>${escapeHtml(entry.displayTitle)}</strong>
              <span class="row-meta">${escapeHtml(createdAt)}</span>
            </div>
            <div class="history-actions">
              <button
                class="quiet-button"
                type="button"
                data-undo-automation-entry="${escapeHtml(entry.id)}"
                ${entry.undoneAt ? "disabled" : ""}
              >
                ${entry.undoneAt ? "Undone" : "Undo automation"}
              </button>
            </div>
          </div>
          <p class="history-summary">
            ${escapeHtml(entry.sourceId.toUpperCase())} · ${entry.undoneAt ? "Undone" : "Applied"}
          </p>
          <div class="history-preview-list">
            <div class="history-preview-item history-preview-item-static ${entry.undoneAt ? "history-preview-item-undone" : ""}">
              <span>Inbox</span>
              <span>${escapeHtml(splitPath(entry.originalInboxPath).name)}</span>
              <span>${escapeHtml(splitPath(entry.originalInboxPath).directory || entry.originalInboxPath)}</span>
            </div>
            <div class="history-preview-item history-preview-item-static ${entry.undoneAt ? "history-preview-item-undone" : ""}">
              <span>Source</span>
              <span>${escapeHtml(splitPath(entry.sourceLibraryPath).name)}</span>
              <span>${escapeHtml(splitPath(entry.sourceLibraryPath).directory || entry.sourceLibraryPath)}</span>
            </div>
            <div class="history-preview-item history-preview-item-static ${entry.undoneAt ? "history-preview-item-undone" : ""}">
              <span>Mirror</span>
              <span>${escapeHtml(splitPath(entry.mirrorLibraryPath).name)}</span>
              <span>${escapeHtml(splitPath(entry.mirrorLibraryPath).directory || entry.mirrorLibraryPath)}</span>
            </div>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderInspector(): void {
  const selectedPath = state.selectedPath ?? state.filePaths[0];
  if (!selectedPath) {
    detailSummary.className = "detail-summary empty-state";
    detailSummary.textContent = "Select a file to inspect what was detected and what will change.";
    return;
  }

  const preview = findPreview(selectedPath);
  const fileName = splitPath(selectedPath).name;
  const parsed = preview?.parsed ?? parseMediaName(fileName);
  const notes = preview ? [...preview.warnings, ...preview.conflicts] : parsed.warnings;

  detailSummary.className = "detail-summary";
  detailSummary.innerHTML = `
    <div class="detail-block">
      <span class="detail-label">Detected</span>
      <strong>${escapeHtml(buildDetectedLabel(parsed))}</strong>
      <p>${escapeHtml(selectedPath)}</p>
    </div>
    <div class="detail-block">
      <span class="detail-label">Match</span>
      <strong>${escapeHtml(preview?.metadata?.displayTitle || "Not matched yet")}</strong>
      <p>${escapeHtml(preview?.targetName || "Run Match to generate a renamed result.")}</p>
    </div>
    <div class="detail-block">
      <span class="detail-label">Notes</span>
      <strong>${notes.length > 0 ? `${notes.length} item${notes.length === 1 ? "" : "s"}` : "No issues"}</strong>
      <p>${escapeHtml(notes[0] || "The file is ready to rename.")}</p>
    </div>
  `;
}

function buildDetectedLabel(parsed: ParsedMedia): string {
  if (parsed.kind === "episode") {
    return `Episode · ${formatEpisodeCode(parsed.season, parsed.episode, parsed.absoluteEpisode)} · ${toDisplayTitle(
      parsed.normalizedTitle
    )}`;
  }

  if (parsed.kind === "movie") {
    return `Movie · ${parsed.year ?? "Year unknown"} · ${toDisplayTitle(parsed.normalizedTitle)}`;
  }

  return `Unclassified · ${toDisplayTitle(parsed.normalizedTitle)}`;
}

function buildResultLabel(preview?: RenamePreview): string {
  if (!preview) {
    return "Choose a source and click Match.";
  }

  const sourceLabel = preview.metadata ? preview.metadata.sourceId.toUpperCase() : "LOCAL";
  const noteCount = preview.warnings.length + preview.conflicts.length;

  return noteCount > 0 ? `${sourceLabel} · ${noteCount} note${noteCount === 1 ? "" : "s"}` : `${sourceLabel} · Ready`;
}

function findPreview(filePath: string): RenamePreview | undefined {
  return state.previews.find((item) => item.sourcePath === filePath);
}

function getProviderStatus(providerId: MetadataSourceId): ProviderStatus | undefined {
  return state.providerStatuses.find((status) => status.id === providerId);
}

function updateSelectionFromEvent(event: Event): void {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }

  const row = target.closest<HTMLElement>("[data-path]");
  const nextPath = row?.dataset.path;

  if (!nextPath) {
    return;
  }

  state.selectedPath = nextPath;
  render();
}

function buildOptions(): PreviewRequest["options"] {
  return {
    sourceId: state.sourceId,
    tmdbToken: state.settings.tmdbBearerToken || undefined,
    tvdbApiKey: state.settings.tvdbApiKey || undefined,
    tvdbPin: state.settings.tvdbPin || undefined,
    language: state.settings.defaultLanguage,
    destinationDirectory: state.outputDirectory || undefined,
    manualTitle: state.manualTitle || undefined
  };
}

function splitPath(fullPath: string): { name: string; directory: string } {
  const parts = fullPath.split(/[\\/]/);
  return {
    name: parts.at(-1) ?? fullPath,
    directory: parts.slice(0, -1).join(" / ")
  };
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
}

async function undoAutomationHistoryEntry(entryId: string): Promise<void> {
  state.busy = true;
  state.message = "Undoing automation item...";
  render();

  try {
    const undoResult = await window.folderBot.undoAutomationHistoryEntry(entryId);
    const failed = undoResult.results.filter((result) => !result.success);
    const succeeded = undoResult.results.length - failed.length;

    state.message =
      failed.length > 0
        ? `${succeeded} automation step${succeeded === 1 ? "" : "s"} completed, ${failed.length} failed.`
        : "Automation item restored to the inbox.";

    await loadHistory();
  } finally {
    state.busy = false;
    render();
  }
}

async function runRepairSeasonPlacement(): Promise<void> {
  if (!state.repairShowFolderPath) {
    state.message = "Choose a show folder first.";
    render();
    return;
  }

  state.busy = true;
  state.message = "Repairing season placement...";
  render();

  try {
    const result = await window.folderBot.repairSeasonPlacement(state.repairShowFolderPath);
    const movedCount = result.locations.reduce((sum, location) => sum + location.movedCount, 0);
    const errorCount = result.locations.reduce((sum, location) => sum + location.errors.length, 0);

    state.message =
      errorCount > 0
        ? `Repair moved ${movedCount} file${movedCount === 1 ? "" : "s"} with ${errorCount} error${errorCount === 1 ? "" : "s"}.`
        : `Repair finished for ${result.showName}: ${movedCount} file${movedCount === 1 ? "" : "s"} moved.`;
  } catch (error) {
    state.message = error instanceof Error ? `Repair failed: ${error.message}` : "Repair failed.";
  } finally {
    state.busy = false;
    render();
  }
}

async function undoHistoryEntry(entryId: string, itemIds?: string[]): Promise<void> {
  state.busy = true;
  state.message = "Undoing rename batch...";
  render();

  try {
    const undoResult = await window.folderBot.undoRenameHistoryEntry({
      entryId,
      itemIds: itemIds && itemIds.length > 0 ? itemIds : undefined
    });
    const failed = undoResult.results.filter((result) => !result.success);
    const succeeded = undoResult.results.length - failed.length;

    state.message =
      failed.length > 0
        ? `${succeeded} item${succeeded === 1 ? "" : "s"} restored, ${failed.length} undo failed.`
        : `Undo completed for ${undoResult.results.length} item${undoResult.results.length === 1 ? "" : "s"}.`;

    await loadHistory();
  } finally {
    state.busy = false;
    render();
  }
}

function renderAutomationStatus(): void {
  const status = state.automationStatus;
  const recentEvents = status.recentEvents.length > 0
    ? status.recentEvents
        .map(
          (event) => `
            <li>
              <span>${escapeHtml(new Date(event.createdAt).toLocaleTimeString())}</span>
              <span>${escapeHtml(event.message)}</span>
            </li>
          `
        )
        .join("")
    : "<li><span>Idle</span><span>No automation activity yet.</span></li>";

  automationStatusPanel.innerHTML = `
    <div class="automation-status-grid">
      <span>${status.enabled ? "Enabled" : "Disabled"}</span>
      <span>${status.watching ? "Watching" : "Not watching"}</span>
      <span>${status.processing ? "Processing" : "Idle"}</span>
      <span>${status.pendingCount} pending</span>
    </div>
    <div class="automation-status-summary">
      <p>Inbox: ${escapeHtml(status.inboxDirectory || "No inbox folder selected.")}</p>
      <p>Source library: ${escapeHtml(status.sourceLibraryDirectory || "No source library selected.")}</p>
      <p>Mirror library: ${escapeHtml(status.mirrorLibraryDirectory || "No mirror library selected.")}</p>
    </div>
    <ul class="automation-event-list">
      ${recentEvents}
    </ul>
  `;
}
