// App-wide state: settings, watcher status, history, updates and toasts. A small external store
// read through useStore(selector), so a progress tick re-renders only what shows progress.
import { useSyncExternalStore } from "react";
import type { FolderBotApi } from "../shared/api";
import type {
  AppInfo,
  AppSettings,
  AutomationHistoryEntry,
  AutomationStatus,
  ProviderStatus,
  RenameHistoryEntry,
  UpdateState
} from "../shared/types";

declare global {
  interface Window {
    folderBot: FolderBotApi;
  }
}

export const api = window.folderBot;

export type Route = "activity" | "rename" | "history" | "settings";

export interface Toast {
  id: number;
  tone: "neutral" | "success" | "error";
  message: string;
  action?: { label: string; run: () => void };
}

export interface AppState {
  route: Route;
  settingsSection?: string;
  loaded: boolean;
  settings: AppSettings;
  automation: AutomationStatus;
  update: UpdateState;
  appInfo: AppInfo | null;
  providerStatuses: ProviderStatus[];
  renameHistory: RenameHistoryEntry[];
  automationHistory: AutomationHistoryEntry[];
  historyErrors: { manual?: string; automation?: string };
  toasts: Toast[];
}

export const DEFAULT_SETTINGS: AppSettings = {
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
  automationSettleSeconds: 45,
  notifyOnFiled: true,
  notifyOnFailure: true
};

const EMPTY_STATUS: AutomationStatus = {
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
  recentEvents: [],
  jobs: [],
  problems: []
};

let state: AppState = {
  route: "activity",
  loaded: false,
  settings: DEFAULT_SETTINGS,
  automation: EMPTY_STATUS,
  update: { kind: "idle" },
  appInfo: null,
  providerStatuses: [],
  renameHistory: [],
  automationHistory: [],
  historyErrors: {},
  toasts: []
};

const listeners = new Set<() => void>();

export function getState(): AppState {
  return state;
}

export function setState(update: Partial<AppState> | ((current: AppState) => Partial<AppState>)): void {
  const patch = typeof update === "function" ? update(state) : update;
  state = { ...state, ...patch };
  for (const listener of listeners) {
    listener();
  }
}

export function useStore<T>(selector: (current: AppState) => T): T {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => selector(state)
  );
}

// ------------------------------------------------------------------ actions

export function navigate(route: Route, settingsSection?: string): void {
  setState({ route, settingsSection });
  if (route === "history") {
    void loadHistory();
  }
}

let toastId = 0;

export function toast(message: string, tone: Toast["tone"] = "neutral", action?: Toast["action"]): void {
  const id = ++toastId;
  setState((current) => ({ toasts: [...current.toasts.slice(-2), { id, tone, message, action }] }));
  window.setTimeout(() => dismissToast(id), action ? 9_000 : tone === "error" ? 8_000 : 4_000);
}

export function dismissToast(id: number): void {
  setState((current) => ({ toasts: current.toasts.filter((item) => item.id !== id) }));
}

export async function saveSettings(patch: Partial<AppSettings>, quiet = false): Promise<boolean> {
  const previous = state.settings;
  setState({ settings: { ...state.settings, ...patch } });

  try {
    const saved = await api.saveSettings(patch);
    setState({ settings: saved });
    if (!quiet) {
      toast("Saved", "success");
    }
    if ("tmdbBearerToken" in patch || "tvdbApiKey" in patch || "tvdbPin" in patch || "defaultLanguage" in patch) {
      await refreshProviderStatuses();
    }
    return true;
  } catch (error) {
    setState({ settings: previous });
    toast(`Could not save: ${describe(error)}`, "error");
    return false;
  }
}

export async function refreshProviderStatuses(): Promise<void> {
  const settings = state.settings;
  try {
    const statuses = await api.getProviderStatuses({
      sourceId: "local",
      tmdbToken: settings.tmdbBearerToken || undefined,
      tvdbApiKey: settings.tvdbApiKey || undefined,
      tvdbPin: settings.tvdbPin || undefined,
      language: settings.defaultLanguage
    });
    setState({ providerStatuses: statuses });
  } catch {
    // Provider status is advisory; the Settings page shows "Not checked" without it.
  }
}

// The two history files are read separately so a damaged one still leaves the other visible.
export async function loadHistory(): Promise<void> {
  const errors: AppState["historyErrors"] = {};
  let renameHistory = state.renameHistory;
  let automationHistory = state.automationHistory;

  try {
    renameHistory = await api.getRenameHistory();
  } catch (error) {
    errors.manual = describe(error);
  }

  try {
    automationHistory = await api.getAutomationHistory();
  } catch (error) {
    errors.automation = describe(error);
  }

  setState({ renameHistory, automationHistory, historyErrors: errors });
}

// Every startup step is isolated: one failing call (a damaged history file, say) must not stop
// the watcher status from arriving.
export async function initialize(): Promise<void> {
  api.onAutomationStatus((automation) => {
    const finishedBefore = new Set(state.automation.jobs.filter((job) => job.stage === "filed").map((job) => job.id + job.finishedAt));
    setState({ automation });
    if (automation.jobs.some((job) => job.stage === "filed" && !finishedBefore.has(job.id + job.finishedAt))) {
      void loadHistory();
    }
  });
  api.onUpdateState((update) => setState({ update }));
  api.onSettingsChanged((settings) => setState({ settings }));
  api.onNavigate((route) => navigate(route as Route));
  api.onAccentColor((color) => applyAccent(color));

  await Promise.all([
    step(async () => setState({ settings: await api.getSettings() }), "Could not read your settings"),
    step(async () => setState({ automation: await api.getAutomationStatus() }), "Could not read the watcher status"),
    step(async () => {
      const appInfo = await api.getAppInfo();
      applyAccent(appInfo.accentColor);
      setState({ appInfo });
    }, "Could not read app details"),
    step(async () => setState({ update: await api.getUpdateState() }), "Could not read the update status")
  ]);

  await loadHistory();
  await refreshProviderStatuses();

  setState({ loaded: true });
}

async function step(run: () => Promise<void>, failure: string): Promise<void> {
  try {
    await run();
  } catch (error) {
    toast(`${failure}: ${describe(error)}`, "error");
  }
}

function applyAccent(color: string | undefined): void {
  if (color && /^#[0-9a-f]{6}$/i.test(color)) {
    document.documentElement.style.setProperty("--accent", color);
  }
}

export function describe(error: unknown): string {
  if (error instanceof Error) {
    // IPC errors arrive as "Error invoking remote method 'x': Error: message".
    return error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
  }
  return String(error);
}
