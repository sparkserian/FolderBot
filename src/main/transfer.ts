// Copies and moves that report progress, so the watcher can show what a 20 GB transfer is doing.
//
// A copy is written to "<target>.folderbot-partial" and renamed into place only once every byte
// has landed, so a library never shows a half-written file and an interrupted copy leaves
// nothing behind but the partial, which is removed.
import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";

const CHUNK_BYTES = 8 * 1024 * 1024;
const PARTIAL_SUFFIX = ".folderbot-partial";

export interface TransferProgress {
  bytesDone: number;
  bytesTotal: number;
  bytesPerSecond: number;
  etaSeconds: number | null;
}

export interface TransferOptions {
  signal?: AbortSignal;
  onProgress?: (progress: TransferProgress) => void;
}

// Copy a file with progress. Fails if the target already exists.
export async function copyWithProgress(sourcePath: string, targetPath: string, options: TransferOptions = {}): Promise<void> {
  const stats = await fs.stat(sourcePath);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });

  if (await exists(targetPath)) {
    throw Object.assign(new Error(`A file named "${path.basename(targetPath)}" is already there`), { code: "EEXIST", path: targetPath });
  }

  const partialPath = `${targetPath}${PARTIAL_SUFFIX}`;
  await fs.rm(partialPath, { force: true });

  const meter = createMeter(stats.size, options.onProgress);

  try {
    await pipeline(
      createReadStream(sourcePath, { highWaterMark: CHUNK_BYTES }),
      meter.stream,
      createWriteStream(partialPath, { flags: "wx", highWaterMark: CHUNK_BYTES }),
      { signal: options.signal }
    );

    const written = await fs.stat(partialPath);
    if (written.size !== stats.size) {
      throw new Error(`The copy is incomplete: ${written.size} of ${stats.size} bytes were written`);
    }

    await fs.utimes(partialPath, stats.atime, stats.mtime).catch(() => undefined);
    await fs.rename(partialPath, targetPath);
    meter.finish();
  } catch (error) {
    await fs.rm(partialPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

// Move a file. Same-volume moves are an instant rename; anything else is a copy with progress
// followed by deleting the original.
export async function moveWithProgress(sourcePath: string, targetPath: string, options: TransferOptions = {}): Promise<"renamed" | "copied"> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });

  if (await exists(targetPath)) {
    throw Object.assign(new Error(`A file named "${path.basename(targetPath)}" is already there`), { code: "EEXIST", path: targetPath });
  }

  if (sameVolume(sourcePath, targetPath)) {
    try {
      await fs.rename(sourcePath, targetPath);
      const size = (await fs.stat(targetPath)).size;
      options.onProgress?.({ bytesDone: size, bytesTotal: size, bytesPerSecond: 0, etaSeconds: 0 });
      return "renamed";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") {
        throw error;
      }
    }
  }

  await copyWithProgress(sourcePath, targetPath, options);
  await fs.unlink(sourcePath);
  return "copied";
}

// True when a move between these paths can be a plain rename.
export function sameVolume(leftPath: string, rightPath: string): boolean {
  const root = (value: string) => {
    const parsed = path.parse(path.resolve(value)).root;
    return process.platform === "win32" ? parsed.toLowerCase() : parsed;
  };

  if (process.platform === "win32") {
    return root(leftPath) === root(rightPath);
  }

  // On macOS and Linux every path shares "/", so the rename attempt itself detects EXDEV.
  return true;
}

// Free space on the drive holding a path, or null when the platform cannot say.
export async function freeBytes(targetDirectory: string): Promise<number | null> {
  try {
    const stats = await fs.statfs(await nearestExistingDirectory(targetDirectory));
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

async function nearestExistingDirectory(directory: string): Promise<string> {
  let current = path.resolve(directory);

  while (!(await exists(current))) {
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return current;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

// Counts bytes as they pass and reports at most four times a second, with speed averaged over
// the last few seconds so the time-left estimate does not jump around.
function createMeter(total: number, onProgress?: (progress: TransferProgress) => void) {
  let done = 0;
  let lastReport = 0;
  const samples: Array<{ at: number; bytes: number }> = [{ at: Date.now(), bytes: 0 }];

  const report = (force = false) => {
    const now = Date.now();
    if (!onProgress || (!force && now - lastReport < 250)) {
      return;
    }

    lastReport = now;
    samples.push({ at: now, bytes: done });
    while (samples.length > 2 && now - samples[0].at > 5_000) {
      samples.shift();
    }

    const first = samples[0];
    const seconds = (now - first.at) / 1000;
    const bytesPerSecond = seconds > 0 ? (done - first.bytes) / seconds : 0;
    const remaining = Math.max(0, total - done);

    onProgress({
      bytesDone: done,
      bytesTotal: total,
      bytesPerSecond,
      etaSeconds: bytesPerSecond > 0 ? Math.round(remaining / bytesPerSecond) : null
    });
  };

  const stream = new Transform({
    highWaterMark: CHUNK_BYTES,
    transform(chunk: Buffer, _encoding, callback) {
      done += chunk.length;
      report();
      callback(null, chunk);
    }
  });

  return {
    stream,
    finish: () => {
      done = total;
      report(true);
    }
  };
}
