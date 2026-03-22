// Shared helpers used by the local GitHub repo and release scripts.
import fs from "node:fs/promises";
import path from "node:path";

const ROOT_DIR = process.cwd();
const ENV_FILE = path.join(ROOT_DIR, ".env.local");

export async function readReleaseEnv() {
  const envFromFile = await readEnvFile(ENV_FILE);

  const owner = process.env.GH_RELEASE_OWNER || envFromFile.GH_RELEASE_OWNER || "";
  const repo = process.env.GH_RELEASE_REPO || envFromFile.GH_RELEASE_REPO || "";
  const token = process.env.GH_TOKEN || envFromFile.GH_TOKEN || "";

  if (!owner || !repo || !token) {
    throw new Error("Missing GitHub release configuration. Fill GH_RELEASE_OWNER, GH_RELEASE_REPO, and GH_TOKEN in .env.local.");
  }

  return { owner, repo, token };
}

// Read package.json once so every script uses the same current version number.
export async function readPackageJson() {
  const packagePath = path.join(ROOT_DIR, "package.json");
  const raw = await fs.readFile(packagePath, "utf8");
  return JSON.parse(raw);
}

// Small wrapper around the GitHub REST API used by the local release scripts.
export async function githubRequest(urlPath, { method = "GET", token, body, headers = {} } = {}) {
  const response = await fetch(`https://api.github.com${urlPath}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "FolderBot-Local-Release-Script",
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...headers
    },
    body: body ? JSON.stringify(body) : undefined
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`GitHub API ${method} ${urlPath} failed: ${response.status} ${response.statusText} - ${errorText}`);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

// Upload one local file as a GitHub release asset.
export async function githubUpload(uploadUrl, filePath, token, assetName = path.basename(filePath)) {
  const fileName = assetName;
  const fileBuffer = await fs.readFile(filePath);
  const targetUrl = `${uploadUrl.replace(/\{.*$/, "")}?name=${encodeURIComponent(fileName)}`;

  const response = await fetch(targetUrl, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "FolderBot-Local-Release-Script",
      "Content-Type": inferContentType(filePath),
      "Content-Length": String(fileBuffer.length)
    },
    body: fileBuffer
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`GitHub upload failed for ${fileName}: ${response.status} ${response.statusText} - ${errorText}`);
  }

  return response.json();
}

// Run a git command and stream its output through the current terminal.
export async function runGit(args) {
  const { spawn } = await import("node:child_process");

  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: ROOT_DIR,
      stdio: "inherit"
    });

    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`git ${args.join(" ")} failed with exit code ${code}`));
    });

    child.on("error", reject);
  });
}

// Run a git command and capture stdout for script decisions.
export async function gitOutput(args) {
  const { spawn } = await import("node:child_process");

  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: ROOT_DIR,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("exit", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }

      reject(new Error(`git ${args.join(" ")} failed with exit code ${code}: ${stderr.trim()}`));
    });

    child.on("error", reject);
  });
}

// Print consistent script usage text.
export function printScriptUsage(lines) {
  for (const line of lines) {
    console.log(line);
  }
}

// Parse the simple KEY=value format used by the root .env.local file.
async function readEnvFile(filePath) {
  try {
    const contents = await fs.readFile(filePath, "utf8");
    return Object.fromEntries(
      contents
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#") && line.includes("="))
        .map((line) => {
          const [key, ...rest] = line.split("=");
          return [key.trim(), rest.join("=").trim()];
        })
    );
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return {};
    }

    throw error;
  }
}

// Pick a sensible upload content type for each release artifact extension.
function inferContentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();

  switch (extension) {
    case ".exe":
      return "application/vnd.microsoft.portable-executable";
    case ".dmg":
      return "application/x-apple-diskimage";
    case ".zip":
      return "application/zip";
    case ".deb":
      return "application/vnd.debian.binary-package";
    case ".appimage":
      return "application/octet-stream";
    case ".blockmap":
    case ".yml":
      return "application/octet-stream";
    default:
      return "application/octet-stream";
  }
}
