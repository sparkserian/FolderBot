import { promises as fs } from "node:fs";
import path from "node:path";
import { app } from "electron";
import type { AppSettings } from "../shared/types";

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

export async function getSettings(): Promise<AppSettings> {
  const settingsPath = getSettingsPath();

  try {
    const contents = await fs.readFile(settingsPath, "utf8");
    const parsed = JSON.parse(contents) as Partial<AppSettings> & {
      automationWatchDirectory?: string;
      automationLibraryDirectory?: string;
    };

    return {
      tmdbBearerToken: parsed.tmdbBearerToken ?? DEFAULT_SETTINGS.tmdbBearerToken,
      tvdbApiKey: parsed.tvdbApiKey ?? DEFAULT_SETTINGS.tvdbApiKey,
      tvdbPin: parsed.tvdbPin ?? DEFAULT_SETTINGS.tvdbPin,
      defaultLanguage: parsed.defaultLanguage ?? DEFAULT_SETTINGS.defaultLanguage,
      automationEnabled: parsed.automationEnabled ?? DEFAULT_SETTINGS.automationEnabled,
      automationInboxDirectory:
        parsed.automationInboxDirectory ??
        parsed.automationWatchDirectory ??
        DEFAULT_SETTINGS.automationInboxDirectory,
      automationSourceLibraryDirectory:
        parsed.automationSourceLibraryDirectory ??
        DEFAULT_SETTINGS.automationSourceLibraryDirectory,
      automationMirrorLibraryDirectory:
        parsed.automationMirrorLibraryDirectory ??
        parsed.automationLibraryDirectory ??
        DEFAULT_SETTINGS.automationMirrorLibraryDirectory,
      automationSourceId: normalizeAutomationSourceId(parsed.automationSourceId),
      automationSettleSeconds: normalizeAutomationSettleSeconds(parsed.automationSettleSeconds)
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return DEFAULT_SETTINGS;
    }

    throw error;
  }
}

export async function saveSettings(input: Partial<AppSettings>): Promise<AppSettings> {
  const nextSettings = {
    ...(await getSettings()),
    ...normalizeSettings(input)
  };

  await fs.mkdir(path.dirname(getSettingsPath()), { recursive: true });
  await fs.writeFile(getSettingsPath(), JSON.stringify(nextSettings, null, 2), "utf8");

  return nextSettings;
}

function getSettingsPath(): string {
  return path.join(app.getPath("userData"), "settings.json");
}

function normalizeSettings(input: Partial<AppSettings>): Partial<AppSettings> {
  return {
    tmdbBearerToken: input.tmdbBearerToken?.trim(),
    tvdbApiKey: input.tvdbApiKey?.trim(),
    tvdbPin: input.tvdbPin?.trim(),
    defaultLanguage: input.defaultLanguage?.trim() || DEFAULT_SETTINGS.defaultLanguage,
    automationEnabled: input.automationEnabled ?? DEFAULT_SETTINGS.automationEnabled,
    automationInboxDirectory: input.automationInboxDirectory?.trim() ?? DEFAULT_SETTINGS.automationInboxDirectory,
    automationSourceLibraryDirectory:
      input.automationSourceLibraryDirectory?.trim() ?? DEFAULT_SETTINGS.automationSourceLibraryDirectory,
    automationMirrorLibraryDirectory:
      input.automationMirrorLibraryDirectory?.trim() ?? DEFAULT_SETTINGS.automationMirrorLibraryDirectory,
    automationSourceId: normalizeAutomationSourceId(input.automationSourceId),
    automationSettleSeconds: normalizeAutomationSettleSeconds(input.automationSettleSeconds)
  };
}

function normalizeAutomationSourceId(value: AppSettings["automationSourceId"] | undefined): AppSettings["automationSourceId"] {
  return value === "tmdb" || value === "tvdb" || value === "local"
    ? value
    : DEFAULT_SETTINGS.automationSourceId;
}

function normalizeAutomationSettleSeconds(value: number | undefined): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return DEFAULT_SETTINGS.automationSettleSeconds;
  }

  return Math.max(10, Math.min(600, Math.round(value)));
}
