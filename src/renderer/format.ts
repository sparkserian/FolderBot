// Formatting helpers for sizes, speeds, durations and paths.
import type { AutomationJob, MetadataSourceId } from "../shared/types";

export const SOURCE_LABELS: Record<MetadataSourceId, string> = {
  local: "Filename only",
  tmdb: "TMDb",
  tvdb: "TheTVDB"
};

export function formatBytes(bytes: number | undefined): string {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** exponent;
  return `${value >= 100 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`;
}

export function formatSpeed(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

// "about 3 min left", "less than a minute left"
export function formatEta(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) {
    return "working out time left";
  }
  if (seconds < 45) {
    return "less than a minute left";
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `about ${minutes} min left`;
  }
  const hours = Math.floor(minutes / 60);
  return `about ${hours} h ${minutes % 60} min left`;
}

export function formatElapsed(fromIso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(fromIso)) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return `${hours} h ${minutes % 60} min`;
  }
  return `${Math.floor(hours / 24)} days`;
}

export function formatRelative(iso: string, now: number): string {
  const seconds = Math.round((now - Date.parse(iso)) / 1000);
  if (seconds < 10) {
    return "just now";
  }
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  return formatClock(iso);
}

export function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function formatDayHeading(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);

  if (date.toDateString() === today.toDateString()) {
    return "Today";
  }
  if (date.toDateString() === yesterday.toDateString()) {
    return "Yesterday";
  }
  return date.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: date.getFullYear() === today.getFullYear() ? undefined : "numeric"
  });
}

export function fileName(fullPath: string): string {
  return fullPath.split(/[\\/]/).at(-1) ?? fullPath;
}

export function folderOf(fullPath: string): string {
  const parts = fullPath.split(/[\\/]/);
  const separator = fullPath.includes("\\") ? "\\" : "/";
  return parts.slice(0, -1).join(separator);
}

export function plural(count: number, word: string, pluralWord = `${word}s`): string {
  return `${count} ${count === 1 ? word : pluralWord}`;
}

export const STAGE_LABELS: Record<AutomationJob["stage"], string> = {
  arriving: "Arriving",
  settling: "Settling",
  locked: "In use",
  queued: "Ready",
  matching: "Looking up",
  copying: "Copying",
  moving: "Moving",
  filed: "Filed",
  failed: "Failed",
  skipped: "Skipped"
};
