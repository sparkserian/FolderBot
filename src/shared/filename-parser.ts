// Filename parsing helpers that turn release-style file names into structured media data.
import type { ParsedMedia } from "./types";

const MEDIA_NOISE = [
  "2160p",
  "1080p",
  "720p",
  "480p",
  "4k",
  "x264",
  "x265",
  "h264",
  "h265",
  "hevc",
  "av1",
  "xvid",
  "divx",
  "webrip",
  "webdl",
  "web-dl",
  "web",
  "bluray",
  "brrip",
  "bdrip",
  "dvdrip",
  "hdrip",
  "hdtv",
  "pdtv",
  "remux",
  "proper",
  "repack",
  "extended",
  "unrated",
  "limited",
  "internal",
  "hdr",
  "hdr10",
  "hdr10+",
  "sdr",
  "uhd",
  "imax",
  "10bit",
  "aac",
  "ac3",
  "eac3",
  "ddp",
  "dts",
  "truehd",
  "flac",
  "opus",
  "atmos",
  "dovi",
  "dv",
  "dolbyvision",
  "dolby-vision",
  "amzn",
  "nf",
  "dsnp",
  "hmax",
  "atvp",
  "itunes",
  "yts",
  "rarbg",
  "subs",
  "dubbed"
];

// Anything that is not a letter or digit counts as a separator. Release names put spaces,
// dots, underscores, dashes, brackets, dots, slashes, pipes, and stray punctuation between
// tokens, so the parser treats them all the same instead of guessing at a fixed list.
const SEP = "[^A-Za-z0-9]";
const SEP_OPT = `${SEP}*`;
const SEP_REQ = `${SEP}+`;

// A title must end in a letter or digit, which keeps a leading "[" from being read as the title.
const TITLE = "(.*?[A-Za-z0-9])";

// Matches S01E01 and every loose variant: "S01 E01", "S01_E01", "S01.E01", "S01 - E01",
// "S01xE01", "S01 | E01", "S1E1", "S01EP01", and "Season 1 Episode 2".
const SEASON_EPISODE = `s(?:eason)?${SEP_OPT}(\\d{1,4})${SEP_OPT}(?:x${SEP_OPT})?e(?:p(?:isode)?)?${SEP_OPT}(\\d{1,3})(?!\\d)`;

// Season marker followed by a bare episode number, as in "Show S01 05 Title".
const SEASON_BARE_EPISODE = `s(?:eason)?${SEP_OPT}(\\d{1,4})${SEP_REQ}(\\d{1,3})(?!\\d)`;

// Trailing part numbers of a multi-episode file: "E01E02", "E01-E02", "E01-02", "E01 & E02".
const EXTRA_EPISODES = `(?:${SEP_OPT}e\\d{1,3}|${SEP_OPT}[-&+]${SEP_OPT}\\d{1,3}(?![\\da-z]))*`;

// Matches the 1x02 style, including "01 x 02".
const CROSS_EPISODE = `(\\d{1,2})${SEP_OPT}x${SEP_OPT}(\\d{1,3})(?!\\d)`;

// Episode markers with no season, such as "Ep 5", "Episode 12", or "E07".
const EPISODE_ONLY = `(?:ep(?:isode)?${SEP_OPT}(\\d{1,3})|e(\\d{2,3}))(?!\\d)`;

const EPISODE_PATTERNS = [
  buildRegExp(`^${TITLE}${SEP_REQ}${SEASON_EPISODE}${EXTRA_EPISODES}(.*)$`),
  buildRegExp(`^${TITLE}${SEP_REQ}${CROSS_EPISODE}(.*)$`),
  buildRegExp(`^${TITLE}${SEP_REQ}${SEASON_BARE_EPISODE}(.*)$`)
];

const TITLELESS_EPISODE_PATTERNS = [
  buildRegExp(`^${SEP_OPT}${SEASON_EPISODE}${EXTRA_EPISODES}${SEP_OPT}(.*)$`),
  buildRegExp(`^${SEP_OPT}${CROSS_EPISODE}${SEP_OPT}(.*)$`)
];

const EPISODE_ONLY_PATTERN = buildRegExp(`^${TITLE}${SEP_REQ}${EPISODE_ONLY}(.*)$`);

const ABSOLUTE_EPISODE_PATTERN =
  /^(?:\[[^\]]+\][\s._-]*)?(.*?)[\s._-]+-\s*(\d{1,3})(?:\D.*)?$/i;

// Last-resort TV form where season and episode are fused into three digits, as in "Show 102".
const COMBINED_EPISODE_PATTERN = buildRegExp(`^(.*?)${SEP_REQ}([1-9])(\\d{2})(?![\\da-z])(.*)$`);

// A standalone four-digit year, wherever it sits in the name.
const YEAR_PATTERN = /(?<![A-Za-z0-9])((?:19|20)\d{2})(?![0-9])/g;

// Bracketed text that carries real information, so the prefix stripper leaves it alone.
const MEDIA_MARKER_PATTERN = /s\s*\d{1,4}\s*[-_.\s]*e\s*\d{1,3}|\d{1,2}\s*x\s*\d{1,3}|episode|(?:19|20)\d{2}/i;

// Site and release-group fluff that gets stapled to the front of a release name.
const RELEASE_PREFIX_PATTERNS: RegExp[] = [
  // www.anything, with or without a trailing dash
  /^www\.\S+[\s._-]*(?:[-–—][\s._-]*)?/i,
  // site.tld followed by a dash, the usual "SomeSite.com - Title" shape
  /^\S*\.(?:com|net|org|info|biz|me|tv|mx|to|cc|xyz|pw|ms|is|in|it|se|la|ag|co|uk|ru|eu|link|site|club|life|party|space|team|top|win|ws|nu|sx|tw|ph|id|vc|gs|st|onl|online|store|pro|live|fun|icu|cyou|lol|wiki|art)\b\s*[-–—]+\s*/i,
  // bare release-group names used as a prefix
  /^(?:yts|yify|rarbg|eztv|ettv|tgx|torrentgalaxy|1337x|galaxyrg|megusta|psa|qxr|tigole|shaanig|ganool|anoxmous|nogrp|successfulcrab|edith|elite)\b[\s._-]*(?:[-–—][\s._-]*)?/i
];


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
  const strippedInput = stripReleasePrefixes(nameWithoutExtension);
  const normalizedInput = normalizeSeparators(strippedInput);

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

  const releaseYear = selectReleaseYear(strippedInput);
  if (releaseYear) {
    const title = cleanupTitle(normalizeSeparators(strippedInput.slice(0, releaseYear.index)));
    const movieDetails = extractMovieDetails(strippedInput.slice(releaseYear.index + 4));
    return {
      kind: "movie",
      originalTitle: fileName,
      normalizedTitle: title || "Unknown Movie",
      year: releaseYear.year,
      sourceTag: movieDetails.sourceTag,
      videoTags: movieDetails.videoTags,
      videoCodecTag: movieDetails.videoCodecTag,
      resolution: movieDetails.resolution,
      confidence: 0.86,
      warnings: title ? [] : ["Could not confidently extract a movie title."]
    };
  }

  const episodeOnlyMatch = normalizedInput.match(EPISODE_ONLY_PATTERN);
  if (episodeOnlyMatch) {
    const title = cleanupTitle(episodeOnlyMatch[1]);
    const absoluteEpisode = Number.parseInt(episodeOnlyMatch[2] ?? episodeOnlyMatch[3], 10);
    return {
      kind: "episode",
      originalTitle: fileName,
      normalizedTitle: title || "Unknown Series",
      absoluteEpisode,
      confidence: 0.62,
      warnings: ["Found an episode number without a season. Season mapping may require metadata."]
    };
  }

  const combinedMatch = normalizedInput.match(COMBINED_EPISODE_PATTERN);
  const combinedTitle = combinedMatch ? cleanupTitle(combinedMatch[1]) : "";
  if (combinedMatch && combinedTitle) {
    return {
      kind: "episode",
      originalTitle: fileName,
      normalizedTitle: combinedTitle,
      season: Number.parseInt(combinedMatch[2], 10),
      episode: Number.parseInt(combinedMatch[3], 10),
      confidence: 0.55,
      warnings: [
        "Read the three-digit number as a season and episode. Check the result before renaming."
      ]
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

function buildRegExp(source: string): RegExp {
  return new RegExp(source, "i");
}

// Drop tracker sites, release-group tags, and other fluff pinned to the front of a name.
// Bracketed text that holds season, episode, or year information is kept.
function stripReleasePrefixes(value: string): string {
  let result = value.trim();

  for (let pass = 0; pass < 4; pass += 1) {
    const previous = result;
    const bracketMatch = result.match(/^[[({]([^\])}]*)[\])}][\s._-]*/);

    if (bracketMatch && !MEDIA_MARKER_PATTERN.test(bracketMatch[1])) {
      result = result.slice(bracketMatch[0].length);
    }

    for (const pattern of RELEASE_PREFIX_PATTERNS) {
      result = result.replace(pattern, "");
    }

    result = result.replace(/^[\s._\-–—|]+/, "").trim();

    if (!result || result === previous) {
      break;
    }
  }

  return result || value.trim();
}

// Pick which four-digit year in a name is the release year. A year inside brackets wins,
// because that is the convention. Otherwise the last year wins, so titles that contain a
// number of their own ("Blade Runner 2049 2017") keep the number as part of the title.
function selectReleaseYear(value: string): { year: number; index: number } | null {
  const candidates: { year: number; index: number; wrapped: boolean }[] = [];
  const pattern = new RegExp(YEAR_PATTERN.source, "g");
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(value)) !== null) {
    const before = value[match.index - 1];
    const after = value[match.index + 4];
    candidates.push({
      year: Number.parseInt(match[1], 10),
      index: match.index,
      wrapped: (before === "(" && after === ")") || (before === "[" && after === "]")
    });
  }

  if (candidates.length === 0) {
    return null;
  }

  const wrapped = candidates.filter((candidate) => candidate.wrapped);
  const pool = wrapped.length > 0 ? wrapped : candidates;

  for (let index = pool.length - 1; index >= 0; index -= 1) {
    if (cleanupTitle(normalizeSeparators(value.slice(0, pool[index].index)))) {
      return pool[index];
    }
  }

  return pool[pool.length - 1];
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
      // Slicing a title off in front of a year can leave a dangling bracket behind.
      .replace(/[[\](){}<>]/g, " ")
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
