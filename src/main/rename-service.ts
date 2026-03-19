// Shared rename preview and execution logic used by the manual and automation workflows.
import { promises as fs } from "node:fs";
import path from "node:path";
import { formatEpisodeCode, parseMediaName, toDisplayTitle } from "../shared/filename-parser";
import type {
  ApplyRenameRequest,
  PreviewRequest,
  RenamePreview,
  RenameResult,
  ResolvedMetadata
} from "../shared/types";
import { moveFile, sanitizeWindowsReservedName, targetExistsForRename } from "./file-ops";
import { createProviders } from "./providers";

const INVALID_FILENAME_CHARS = /[<>:"/\\|?*\u0000-\u001F]/g;
const PREVIEW_CONCURRENCY = 8;

const providers = createProviders();

// Surface provider readiness and credential state to the renderer.
export function getProviderStatuses(options: PreviewRequest["options"]) {
  return providers.map((provider) => provider.getStatus(options));
}

// Build rename previews for a batch of files, including metadata, warnings, and conflicts.
export async function previewRenames(request: PreviewRequest): Promise<RenamePreview[]> {
  const provider = providers.find((entry) => entry.id === request.options.sourceId) ?? providers[0];

  const previews = await mapWithConcurrency(request.filePaths, PREVIEW_CONCURRENCY, async (filePath) => {
      const currentName = path.basename(filePath);
      const currentDirectory = path.dirname(filePath);
      const parsed = parseMediaName(currentName);
      const effectiveParsed = applyManualTitleOverride(parsed, request.options.manualTitle);
      const providerResult = await provider.resolve(effectiveParsed, request.options);
      const metadata = providerResult.metadata ?? localFallbackMetadata(effectiveParsed);
      const targetName = buildTargetName(metadata, effectiveParsed, currentName);
      const targetDirectory = request.options.destinationDirectory || currentDirectory;
      const targetPath = path.join(targetDirectory, targetName);
      const conflicts = await detectConflicts(filePath, targetPath);

      return {
        id: filePath,
        sourcePath: filePath,
        currentName,
        currentDirectory,
        parsed: effectiveParsed,
        metadata,
        targetName,
        targetPath,
        warnings: [
          ...parsed.warnings,
          ...(request.options.manualTitle ? ["Using the manual title override for matching."] : []),
          ...providerResult.warnings
        ],
        conflicts
      };
    });

  const duplicateTargets = new Set(
    previews
      .map((item) => item.targetPath)
      .filter((targetPath, index, values) => values.indexOf(targetPath) !== index)
  );

  return previews.map((item) => ({
    ...item,
    conflicts: duplicateTargets.has(item.targetPath)
      ? [...item.conflicts, "Another queued file resolves to the same target path."]
      : item.conflicts
  }));
}

// Apply the prepared rename batch and capture a result for every item.
export async function applyRenames(request: ApplyRenameRequest): Promise<RenameResult[]> {
  const results: RenameResult[] = [];

  for (const item of request.items) {
    try {
      if (item.sourcePath === item.targetPath) {
        results.push({
          sourcePath: item.sourcePath,
          targetPath: item.targetPath,
          success: true
        });
        continue;
      }

      await moveFile(item.sourcePath, item.targetPath);

      results.push({
        sourcePath: item.sourcePath,
        targetPath: item.targetPath,
        success: true
      });
    } catch (error) {
      const fileError = error as NodeJS.ErrnoException;
      results.push({
        sourcePath: item.sourcePath,
        targetPath: item.targetPath,
        success: false,
        error: fileError?.code
          ? `${fileError.code}: ${fileError.message}`
          : error instanceof Error
            ? error.message
            : "Unknown rename error"
      });
    }
  }

  return results;
}

// Build the output filename using whichever metadata is available for the file.
function buildTargetName(
  metadata: ResolvedMetadata,
  parsed: RenamePreview["parsed"],
  currentName: string
): string {
  const extension = path.extname(currentName);
  const displayTitle = sanitizeFileSegment(metadata.displayTitle || parsed.normalizedTitle) || "Untitled";

  if (parsed.kind === "episode") {
    const code = formatEpisodeCode(metadata.season ?? parsed.season, metadata.episode ?? parsed.episode, parsed.absoluteEpisode);
    const episodeTitle = sanitizeFileSegment(metadata.episodeTitle || "");
    const suffix = episodeTitle ? ` - ${episodeTitle}` : "";
    return `${displayTitle} - ${code}${suffix}${extension}`;
  }

  if (parsed.kind === "movie") {
    const releaseYear = metadata.year ?? parsed.year;
    const yearSuffix = releaseYear ? ` (${releaseYear})` : "";
    return `${displayTitle}${yearSuffix}${extension}`;
  }

  return `${displayTitle}${extension}`;
}

// Local fallback metadata keeps the app usable even when online lookups fail.
function localFallbackMetadata(parsed: RenamePreview["parsed"]): ResolvedMetadata {
  return {
    sourceId: "local",
    displayTitle: toDisplayTitle(parsed.normalizedTitle),
    year: parsed.year,
    season: parsed.season,
    episode: parsed.episode
  };
}

// Manual title override replaces only the title used for matching, not the episode numbers.
function applyManualTitleOverride(
  parsed: RenamePreview["parsed"],
  manualTitle?: string
): RenamePreview["parsed"] {
  const title = manualTitle?.trim();
  if (!title) {
    return parsed;
  }

  return {
    ...parsed,
    normalizedTitle: toDisplayTitle(title)
  };
}

// Conflict detection runs during preview so users can see problems before renaming.
async function detectConflicts(sourcePath: string, targetPath: string): Promise<string[]> {
  if (sourcePath === targetPath) {
    return [];
  }

  try {
    const exists = await targetExistsForRename(sourcePath, targetPath);
    return exists ? ["Target file already exists."] : [];
  } catch (error) {
    return ["Could not verify whether the target already exists."];
  }
}

// Remove invalid path characters while keeping filenames readable.
function sanitizeFileSegment(value: string): string {
  const sanitized = value
    .replace(INVALID_FILENAME_CHARS, "")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();

  return sanitizeWindowsReservedName(sanitized);
}

// Bounded parallelism keeps large preview batches fast without flooding provider lookups.
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }

  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;

      if (currentIndex >= items.length) {
        return;
      }

      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}
