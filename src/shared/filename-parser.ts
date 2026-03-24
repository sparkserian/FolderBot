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
  "hdr10",
  "hdr10+",
  "uhd",
  "10bit",
  "aac",
  "ddp",
  "atmos",
  "dovi",
  "dv",
  "dolbyvision",
  "dolby-vision",
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

const MOVIE_SOURCE_PATTERNS = [
  { pattern: /\bremux\b/i, label: "Remux" },
  { pattern: /\bweb[ ._-]?rip\b/i, label: "WEBRip" },
  { pattern: /\bweb[ ._-]?dl\b/i, label: "WEB-DL" },
  { pattern: /\bblu[ ._-]?ray\b/i, label: "BluRay" },
  { pattern: /\bbd[ ._-]?rip\b/i, label: "BDRip" },
  { pattern: /\bbr[ ._-]?rip\b/i, label: "BRRip" },
  { pattern: /\bdvd[ ._-]?rip\b/i, label: "DVDRip" },
  { pattern: /\bhd[ ._-]?rip\b/i, label: "HDRip" }
] as const;

const MOVIE_CODEC_PATTERNS = [
  { pattern: /\bx265\b/i, label: "x265" },
  { pattern: /\bx264\b/i, label: "x264" },
  { pattern: /\bhevc\b/i, label: "HEVC" },
  { pattern: /\bh265\b/i, label: "H265" },
  { pattern: /\bh264\b/i, label: "H264" }
] as const;

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
    const movieDetails = extractMovieDetails(movieMatch[3] || "");
    return {
      kind: "movie",
      originalTitle: fileName,
      normalizedTitle: title || "Unknown Movie",
      year: Number.parseInt(movieMatch[2], 10),
      sourceTag: movieDetails.sourceTag,
      videoTags: movieDetails.videoTags,
      videoCodecTag: movieDetails.videoCodecTag,
      resolution: movieDetails.resolution,
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

function extractMovieDetails(value: string): {
  sourceTag?: string;
  videoTags: string[];
  videoCodecTag?: string;
  resolution?: string;
} {
  const normalizedValue = normalizeSeparators(value).toLowerCase();
  const sourceTag = MOVIE_SOURCE_PATTERNS.find((entry) => entry.pattern.test(normalizedValue))?.label;
  const videoCodecTag = MOVIE_CODEC_PATTERNS.find((entry) => entry.pattern.test(normalizedValue))?.label;
  const videoTags: string[] = [];

  if (/\bhdr10\+\b/i.test(normalizedValue)) {
    videoTags.push("HDR10+");
  } else if (/\bhdr10\b/i.test(normalizedValue)) {
    videoTags.push("HDR10");
  } else if (/\bhdr\b/i.test(normalizedValue)) {
    videoTags.push("HDR");
  }

  if (/\b(?:dovi|dolby[ ._-]?vision|dv)\b/i.test(normalizedValue)) {
    videoTags.push("DV");
  }

  const resolution = normalizedValue.match(/\b(2160p|1080p|720p|480p)\b/i)?.[1];

  return {
    sourceTag,
    videoTags,
    videoCodecTag,
    resolution: resolution ? `${resolution.slice(0, -1)}p` : undefined
  };
}
