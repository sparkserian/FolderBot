// Automation history storage, repair support, and undo behavior for automated moves.
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { app } from "electron";
import type {
  AutomationActionResult,
  AutomationHistoryEntry,
  MetadataSourceId,
  UndoAutomationHistoryResult
} from "../shared/types";
import { moveFile } from "./file-ops";

// Load automation history from disk and normalize older entries.
export async function getAutomationHistory(): Promise<AutomationHistoryEntry[]> {
  try {
    const contents = await fs.readFile(getAutomationHistoryPath(), "utf8");
    const parsed = JSON.parse(contents) as AutomationHistoryEntry[];
    return Array.isArray(parsed) ? parsed.map(normalizeEntry) : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

// Persist the provided automation history array as-is.
export async function saveAutomationHistory(history: AutomationHistoryEntry[]): Promise<void> {
  await writeAutomationHistory(history);
}

// Record a newly completed automation item so it can be undone or repaired later.
export async function recordAutomationHistoryEntry(input: {
  sourceId: MetadataSourceId;
  originalInboxPath: string;
  sourceLibraryPath: string;
  mirrorLibraryPath: string;
  displayTitle: string;
}): Promise<AutomationHistoryEntry> {
  const nextEntry: AutomationHistoryEntry = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    sourceId: input.sourceId,
    originalInboxPath: input.originalInboxPath,
    sourceLibraryPath: input.sourceLibraryPath,
    mirrorLibraryPath: input.mirrorLibraryPath,
    displayTitle: input.displayTitle
  };

  const history = await getAutomationHistory();
  const nextHistory = [nextEntry, ...history].slice(0, 300);
  await writeAutomationHistory(nextHistory);
  return nextEntry;
}

// Undo an automation item by restoring the inbox file and removing the mirror copy.
export async function undoAutomationHistoryEntry(entryId: string): Promise<UndoAutomationHistoryResult> {
  const history = await getAutomationHistory();
  const entry = history.find((item) => item.id === entryId);

  if (!entry) {
    throw new Error("Automation history entry not found");
  }

  if (entry.undoneAt) {
    throw new Error("This automation item has already been undone");
  }

  const results: AutomationActionResult[] = [];

  try {
    await moveFile(entry.sourceLibraryPath, entry.originalInboxPath);
    results.push({
      kind: "move-back",
      sourcePath: entry.sourceLibraryPath,
      targetPath: entry.originalInboxPath,
      success: true
    });
  } catch (error) {
    results.push({
      kind: "move-back",
      sourcePath: entry.sourceLibraryPath,
      targetPath: entry.originalInboxPath,
      success: false,
      error: error instanceof Error ? error.message : "Unknown undo error"
    });
  }

  if (results[0]?.success) {
    try {
      await fs.unlink(entry.mirrorLibraryPath);
      results.push({
        kind: "delete-mirror",
        sourcePath: entry.mirrorLibraryPath,
        success: true
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        results.push({
          kind: "delete-mirror",
          sourcePath: entry.mirrorLibraryPath,
          success: true
        });
      } else {
        results.push({
          kind: "delete-mirror",
          sourcePath: entry.mirrorLibraryPath,
          success: false,
          error: error instanceof Error ? error.message : "Unknown undo error"
        });
      }
    }
  }

  if (results.every((result) => result.success)) {
    entry.undoneAt = new Date().toISOString();
    await writeAutomationHistory(history);
  }

  return {
    entryId,
    results
  };
}

// Automation history is kept in its own file under Electron's userData directory.
function getAutomationHistoryPath(): string {
  return path.join(app.getPath("userData"), "automation-history.json");
}

// Persist the full automation history file after any change.
async function writeAutomationHistory(history: AutomationHistoryEntry[]): Promise<void> {
  await fs.mkdir(path.dirname(getAutomationHistoryPath()), { recursive: true });
  await fs.writeFile(getAutomationHistoryPath(), JSON.stringify(history, null, 2), "utf8");
}

// Upgrade older saved entries into the current format expected by the UI and repair flow.
function normalizeEntry(entry: AutomationHistoryEntry): AutomationHistoryEntry {
  return {
    id: entry.id || randomUUID(),
    createdAt: entry.createdAt,
    sourceId: entry.sourceId,
    originalInboxPath: entry.originalInboxPath,
    sourceLibraryPath: entry.sourceLibraryPath,
    mirrorLibraryPath: entry.mirrorLibraryPath,
    displayTitle: entry.displayTitle,
    undoneAt: entry.undoneAt
  };
}
