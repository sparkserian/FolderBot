// Loads the real built renderer against the stub bridge (scripts/ui-stub.js) in headless Chrome and
// checks that it starts, shows the watcher's work, and survives a failing bridge call.
import http from "node:http";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..", "dist", "renderer");
const html = (await fs.readFile(path.join(ROOT, "index.html"), "utf8")).replace("<body>", '<body><script src="/ui-stub.js"></script>');
const stub = await fs.readFile(path.join(here, "ui-stub.js"));

const CHROME = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"].filter(Boolean);
let chromePath = null;
for (const candidate of CHROME) {
  try { await fs.access(candidate); chromePath = candidate; break; } catch {}
}
if (!chromePath) {
  console.log("Skipped: no Chrome build found. Set CHROME_PATH to run these checks.");
  process.exit(0);
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split("?")[0];
  if (url === "/" || url === "/index.html") return res.writeHead(200, { "Content-Type": "text/html" }), res.end(html);
  if (url === "/ui-stub.js") return res.writeHead(200, { "Content-Type": "text/javascript" }), res.end(stub);
  try {
    const body = await fs.readFile(path.join(ROOT, url));
    res.writeHead(200, { "Content-Type": url.endsWith(".css") ? "text/css" : url.endsWith(".png") ? "image/png" : "text/javascript" });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((resolve) => server.listen(0, resolve));
const port = server.address().port;
const chrome = spawn(chromePath, ["--headless=new", "--remote-debugging-port=9335", "--no-first-run", "--user-data-dir=/tmp/fb-check-ui", "about:blank"], { stdio: "ignore" });
for (let i = 0; i < 60; i++) {
  try { if ((await fetch("http://127.0.0.1:9335/json/version")).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 200));
}

async function open(query) {
  const target = await (await fetch(`http://127.0.0.1:9335/json/new?${encodeURIComponent(`http://127.0.0.1:${port}/?${query}`)}`, { method: "PUT" })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise((r) => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  await new Promise((r) => setTimeout(r, 1500));
  const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
  return { evaluate, close: async () => { ws.close(); await fetch(`http://127.0.0.1:9335/json/close/${target.id}`, { method: "PUT" }).catch(() => {}); } };
}

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("  ok  ", name); } else { fail++; console.log("  FAIL", name, extra); }
};
const text = "document.body.innerText";

console.log("1. a busy watcher");
let page = await open("route=activity&scenario=busy");
let body = await page.evaluate(text);
check("no script errors", (await page.evaluate("window.__probe.errors.length")) === 0, await page.evaluate("JSON.stringify(window.__probe.errors)"));
check("shows the copy with progress and time left", /Copying/.test(body) && /8\.6 GB of 20\.4 GB/.test(body) && /min left/.test(body));
check("says why a file failed and what to do", /Not enough space/.test(body) && /Free up space/.test(body));
check("says why a file is waiting", /Another program has this file open/.test(body) && /Waiting for/.test(body));
check("reports a missing library drive", /cannot be found/.test(body));
check("the navigation footer summarises the copy", /Copying 42%/.test(await page.evaluate("document.querySelector('.watcher-summary')?.title ?? ''")));
await page.close();

console.log("2. a damaged history file does not take the app down");
page = await open("route=history&scenario=broken");
body = await page.evaluate(text);
check("the watcher status listener is registered", await page.evaluate("window.__probe.statusListenerRegistered"));
check("the error is shown on the History page", /watcher history could not be read/i.test(body), body.slice(0, 400));
check("the manual history still shows", /Renamed 3 files/.test(body));
await page.close();

console.log("3. a first run");
page = await open("route=activity&scenario=new");
body = await page.evaluate(text);
check("offers both ways to start", /File downloads automatically/.test(body) && /Rename a batch now/.test(body));
await page.close();

chrome.kill();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
