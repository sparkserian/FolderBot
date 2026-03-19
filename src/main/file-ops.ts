// Cross-platform file move helpers shared by manual renames, undo, and automation flows.
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

// Move a file while handling same-path renames and cross-volume fallbacks safely.
export async function moveFile(sourcePath: string, targetPath: string): Promise<void> {
  if (sourcePath === targetPath) {
    return;
  }

  await ensureParentDirectory(targetPath);

  if (isSameFilesystemPath(sourcePath, targetPath)) {
    await renameWithTempHop(sourcePath, targetPath);
    return;
  }

  if (await pathExists(targetPath)) {
    throw new Error("Target already exists");
  }

  if (shouldUseCopyFallback(sourcePath, targetPath)) {
    await copyAndRemove(sourcePath, targetPath);
    return;
  }

  try {
    await fs.rename(sourcePath, targetPath);
  } catch (error) {
    const renameError = error as NodeJS.ErrnoException;

    if (!canFallbackToCopy(renameError, sourcePath, targetPath)) {
      throw error;
    }

    await copyAndRemove(sourcePath, targetPath);
  }
}

// Conflict checks treat case-only renames on the same path as safe.
export async function targetExistsForRename(sourcePath: string, targetPath: string): Promise<boolean> {
  if (sourcePath === targetPath || isSameFilesystemPath(sourcePath, targetPath)) {
    return false;
  }

  return pathExists(targetPath);
}

// Windows blocks a few reserved basenames, so outputs are normalized here.
export function sanitizeWindowsReservedName(value: string): string {
  const match = value.match(/^(.*?)(\.[^.]+)?$/);
  const basename = match?.[1] ?? value;
  const extension = match?.[2] ?? "";

  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(basename)) {
    return `${basename}_${extension}`;
  }

  return value;
}

// Normalize paths before comparing them so case-insensitive filesystems behave correctly.
function isSameFilesystemPath(leftPath: string, rightPath: string): boolean {
  return normalizePathForComparison(leftPath) === normalizePathForComparison(rightPath);
}

// Windows cannot rename directly across drive roots, so those moves use copy/remove.
function shouldUseCopyFallback(sourcePath: string, targetPath: string): boolean {
  return process.platform === "win32" && getPathRoot(sourcePath) !== getPathRoot(targetPath);
}

// Some rename failures are safe to retry with a copy/remove fallback.
function canFallbackToCopy(
  error: NodeJS.ErrnoException,
  sourcePath: string,
  targetPath: string
): boolean {
  if (error.code === "EXDEV") {
    return true;
  }

  if (process.platform !== "win32") {
    return false;
  }

  return (
    (error.code === "EPERM" || error.code === "EACCES") &&
    getPathRoot(sourcePath) !== getPathRoot(targetPath)
  );
}

// Lowercasing Windows paths keeps path comparisons predictable.
function normalizePathForComparison(filePath: string): string {
  const resolvedPath = path.resolve(filePath);
  return process.platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath;
}

// Drive roots are used to distinguish same-volume and cross-volume operations.
function getPathRoot(filePath: string): string {
  return normalizePathForComparison(path.parse(filePath).root);
}

// Small helper shared by the move and conflict-detection code paths.
async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

// Create the target parent directory when needed, but avoid mkdir calls on drive roots.
async function ensureParentDirectory(filePath: string): Promise<void> {
  const parentDirectory = path.dirname(filePath);
  const rootDirectory = path.parse(parentDirectory).root;

  if (normalizePathForComparison(parentDirectory) === normalizePathForComparison(rootDirectory)) {
    return;
  }

  await fs.mkdir(parentDirectory, { recursive: true });
}

// A temp-hop rename safely handles case-only renames on case-insensitive filesystems.
async function renameWithTempHop(sourcePath: string, targetPath: string): Promise<void> {
  const tempPath = path.join(
    path.dirname(sourcePath),
    `.folderbot-rename-${randomUUID()}${path.extname(sourcePath)}`
  );

  await fs.rename(sourcePath, tempPath);

  try {
    await fs.rename(tempPath, targetPath);
  } catch (error) {
    await fs.rename(tempPath, sourcePath).catch(() => undefined);
    throw error;
  }
}

// Cross-volume moves fall back to copy + delete with rollback if delete fails.
async function copyAndRemove(sourcePath: string, targetPath: string): Promise<void> {
  await fs.copyFile(sourcePath, targetPath);

  try {
    await fs.unlink(sourcePath);
  } catch (error) {
    await fs.unlink(targetPath).catch(() => undefined);
    throw error;
  }
}
