// Renders the FolderBot icon set from build/icon-glyph.svg.
// Run with: npm run icons
//
// Outputs:
//   build/icon.png          1024px master, used by electron-builder for macOS and Linux
//   build/icon.ico          multi-size Windows icon for the app and the NSIS installer
//   src/main/tray-icon.ts   base64 PNGs embedded in the main process for the tray
//
// The tray images are embedded as base64 rather than read from disk because a packaged app
// reads from inside app.asar, and because nativeImage cannot decode SVG on Windows at all,
// which is why the Windows tray slot used to render empty.
//
// Rasterizing needs a browser engine. The script uses Electron when it is installed and
// falls back to a local Chrome, Chromium, or Edge.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const workDirectory = path.join(tmpdir(), "folderbot-icons");

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const TRAY_SIZES = [16, 24, 32];
const MASTER_SIZE = 1024;

const BROWSER_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
];

function findBrowser() {
  const fromEnvironment = process.env.FOLDERBOT_ICON_BROWSER;
  if (fromEnvironment && existsSync(fromEnvironment)) {
    return fromEnvironment;
  }

  const browser = BROWSER_CANDIDATES.find((candidate) => existsSync(candidate));
  if (!browser) {
    throw new Error(
      "No Chrome, Chromium, or Edge found. Set FOLDERBOT_ICON_BROWSER to a browser executable."
    );
  }

  return browser;
}

const glyph = readFileSync(path.join(projectRoot, "build", "icon-glyph.svg"), "utf8").replace(
  'fill="currentColor"',
  'fill="#ffffff"'
);

// Full-colour tile used for the app icon and the Windows tray.
function colorIconPage(size) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{margin:0;padding:0;box-sizing:border-box}
    html,body{width:${size}px;height:${size}px;background:transparent;overflow:hidden}
    .tile{position:relative;width:${size}px;height:${size}px;border-radius:${size * 0.225}px;
      background:linear-gradient(160deg,#8B5CF6 0%,#6366F1 52%,#4338CA 100%);
      display:flex;align-items:center;justify-content:center;overflow:hidden}
    .tile::after{content:"";position:absolute;inset:0;border-radius:inherit;
      background:linear-gradient(180deg,rgba(255,255,255,.20),rgba(255,255,255,0) 46%)}
    .tile::before{content:"";position:absolute;inset:0;border-radius:inherit;
      box-shadow:inset 0 ${Math.max(size * 0.004, 0.5)}px 0 rgba(255,255,255,.35),
                 inset 0 ${-Math.max(size * 0.006, 0.5)}px 0 rgba(0,0,0,.18)}
    .glyph{display:flex;width:56%;filter:drop-shadow(0 ${size * 0.012}px ${size * 0.03}px rgba(0,0,0,.28))}
    .glyph svg{width:100%;height:auto;display:block}
  </style></head><body><div class="tile"><div class="glyph">${glyph}</div></div></body></html>`;
}

// The macOS menu bar wants a black-on-transparent template image it can invert itself.
function templateIconPage(size) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{margin:0;padding:0;box-sizing:border-box}
    html,body{width:${size}px;height:${size}px;background:transparent;overflow:hidden}
    .wrap{width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center}
    .glyph{display:flex;width:92%}
    .glyph svg{width:100%;height:auto;display:block;fill:#000000}
  </style></head><body><div class="wrap"><div class="glyph">${glyph}</div></div></body></html>`;
}

function renderPng(browser, html, size, label) {
  const htmlPath = path.join(workDirectory, `${label}.html`);
  const pngPath = path.join(workDirectory, `${label}.png`);
  writeFileSync(htmlPath, html);

  execFileSync(
    browser,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--default-background-color=00000000",
      "--force-device-scale-factor=1",
      `--window-size=${size},${size}`,
      `--screenshot=${pngPath}`,
      htmlPath
    ],
    { stdio: "ignore" }
  );

  if (!existsSync(pngPath)) {
    throw new Error(`Failed to render ${label} at ${size}px`);
  }

  return readFileSync(pngPath);
}

// Windows icons may hold PNG-compressed entries, which keeps this encoder small.
function encodeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);

  const directory = Buffer.alloc(entries.length * 16);
  let dataOffset = header.length + directory.length;

  entries.forEach((entry, index) => {
    const base = index * 16;
    directory[base] = entry.size >= 256 ? 0 : entry.size;
    directory[base + 1] = entry.size >= 256 ? 0 : entry.size;
    directory.writeUInt16LE(1, base + 4);
    directory.writeUInt16LE(32, base + 6);
    directory.writeUInt32LE(entry.png.length, base + 8);
    directory.writeUInt32LE(dataOffset, base + 12);
    dataOffset += entry.png.length;
  });

  return Buffer.concat([header, directory, ...entries.map((entry) => entry.png)]);
}

rmSync(workDirectory, { recursive: true, force: true });
mkdirSync(workDirectory, { recursive: true });
mkdirSync(path.join(projectRoot, "build"), { recursive: true });

const browser = findBrowser();
console.log(`Rendering with ${path.basename(browser)}`);

const master = renderPng(browser, colorIconPage(MASTER_SIZE), MASTER_SIZE, "master");
writeFileSync(path.join(projectRoot, "build", "icon.png"), master);

const icoEntries = ICO_SIZES.map((size) => ({
  size,
  png: renderPng(browser, colorIconPage(size), size, `color-${size}`)
}));
writeFileSync(path.join(projectRoot, "build", "icon.ico"), encodeIco(icoEntries));

const colorTray = Object.fromEntries(
  TRAY_SIZES.map((size) => [size, renderPng(browser, colorIconPage(size), size, `tray-${size}`).toString("base64")])
);
const templateTray = Object.fromEntries(
  TRAY_SIZES.map((size) => [
    size,
    renderPng(browser, templateIconPage(size), size, `template-${size}`).toString("base64")
  ])
);
const appIcon256 = icoEntries.find((entry) => entry.size === 256).png.toString("base64");

const trayModule = `// Generated by scripts/generate-icons.mjs. Run "npm run icons" to regenerate.
//
// The tray images live here as base64 PNGs rather than as files on disk. A packaged app reads
// from inside app.asar, and nativeImage cannot decode SVG on Windows, so an embedded PNG is
// the only form that renders on every platform.

// Full-colour tiles for the Windows and Linux tray, one per display scale factor.
export const TRAY_ICON_COLOR: Record<number, string> = {
${TRAY_SIZES.map((size) => `  ${size}: "${colorTray[size]}"`).join(",\n")}
};

// Black-on-transparent artwork the macOS menu bar tints for light and dark modes.
export const TRAY_ICON_TEMPLATE: Record<number, string> = {
${TRAY_SIZES.map((size) => `  ${size}: "${templateTray[size]}"`).join(",\n")}
};

// Window and taskbar icon, used where a packaged icon file is not available.
export const APP_ICON_256 = "${appIcon256}";
`;

writeFileSync(path.join(projectRoot, "src", "main", "tray-icon.ts"), trayModule);
rmSync(workDirectory, { recursive: true, force: true });

console.log(`build/icon.png        ${MASTER_SIZE}x${MASTER_SIZE}`);
console.log(`build/icon.ico        ${ICO_SIZES.join(", ")}`);
console.log(`src/main/tray-icon.ts tray ${TRAY_SIZES.join(", ")} plus a 256px app icon`);
