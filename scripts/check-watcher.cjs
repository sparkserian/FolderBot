// Drives the real automation watcher against a temporary inbox and checks that every state a
// file can be in is reported with a reason: arriving, settling, queued, copying with progress,
// filed, failed with a hint, waiting on a partial download, skipped, and folder problems.
// Electron is replaced with a stub so this runs under plain Node.
const Module = require("node:module");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const root = require("node:fs").mkdtempSync(path.join(os.tmpdir(), "fb-watch-"));
const userData = path.join(root, "userData");
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "electron") {
    return {
      app: { getPath: () => userData, isPackaged: false },
      shell: {
        trashItem: async (target) => {
          const bin = path.join(root, "recycle-bin");
          await fs.mkdir(bin, { recursive: true });
          await fs.rename(target, path.join(bin, path.basename(target)));
        }
      }
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const dist = path.join(__dirname, "..", "dist-electron", "main");
const watcher = require(path.join(dist, "automation-service.js"));
const { copyWithProgress } = require(path.join(dist, "transfer.js"));

let pass = 0;
let fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("  ok  ", name); }
  else { fail++; console.log("  FAIL", name, extra); }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const inbox = path.join(root, "inbox");
  const tvSource = path.join(root, "tv-source");
  const tvMirror = path.join(root, "tv-mirror");
  const movieSource = path.join(root, "movie-source");
  const movieMirror = path.join(root, "movie-mirror");
  await fs.mkdir(inbox, { recursive: true });

  const statuses = [];
  const finished = [];
  const settings = {
    tmdbBearerToken: "", tvdbApiKey: "", tvdbPin: "", defaultLanguage: "en-US",
    launchAtLogin: false, automationEnabled: true, automationInboxDirectory: inbox,
    automationSourceLibraryDirectory: tvSource, automationMirrorLibraryDirectory: tvMirror,
    automationMovieSourceDirectory: movieSource, automationMovieMirrorDirectory: movieMirror,
    automationSourceId: "local", automationSettleSeconds: 1, notifyOnFiled: true, notifyOnFailure: true
  };

  const stagesSeen = new Map();
  const remember = (status) => {
    statuses.push(status);
    for (const job of status.jobs) {
      const seen = stagesSeen.get(job.fileName) ?? new Set();
      seen.add(job.stage);
      stagesSeen.set(job.fileName, seen);
    }
  };

  console.log("1. copy progress on a large file");
  const big = path.join(root, "big.bin");
  await writeFile(big, 1536 * 1024 * 1024);
  const progress = [];
  await copyWithProgress(big, path.join(root, "big-copy.bin"), { onProgress: (p) => progress.push(p) });
  check("reports progress part-way through", progress.some((p) => p.bytesDone > 0 && p.bytesDone < p.bytesTotal), `${progress.length} reports`);
  check("finishes at 100%", progress.at(-1)?.bytesDone === progress.at(-1)?.bytesTotal);
  check("leaves no partial file", !(await fs.readdir(root)).some((name) => name.endsWith(".folderbot-partial")));
  await fs.rm(big);
  await fs.rm(path.join(root, "big-copy.bin"));

  console.log("2. a missing inbox is a problem, not silence");
  watcher.initializeAutomationService({ ...settings, automationInboxDirectory: path.join(root, "nope") }, { onStatus: remember });
  await sleep(500);
  const missing = watcher.getAutomationStatus();
  check("reports the inbox cannot be found", missing.problems.some((p) => /inbox folder cannot be found/i.test(p.message)), JSON.stringify(missing.problems));

  console.log("3. an episode that is still arriving, then settles and is filed");
  watcher.updateAutomationSettings(settings);
  const episode = path.join(inbox, "Some.Show.S01E02.1080p.WEB.mkv");
  await writeFile(episode, 8 * 1024 * 1024);
  await sleep(3500);
  await appendBytes(episode, 8 * 1024 * 1024);
  await sleep(3500);
  const growing = watcher.getAutomationStatus().jobs.find((job) => job.fileName === path.basename(episode));
  check("while growing it says it is still arriving", growing?.stage === "arriving" && /still arriving/i.test(growing.detail), JSON.stringify(growing));

  const filed = await waitFor(() => finished.length > 0 || watcher.getAutomationStatus().jobs.some((job) => job.stage === "filed"), 30_000);
  const doneJob = watcher.getAutomationStatus().jobs.find((job) => job.stage === "filed");
  check("the episode is filed", filed && Boolean(doneJob), JSON.stringify(watcher.getAutomationStatus().jobs.map((j) => [j.fileName, j.stage, j.detail])));
  const seen = stagesSeen.get(path.basename(episode)) ?? new Set();
  check("it passed through settling and queued", seen.has("settling") && seen.has("queued"), [...seen].join(","));
  check("it reported copying and moving", seen.has("copying") && seen.has("moving"), [...seen].join(","));
  check("the inbox is empty afterwards", (await fs.readdir(inbox)).filter((name) => !name.startsWith(".")).length === 0);
  check("the mirror copy exists", Boolean(doneJob?.mirrorLibraryPath) && (await exists(doneJob.mirrorLibraryPath)));
  check("the source copy exists", Boolean(doneJob?.sourceLibraryPath) && (await exists(doneJob.sourceLibraryPath)));
  check("a history entry was recorded", Boolean(doneJob?.historyEntryId));

  console.log("4. a file with a partial download beside it waits and says why");
  const movie = path.join(inbox, "A Movie (2020) 1080p.mkv");
  await writeFile(movie, 1024 * 1024);
  await writeFile(`${movie}.part`, 1024);
  await sleep(7500);
  const waiting = watcher.getAutomationStatus().jobs.find((job) => job.fileName === path.basename(movie));
  check("it waits as arriving and names the partial file", waiting?.stage === "arriving" && /\.part/.test(waiting.detail), JSON.stringify(waiting));

  console.log("5. skipping holds a file until it changes");
  watcher.skipAutomationJob(waiting.id);
  await sleep(300);
  const skipped = watcher.getAutomationStatus().jobs.find((job) => job.fileName === path.basename(movie));
  check("it is skipped with a reason", skipped?.stage === "skipped" && /until the file changes/i.test(skipped.detail), JSON.stringify(skipped));
  await fs.rm(`${movie}.part`);
  await sleep(4000);
  check("it stays skipped while unchanged", watcher.getAutomationStatus().jobs.find((job) => job.fileName === path.basename(movie))?.stage === "skipped");

  console.log("6. a file FolderBot cannot identify fails with a hint and is not retried");
  const unknown = path.join(inbox, "holiday video.mkv");
  await writeFile(unknown, 1024 * 1024);
  await waitFor(() => watcher.getAutomationStatus().jobs.some((job) => job.fileName === "holiday video.mkv" && job.stage === "failed"), 20_000);
  const failedJob = watcher.getAutomationStatus().jobs.find((job) => job.fileName === "holiday video.mkv");
  check("it failed", failedJob?.stage === "failed", JSON.stringify(failedJob));
  check("the failure explains what to do", Boolean(failedJob?.error?.hint), JSON.stringify(failedJob?.error));
  check("no automatic retry is scheduled", !failedJob?.error?.willRetryAt);
  check("it is not counted as waiting", watcher.getAutomationStatus().pendingCount === 0, String(watcher.getAutomationStatus().pendingCount));

  console.log("7. videos inside a folder are reported");
  await fs.mkdir(path.join(inbox, "Other.Show.S02E01"), { recursive: true });
  await writeFile(path.join(inbox, "Other.Show.S02E01", "Other.Show.S02E01.mkv"), 1024);
  await sleep(3500);
  check("the folder is named as a problem", watcher.getAutomationStatus().problems.some((p) => /Other\.Show\.S02E01/.test(p.message)), JSON.stringify(watcher.getAutomationStatus().problems));

  console.log("8. a name clash in the library can be replaced");
  const clashTarget = path.join(tvSource, "Some Show", "Season 01", "Some Show - S01E03.mkv");
  await fs.mkdir(path.dirname(clashTarget), { recursive: true });
  await writeFile(clashTarget, 1024);
  const clash = path.join(inbox, "Some.Show.S01E03.720p.mkv");
  await writeFile(clash, 2 * 1024 * 1024);
  await waitFor(() => watcher.getAutomationStatus().jobs.some((job) => job.fileName === path.basename(clash) && job.stage === "failed"), 20_000);
  const clashJob = watcher.getAutomationStatus().jobs.find((job) => job.fileName === path.basename(clash));
  check("it fails naming the library and the file", /TV source library already has "Some Show - S01E03\.mkv" \(in Some Show/.test(clashJob?.error?.message ?? ""), clashJob?.error?.message);
  check("it offers Replace and points at the existing file", clashJob?.error?.remedy === "replace" && clashJob?.error?.existingPath === clashTarget, JSON.stringify(clashJob?.error));
  await watcher.retryAutomationJob(clashJob.id, { replaceExisting: true });
  await waitFor(() => watcher.getAutomationStatus().jobs.some((job) => job.fileName === path.basename(clash) && job.stage === "filed"), 20_000);
  check("Replace files it", watcher.getAutomationStatus().jobs.some((job) => job.fileName === path.basename(clash) && job.stage === "filed"));
  check("the new file is in place", (await fs.stat(clashTarget)).size === 2 * 1024 * 1024);
  check("the old file went to the Recycle Bin", await exists(path.join(root, "recycle-bin", "Some Show - S01E03.mkv")));

  console.log("9. the log file records what happened");
  const log = await fs.readFile(path.join(userData, "automation.log"), "utf8").catch(() => "");
  check("the log mentions the filed episode", log.includes("Filed Some.Show.S01E02"), log.slice(-400));

  watcher.updateAutomationSettings({ ...settings, automationEnabled: false });
}

async function writeFile(filePath, bytes) {
  const handle = await fs.open(filePath, "w");
  const chunk = Buffer.alloc(Math.min(bytes, 64 * 1024 * 1024), 7);
  let written = 0;
  while (written < bytes) {
    const size = Math.min(chunk.length, bytes - written);
    await handle.write(chunk, 0, size);
    written += size;
  }
  await handle.close();
}

async function appendBytes(filePath, bytes) {
  await fs.appendFile(filePath, Buffer.alloc(bytes, 3));
}

async function exists(filePath) {
  try { await fs.access(filePath); return true; } catch { return false; }
}

async function waitFor(predicate, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await sleep(250);
  }
  return predicate();
}

main()
  .catch((error) => { fail++; console.error(error); })
  .finally(async () => {
    await fs.rm(root, { recursive: true, force: true });
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail > 0 ? 1 : 0);
  });
