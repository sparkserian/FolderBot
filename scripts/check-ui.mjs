// Loads the real built renderer bundle against a stubbed preload bridge and checks that one
// failing bridge call cannot take the rest of the app down with it. Regression cover for the
// bug where an unreadable history file left both History lists blank and froze the watcher
// chip, because the automation status listener was registered after the failing await.
import http from "node:http";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "renderer");
const template = await fs.readFile(path.join(ROOT, "index.html"), "utf8");

const STUB = (mode) => `
<script>
window.__probe = { statusListenerRegistered: false, helpListenerRegistered: false, errors: [] };
window.addEventListener("error", (e) => window.__probe.errors.push(String(e.message)));
window.addEventListener("unhandledrejection", (e) => window.__probe.errors.push("rejection: " + e.reason));
const settings = { tmdbBearerToken: "", tvdbApiKey: "", tvdbPin: "", defaultLanguage: "en-US",
  launchAtLogin: false, automationEnabled: true, automationInboxDirectory: "C:\\\\inbox",
  automationSourceLibraryDirectory: "C:\\\\tv", automationMirrorLibraryDirectory: "D:\\\\tv",
  automationMovieSourceDirectory: "", automationMovieMirrorDirectory: "",
  automationSourceId: "tvdb", automationSettleSeconds: 45 };
const status = { enabled: true, watching: true, processing: false, inboxDirectory: "C:\\\\inbox",
  sourceLibraryDirectory: "C:\\\\tv", mirrorLibraryDirectory: "D:\\\\tv", movieSourceDirectory: "",
  movieMirrorDirectory: "", sourceId: "tvdb", settleSeconds: 45, pendingCount: 0, recentEvents: [] };
const autoEntry = { id: "auto-1", createdAt: "2026-08-19T01:00:00.000Z", sourceId: "tvdb",
  mediaKind: "episode", originalInboxPath: "C:\\\\inbox\\\\Show.S01E02.mkv",
  sourceLibraryPath: "C:\\\\tv\\\\Show\\\\Season 01\\\\Show - S01E02.mkv",
  mirrorLibraryPath: "D:\\\\tv\\\\Show\\\\Season 01\\\\Show - S01E02.mkv", displayTitle: "Show" };
window.folderBot = {
  platform: "win32",
  getSettings: async () => settings,
  saveSettings: async () => settings,
  getAutomationStatus: async () => status,
  getProviderStatuses: async () => [],
  getRenameHistory: async () => { ${mode === "broken" ? 'throw new Error("Unexpected end of JSON input");' : "return [];"} },
  getAutomationHistory: async () => [autoEntry],
  pickFiles: async () => [], pickOutputDirectory: async () => null, pickOutputDirectories: async () => [],
  getPathForFile: () => null, previewRenames: async () => [], applyRenames: async () => [],
  undoRenameHistoryEntry: async () => ({}), undoAutomationHistoryEntry: async () => ({}),
  repairAutomationHistoryEntries: async () => ({}), repairSeasonPlacement: async () => [],
  searchAutomationSeries: async () => [],
  onOpenHelp: (fn) => { window.__probe.helpListenerRegistered = true; return () => {}; },
  onAutomationStatus: (fn) => { window.__probe.statusListenerRegistered = true; window.__pushStatus = fn; return () => {}; }
};
</script>
`;

let mode = "broken";
const server = http.createServer(async (req, res) => {
  const url = req.url.split("?")[0];
  if (url === "/" || url === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(template.replace("<body>", "<body>" + STUB(mode)));
    return;
  }
  try {
    const body = await fs.readFile(path.join(ROOT, url));
    const type = url.endsWith(".css") ? "text/css" : "text/javascript";
    res.writeHead(200, { "Content-Type": type });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
].filter(Boolean);

let CHROME = null;
for (const candidate of CHROME_CANDIDATES) {
  try { await fs.access(candidate); CHROME = candidate; break; } catch {}
}

if (!CHROME) {
  console.log("Skipped: no Chrome build found. Set CHROME_PATH to run these checks.");
  server.close();
  process.exit(0);
}
const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=9333", "--no-first-run",
  "--user-data-dir=/tmp/fb-chrome-profile", "about:blank"], { stdio: "ignore" });

async function cdp(fn) {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch("http://127.0.0.1:9333/json/version"); if (r.ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  const target = await (await fetch("http://127.0.0.1:9333/json/new?" + `http://127.0.0.1:${port}/`, { method: "PUT" })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  const send = (method, params = {}) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
  const evaluate = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
    return r.result?.result?.value;
  };
  const out = await fn({ evaluate, send });
  ws.close();
  await fetch(`http://127.0.0.1:9333/json/close/${target.id}`, { method: "PUT" }).catch(() => {});
  return out;
}

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("  ok  ", name); }
  else { fail++; console.log("  FAIL", name, extra); }
};

console.log("Scenario: rename history file is unreadable (the reported bug)");
const r = await cdp(async ({ evaluate }) => {
  await new Promise((res) => setTimeout(res, 1500));
  return evaluate(`(async () => {
    document.querySelector('[data-view="history"]').click();
    await new Promise(r => setTimeout(r, 400));
    const manual = document.querySelector('#historyList').innerText;
    document.querySelector('#historyTabAutomation').click();
    await new Promise(r => setTimeout(r, 200));
    const auto = document.querySelector('#historyList').innerText;
    if (window.__pushStatus) window.__pushStatus({ ...await window.folderBot.getAutomationStatus(), processing: true, pendingCount: 3 });
    await new Promise(r => setTimeout(r, 200));
    const chip = document.querySelector('.chip')?.innerText || document.body.querySelector('[class*=chip]')?.innerText;
    return { probe: window.__probe, manual, auto, chip,
             status: document.querySelector('#statusLine, .status-line, [id*=status]')?.innerText || '' };
  })()`);
});

check("automation status listener was registered despite the failure", r.probe.statusListenerRegistered, JSON.stringify(r.probe));
check("help listener was registered", r.probe.helpListenerRegistered);
check("manual list explains the failure instead of showing nothing", /[Cc]ould not read/.test(r.manual), JSON.stringify(r.manual));
check("manual list does NOT claim there are no renames", !/No renames yet/.test(r.manual), JSON.stringify(r.manual));
check("automation list still shows its entry", /Show/.test(r.auto), JSON.stringify(r.auto));
check("live status update reached the UI (chip shows filing)", /Filing/i.test(r.chip || ""), JSON.stringify(r.chip));
check("no unhandled rejection escaped", r.probe.errors.filter(e => e.startsWith("rejection")).length === 0, JSON.stringify(r.probe.errors));

console.log("\nScenario: healthy startup");
mode = "ok";
const r2 = await cdp(async ({ evaluate }) => {
  await new Promise((res) => setTimeout(res, 1500));
  return evaluate(`(async () => {
    document.querySelector('[data-view="history"]').click();
    await new Promise(r => setTimeout(r, 400));
    return { probe: window.__probe, manual: document.querySelector('#historyList').innerText };
  })()`);
});
check("listeners registered", r2.probe.statusListenerRegistered && r2.probe.helpListenerRegistered);
check("empty history reads as empty, not broken", /No renames yet/.test(r2.manual), JSON.stringify(r2.manual));
check("no page errors", r2.probe.errors.length === 0, JSON.stringify(r2.probe.errors));

console.log(`\n${pass} passed, ${fail} failed`);
chrome.kill(); server.close();
process.exit(fail ? 1 : 0);
