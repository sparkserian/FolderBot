// Filename parsing helpers that turn release-style file names into structured media data.
import type { ParsedMedia } from "./types";

const MEDIA_NOISE = [
  "2160p",
  "1080p",
  "720p",
  "480p",
  "x264",
  "x265",
  "h264",
  "h265",
  "hevc",
  "webrip",
  "webdl",
  "web-dl",
  "bluray",
  "brrip",
  "dvdrip",
  "hdrip",
  "remux",
  "proper",
  "repack",
  "extended",
  "limited",
  "hdr",
  "uhd",
  "10bit",
  "aac",
  "ddp",
  "atmos",
  "amzn",
  "nf",
  "dsnp",
  "hmax",
  "yts",
  "rarbg",
  "subs",
  "dubbed"
];

const EPISODE_PATTERNS = [
  /^(.*?)[\s._-]+s(\d{1,2})e(\d{1,2})(?:e\d{1,2})?(.*)$/i,
  /^(.*?)[\s._-]+(\d{1,2})x(\d{1,2})(.*)$/i,
  /^(.*?)[\s._-]+season[\s._-]*(\d{1,2})[\s._-]+episode[\s._-]*(\d{1,2})(.*)$/i
];

const TITLELESS_EPISODE_PATTERNS = [
  /^s(\d{1,2})e(\d{1,2})(?:e\d{1,2})?[\s._-]*(.*)$/i,
  /^(\d{1,2})x(\d{1,2})[\s._-]*(.*)$/i,
  /^season[\s._-]*(\d{1,2})[\s._-]+episode[\s._-]*(\d{1,2})[\s._-]*(.*)$/i
];

const ABSOLUTE_EPISODE_PATTERN =
  /^(?:\[[^\]]+\][\s._-]*)?(.*?)[\s._-]+-\s*(\d{1,3})(?:\D.*)?$/i;

const MOVIE_PATTERN =
  /^(.*?)[\s._(\[]((?:19|20)\d{2})(?:[)\]\s._-]|$)(.*)$/i;

// Parse a raw filename into the structured media shape the rest of the app uses.
export function parseMediaName(fileName: string): ParsedMedia {
  const nameWithoutExtension = fileName.replace(/\.[^/.]+$/, "");
  const normalizedInput = normalizeSeparators(nameWithoutExtension);

  for (const pattern of EPISODE_PATTERNS) {
    const match = normalizedInput.match(pattern);
    if (!match) {
      continue;
    }

    const title = cleanupTitle(match[1]);
    const season = Number.parseInt(match[2], 10);
    const episode = Number.parseInt(match[3], 10);

    return {
      kind: "episode",
      originalTitle: fileName,
      normalizedTitle: title || "Unknown Series",
      season,
      episode,
      confidence: 0.94,
      warnings: title ? [] : ["Could not confidently extract a series title."]
    };
  }

  for (const pattern of TITLELESS_EPISODE_PATTERNS) {
    const match = normalizedInput.match(pattern);
    if (!match) {
      continue;
    }

    const season = Number.parseInt(match[1], 10);
    const episode = Number.parseInt(match[2], 10);
    const trailingTitle = cleanupTitle(match[3] || "");

    return {
      kind: "episode",
      originalTitle: fileName,
      normalizedTitle: trailingTitle || "Unknown Series",
      season,
      episode,
      confidence: 0.82,
      warnings: [
        "Detected season and episode numbers without a clear series title.",
        ...(trailingTitle ? ["Use Title override if the trailing text is an episode title rather than the series name."] : [])
      ]
    };
  }

  const absoluteMatch = normalizedInput.match(ABSOLUTE_EPISODE_PATTERN);
  if (absoluteMatch) {
    const title = cleanupTitle(absoluteMatch[1]);
    const absoluteEpisode = Number.parseInt(absoluteMatch[2], 10);
    return {
      kind: "episode",
      originalTitle: fileName,
      normalizedTitle: title || "Unknown Series",
      absoluteEpisode,
      confidence: 0.7,
      warnings: [
        "Detected an absolute episode number. Season mapping may require metadata."
      ]
    };
  }

  const movieMatch = normalizedInput.match(MOVIE_PATTERN);
  if (movieMatch) {
    const title = cleanupTitle(movieMatch[1]);
    return {
      kind: "movie",
      originalTitle: fileName,
      normalizedTitle: title || "Unknown Movie",
      year: Number.parseInt(movieMatch[2], 10),
      confidence: 0.86,
      warnings: title ? [] : ["Could not confidently extract a movie title."]
    };
  }

  const fallbackTitle = cleanupTitle(normalizedInput);
  return {
    kind: "unknown",
    originalTitle: fileName,
    normalizedTitle: fallbackTitle || "Unclassified Media",
    confidence: 0.32,
    warnings: ["Pattern did not match a standard movie or episode release name."]
  };
}

// Convert parsed episode numbers into the standard code used in renamed files.
export function formatEpisodeCode(
  season?: number,
  episode?: number,
  absoluteEpisode?: number
): string {
  if (typeof season === "number" && typeof episode === "number") {
    return `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
  }

  if (typeof absoluteEpisode === "number") {
    return String(absoluteEpisode).padStart(2, "0");
  }

  return "Unsorted";
}

// Normalize human-readable titles so UI labels and filenames are consistent.
export function toDisplayTitle(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      if (word === word.toUpperCase() && word.length <= 4) {
        return word;
      }

      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(" ");
}

// Collapse the most common release separators before attempting regex matches.
function normalizeSeparators(value: string): string {
  return value.replace(/[._]+/g, " ").replace(/\s+/g, " ").trim();
}

// Remove release noise and punctuation from a captured title fragment.
function cleanupTitle(value: string): string {
  const noisePattern = new RegExp(`\\b(?:${MEDIA_NOISE.join("|")})\\b`, "gi");

  return toDisplayTitle(
    value
      .replace(/\[[^\]]+\]/g, " ")
      .replace(/\([^)]*\)/g, " ")
      .replace(noisePattern, " ")
      .replace(/[-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}
