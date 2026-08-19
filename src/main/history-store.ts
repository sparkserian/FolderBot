// Manual rename history storage and undo behavior.
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
import { readJsonArrayFile, writeJsonFileAtomic } from "./json-file";

// Load manual rename history from disk. A damaged file costs the records it damaged, not the
// whole feature, so a half-written entry cannot blank the History screen.
export async function getRenameHistory(): Promise<RenameHistoryEntry[]> {
  const parsed = await readJsonArrayFile(getHistoryPath(), "The manual rename history file");

  return parsed
    .map((entry) => normalizeHistoryEntry(entry as Partial<RenameHistoryEntry> | null))
    .filter((entry): entry is RenameHistoryEntry => entry !== null);
}

// Persist a batch of successful manual renames for later undo.
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

// Undo either the full batch or only the selected items.
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

// Manual history lives in userData alongside the other app-owned state files.
function getHistoryPath(): string {
  return path.join(app.getPath("userData"), "rename-history.json");
}

// Persist the full history array after recording or undoing changes.
async function writeHistory(history: RenameHistoryEntry[]): Promise<void> {
  await writeJsonFileAtomic(getHistoryPath(), history);
}

// Upgrade older saved history records into the current shape expected by the UI.
// Anything unusable is dropped rather than thrown, so one bad record stays one bad record.
function normalizeHistoryEntry(entry: Partial<RenameHistoryEntry> | null): RenameHistoryEntry | null {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const items = (Array.isArray(entry.items) ? entry.items : [])
    .filter((item) => item && typeof item.sourcePath === "string" && typeof item.targetPath === "string")
    .map((item) => ({
      id: item.id || randomUUID(),
      sourcePath: item.sourcePath,
      targetPath: item.targetPath,
      undoneAt: item.undoneAt
    }));

  if (items.length === 0) {
    return null;
  }

  return {
    id: entry.id || randomUUID(),
    createdAt: entry.createdAt || new Date(0).toISOString(),
    sourceId: entry.sourceId ?? "local",
    itemCount: typeof entry.itemCount === "number" ? entry.itemCount : items.length,
    items,
    undoneAt: entry.undoneAt
  };
}
