// Crash-safe JSON storage for the app-owned state files in userData.
//
// Two failures used to be possible here and both were silent. A plain writeFile truncates the
// file before it writes, so a force-kill in that window (the installer does exactly this during
// an upgrade) leaves a half-written file behind. Reading that file then threw, and the throw
// travelled all the way to the renderer, where it blanked the History screen. Writes are now
// atomic, and a damaged file is salvaged rather than fatal.
import { promises as fs } from "node:fs";
import path from "node:path";

// Write through a temporary file so the real path only ever holds a complete document.
export async function writeJsonFileAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  const tempPath = `${filePath}.tmp`;
  const handle = await fs.open(tempPath, "w");

  try {
    await handle.writeFile(JSON.stringify(value, null, 2), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  await fs.rename(tempPath, filePath);
}

// Read an array file, recovering what is still intact if the document was cut short.
export async function readJsonArrayFile(filePath: string, label: string): Promise<unknown[]> {
  const contents = await readFileOrNull(filePath);

  if (contents === null) {
    return [];
  }

  try {
    const parsed = JSON.parse(contents) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    const salvaged = salvageJsonArray(contents);
    await quarantineDamagedFile(filePath, salvaged);
    console.error(
      `${label} was damaged and has been repaired. Recovered ${salvaged.length} record(s); the damaged copy was kept next to it.`
    );
    return salvaged;
  }
}

// Read an object file. A damaged document is set aside rather than quietly replaced, because
// for settings that would mean discarding the user's saved API credentials.
export async function readJsonObjectFile(
  filePath: string,
  label: string
): Promise<Record<string, unknown> | null> {
  const contents = await readFileOrNull(filePath);

  if (contents === null) {
    return null;
  }

  try {
    const parsed = JSON.parse(contents) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    await quarantineDamagedFile(filePath, null);
    console.error(`${label} was damaged. The damaged copy was kept next to it and defaults are in use.`);
    return null;
  }
}

async function readFileOrNull(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

// Move the damaged document aside and put the recovered version in its place, so the repair
// happens once instead of on every launch.
async function quarantineDamagedFile(filePath: string, recovered: unknown[] | null): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  try {
    await fs.rename(filePath, `${filePath}.damaged-${stamp}`);
  } catch {
    return;
  }

  if (recovered === null) {
    return;
  }

  try {
    await writeJsonFileAtomic(filePath, recovered);
  } catch {
    // The recovered records are still returned to the caller even if rewriting them fails.
  }
}

// Walk a truncated array and keep every top-level element that closed cleanly. History files
// prepend new entries, so the records lost to truncation are the oldest ones.
function salvageJsonArray(contents: string): unknown[] {
  const start = contents.indexOf("[");

  if (start === -1) {
    return [];
  }

  const items: unknown[] = [];
  let depth = 0;
  let elementStart = -1;
  let inString = false;
  let escaped = false;

  const flush = (end: number): void => {
    if (elementStart === -1) {
      return;
    }

    try {
      items.push(JSON.parse(contents.slice(elementStart, end)) as unknown);
    } catch {
      // A partial trailing element is simply dropped.
    }

    elementStart = -1;
  };

  for (let index = start; index < contents.length; index += 1) {
    const char = contents[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }

      continue;
    }

    if (char === '"') {
      inString = true;

      if (depth === 1 && elementStart === -1) {
        elementStart = index;
      }

      continue;
    }

    if (char === "[" || char === "{") {
      depth += 1;

      if (depth === 2 && elementStart === -1) {
        elementStart = index;
      }

      continue;
    }

    if (char === "]" || char === "}") {
      depth -= 1;

      if (depth === 1) {
        flush(index + 1);
      }

      if (depth === 0) {
        break;
      }

      continue;
    }

    if (depth === 1 && char === ",") {
      flush(index);
      continue;
    }

    if (depth === 1 && elementStart === -1 && !/\s/.test(char)) {
      elementStart = index;
    }
  }

  return items;
}
