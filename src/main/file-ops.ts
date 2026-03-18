import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

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

export async function targetExistsForRename(sourcePath: string, targetPath: string): Promise<boolean> {
  if (sourcePath === targetPath || isSameFilesystemPath(sourcePath, targetPath)) {
    return false;
  }

  return pathExists(targetPath);
}

export function sanitizeWindowsReservedName(value: string): string {
  const match = value.match(/^(.*?)(\.[^.]+)?$/);
  const basename = match?.[1] ?? value;
  const extension = match?.[2] ?? "";

  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(basename)) {
    return `${basename}_${extension}`;
  }

  return value;
}

function isSameFilesystemPath(leftPath: string, rightPath: string): boolean {
  return normalizePathForComparison(leftPath) === normalizePathForComparison(rightPath);
}

function shouldUseCopyFallback(sourcePath: string, targetPath: string): boolean {
  return process.platform === "win32" && getPathRoot(sourcePath) !== getPathRoot(targetPath);
}

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

function normalizePathForComparison(filePath: string): string {
  const resolvedPath = path.resolve(filePath);
  return process.platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath;
}

function getPathRoot(filePath: string): string {
  return normalizePathForComparison(path.parse(filePath).root);
}

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

async function ensureParentDirectory(filePath: string): Promise<void> {
  const parentDirectory = path.dirname(filePath);
  const rootDirectory = path.parse(parentDirectory).root;

  if (normalizePathForComparison(parentDirectory) === normalizePathForComparison(rootDirectory)) {
    return;
  }

  await fs.mkdir(parentDirectory, { recursive: true });
}

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

async function copyAndRemove(sourcePath: string, targetPath: string): Promise<void> {
  await fs.copyFile(sourcePath, targetPath);

  try {
    await fs.unlink(sourcePath);
  } catch (error) {
    await fs.unlink(targetPath).catch(() => undefined);
    throw error;
  }
}
