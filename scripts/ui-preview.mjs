// Renders the built renderer in headless Chrome with the stub bridge (scripts/ui-stub.js) and saves
// a screenshot per page, theme and scenario. Usage: node scripts/ui-preview.mjs <outDir> [width height]
import http from "node:http";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..", "dist", "renderer");
const outDir = process.argv[2] || "/tmp/folderbot-shots";
const width = Number(process.argv[3] || 1200);
const height = Number(process.argv[4] || 800);
await fs.mkdir(outDir, { recursive: true });

const html = (await fs.readFile(path.join(ROOT, "index.html"), "utf8")).replace("<body>", '<body><script src="/ui-stub.js"></script>');
const stub = await fs.readFile(path.join(here, "ui-stub.js"));

const server = http.createServer(async (req, res) => {
  const url = req.url.split("?")[0];
  if (url === "/" || url === "/index.html") return res.writeHead(200, { "Content-Type": "text/html" }), res.end(html);
  if (url === "/ui-stub.js") return res.writeHead(200, { "Content-Type": "text/javascript" }), res.end(stub);
  try {
    const body = await fs.readFile(path.join(ROOT, url));
    const type = url.endsWith(".css") ? "text/css" : url.endsWith(".png") ? "image/png" : "text/javascript";
    res.writeHead(200, { "Content-Type": type });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, resolve));
const port = server.address().port;

const CHROME = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].filter(Boolean)[0];
const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=9334", "--no-first-run", "--hide-scrollbars", "--user-data-dir=/tmp/fb-preview-profile", "about:blank"], { stdio: "ignore" });

for (let i = 0; i < 60; i++) {
  try { if ((await fetch("http://127.0.0.1:9334/json/version")).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 200));
}

const shots = (process.env.SHOTS || "activity:busy,activity:idle,activity:new,rename:busy,rename:busy:files,history:busy,settings:busy,activity:busy:update").split(",");
for (const theme of (process.env.THEMES || "light,dark").split(",")) {
  for (const shot of shots) {
    const [route, scenario, extra] = shot.split(":");
    const pageUrl = `http://127.0.0.1:${port}/?route=${route}&scenario=${scenario}${extra === "update" ? "&update=ready" : ""}`;
    const target = await (await fetch(`http://127.0.0.1:9334/json/new?${encodeURIComponent(pageUrl)}`, { method: "PUT" })).json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener("open", r));
    let id = 0;
    const pending = new Map();
    ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
    const send = (method, params = {}) => new Promise((r) => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
    await send("Page.reload");
    await new Promise((r) => setTimeout(r, 1200));
    if (extra === "files") {
      await send("Runtime.evaluate", { expression: "[...document.querySelectorAll('button')].find((b) => b.textContent.includes('Add files'))?.click()" });
      await new Promise((r) => setTimeout(r, 800));
    }
    const shotResult = await send("Page.captureScreenshot", { format: "png" });
    const name = `${route}-${scenario}${extra ? `-${extra}` : ""}-${theme}.png`;
    await fs.writeFile(path.join(outDir, name), Buffer.from(shotResult.result.data, "base64"));
    const errors = await send("Runtime.evaluate", { expression: "JSON.stringify(window.__probe.errors)", returnByValue: true });
    console.log(name, errors.result?.result?.value);
    ws.close();
    await fetch(`http://127.0.0.1:9334/json/close/${target.id}`, { method: "PUT" }).catch(() => {});
  }
}

chrome.kill();
server.close();
