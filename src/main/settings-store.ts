// Persistent settings storage and normalization for provider credentials and automation settings.
import path from "node:path";
import { app } from "electron";
import type { AppSettings } from "../shared/types";
import { readJsonObjectFile, writeJsonFileAtomic } from "./json-file";

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
  automationSettleSeconds: 45,
  notifyOnFiled: true,
  notifyOnFailure: true
};

// Load the saved settings file and fill in any missing fields with defaults.
export async function getSettings(): Promise<AppSettings> {
  const parsed = ((await readJsonObjectFile(getSettingsPath(), "The settings file")) ??
    {}) as Partial<AppSettings> & {
    automationWatchDirectory?: string;
    automationLibraryDirectory?: string;
  };

  return {
    tmdbBearerToken: parsed.tmdbBearerToken ?? DEFAULT_SETTINGS.tmdbBearerToken,
    tvdbApiKey: parsed.tvdbApiKey ?? DEFAULT_SETTINGS.tvdbApiKey,
    tvdbPin: parsed.tvdbPin ?? DEFAULT_SETTINGS.tvdbPin,
    defaultLanguage: parsed.defaultLanguage ?? DEFAULT_SETTINGS.defaultLanguage,
    launchAtLogin: parsed.launchAtLogin ?? DEFAULT_SETTINGS.launchAtLogin,
    automationEnabled: parsed.automationEnabled ?? DEFAULT_SETTINGS.automationEnabled,
    automationInboxDirectory:
      parsed.automationInboxDirectory ??
      parsed.automationWatchDirectory ??
      DEFAULT_SETTINGS.automationInboxDirectory,
    automationSourceLibraryDirectory:
      parsed.automationSourceLibraryDirectory ?? DEFAULT_SETTINGS.automationSourceLibraryDirectory,
    automationMirrorLibraryDirectory:
      parsed.automationMirrorLibraryDirectory ??
      parsed.automationLibraryDirectory ??
      DEFAULT_SETTINGS.automationMirrorLibraryDirectory,
    automationMovieSourceDirectory:
      parsed.automationMovieSourceDirectory ?? DEFAULT_SETTINGS.automationMovieSourceDirectory,
    automationMovieMirrorDirectory:
      parsed.automationMovieMirrorDirectory ?? DEFAULT_SETTINGS.automationMovieMirrorDirectory,
    automationSourceId: normalizeAutomationSourceId(parsed.automationSourceId),
    automationSettleSeconds: normalizeAutomationSettleSeconds(parsed.automationSettleSeconds),
    notifyOnFiled: parsed.notifyOnFiled ?? DEFAULT_SETTINGS.notifyOnFiled,
    notifyOnFailure: parsed.notifyOnFailure ?? DEFAULT_SETTINGS.notifyOnFailure
  };
}

// Merge incoming changes with the stored settings, normalize them, and persist the result.
export async function saveSettings(input: Partial<AppSettings>): Promise<AppSettings> {
  const nextSettings = {
    ...(await getSettings()),
    ...normalizeSettings(input)
  };

  await writeJsonFileAtomic(getSettingsPath(), nextSettings);

  return nextSettings;
}

// Store settings inside Electron's userData directory so they survive app upgrades.
function getSettingsPath(): string {
  return path.join(app.getPath("userData"), "settings.json");
}

// Trim, clamp, and sanitize input values before they are written to disk. Only fields present in
// the input are returned, so saving one setting never resets the others to their defaults.
function normalizeSettings(input: Partial<AppSettings>): Partial<AppSettings> {
  const output: Partial<AppSettings> = {};
  const text = (value: string | undefined) => (value === undefined ? undefined : value.trim());

  const assign = <K extends keyof AppSettings>(key: K, value: AppSettings[K] | undefined) => {
    if (value !== undefined) {
      output[key] = value;
    }
  };

  assign("tmdbBearerToken", text(input.tmdbBearerToken));
  assign("tvdbApiKey", text(input.tvdbApiKey));
  assign("tvdbPin", text(input.tvdbPin));
  if (input.defaultLanguage !== undefined) {
    assign("defaultLanguage", input.defaultLanguage.trim() || DEFAULT_SETTINGS.defaultLanguage);
  }
  assign("launchAtLogin", input.launchAtLogin);
  assign("automationEnabled", input.automationEnabled);
  assign("automationInboxDirectory", text(input.automationInboxDirectory));
  assign("automationSourceLibraryDirectory", text(input.automationSourceLibraryDirectory));
  assign("automationMirrorLibraryDirectory", text(input.automationMirrorLibraryDirectory));
  assign("automationMovieSourceDirectory", text(input.automationMovieSourceDirectory));
  assign("automationMovieMirrorDirectory", text(input.automationMovieMirrorDirectory));
  if (input.automationSourceId !== undefined) {
    assign("automationSourceId", normalizeAutomationSourceId(input.automationSourceId));
  }
  if (input.automationSettleSeconds !== undefined) {
    assign("automationSettleSeconds", normalizeAutomationSettleSeconds(input.automationSettleSeconds));
  }
  assign("notifyOnFiled", input.notifyOnFiled);
  assign("notifyOnFailure", input.notifyOnFailure);

  return output;
}

// Accept only provider IDs the rest of the app knows how to handle.
function normalizeAutomationSourceId(value: AppSettings["automationSourceId"] | undefined): AppSettings["automationSourceId"] {
  return value === "tmdb" || value === "tvdb" || value === "local"
    ? value
    : DEFAULT_SETTINGS.automationSourceId;
}

// Keep the settle window inside a reasonable range for the automation watcher.
function normalizeAutomationSettleSeconds(value: number | undefined): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return DEFAULT_SETTINGS.automationSettleSeconds;
  }

  return Math.max(10, Math.min(600, Math.round(value)));
}
