import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { app } from "electron";
import type {
  MetadataSourceId,
  RenameHistoryEntry,
  RenameHistoryItem,
  RenameResult,
  UndoRenameHistoryRequest,
  UndoRenameHistoryResult
} from "../shared/types";
import { moveFile } from "./file-ops";

export async function getRenameHistory(): Promise<RenameHistoryEntry[]> {
  try {
    const contents = await fs.readFile(getHistoryPath(), "utf8");
    const parsed = JSON.parse(contents) as RenameHistoryEntry[];
    return Array.isArray(parsed) ? parsed.map(normalizeHistoryEntry) : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

export async function recordRenameHistoryBatch(input: {
  sourceId: MetadataSourceId;
  results: RenameResult[];
}): Promise<RenameHistoryEntry | null> {
  const items: RenameHistoryItem[] = input.results
    .filter((result) => result.success && result.sourcePath !== result.targetPath)
    .map((result) => ({
      id: randomUUID(),
      sourcePath: result.sourcePath,
      targetPath: result.targetPath
    }));

  if (items.length === 0) {
    return null;
  }

  const nextEntry: RenameHistoryEntry = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    sourceId: input.sourceId,
    itemCount: items.length,
    items
  };

  const history = await getRenameHistory();
  const nextHistory = [nextEntry, ...history].slice(0, 200);
  await writeHistory(nextHistory);
  return nextEntry;
}

export async function undoRenameHistoryEntry(
  request: UndoRenameHistoryRequest
): Promise<UndoRenameHistoryResult> {
  const history = await getRenameHistory();
  const entry = history.find((item) => item.id === request.entryId);

  if (!entry) {
    throw new Error("Rename history entry not found");
  }

  const pendingItems = entry.items.filter((item) => !item.undoneAt);
  if (pendingItems.length === 0) {
    throw new Error("This rename batch has already been undone");
  }

  const requestedItems =
    request.itemIds && request.itemIds.length > 0
      ? pendingItems.filter((item) => request.itemIds?.includes(item.id))
      : pendingItems;

  if (requestedItems.length === 0) {
    throw new Error("No undoable history items were selected");
  }

  const results: RenameResult[] = [];

  for (const item of [...requestedItems].reverse()) {
    try {
      await moveFile(item.targetPath, item.sourcePath);

      results.push({
        sourcePath: item.targetPath,
        targetPath: item.sourcePath,
        success: true
      });

      item.undoneAt = new Date().toISOString();
    } catch (error) {
      results.push({
        sourcePath: item.targetPath,
        targetPath: item.sourcePath,
        success: false,
        error: error instanceof Error ? error.message : "Unknown undo error"
      });
    }
  }

  if (entry.items.every((item) => item.undoneAt)) {
    entry.undoneAt = new Date().toISOString();
  }

  if (results.some((result) => result.success)) {
    await writeHistory(history);
  }

  return {
    entryId: request.entryId,
    results
  };
}

function getHistoryPath(): string {
  return path.join(app.getPath("userData"), "rename-history.json");
}

async function writeHistory(history: RenameHistoryEntry[]): Promise<void> {
  await fs.mkdir(path.dirname(getHistoryPath()), { recursive: true });
  await fs.writeFile(getHistoryPath(), JSON.stringify(history, null, 2), "utf8");
}

function normalizeHistoryEntry(entry: RenameHistoryEntry): RenameHistoryEntry {
  return {
    ...entry,
    items: entry.items.map((item) => ({
      id: item.id || randomUUID(),
      sourcePath: item.sourcePath,
      targetPath: item.targetPath,
      undoneAt: item.undoneAt
    }))
  };
}
