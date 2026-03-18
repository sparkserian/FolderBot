import fs from "node:fs/promises";
import path from "node:path";
import {
  githubRequest,
  githubUpload,
  printScriptUsage,
  readPackageJson,
  readReleaseEnv
} from "./github-common.mjs";

if (process.argv.includes("--help")) {
  printScriptUsage([
    "Usage: npm run github:release",
    "",
    "Creates or updates a GitHub release for the current package.json version",
    "and uploads matching artifacts from the local release/ folder."
  ]);
  process.exit(0);
}

const { owner, repo, token } = await readReleaseEnv();
const pkg = await readPackageJson();
const version = pkg.version;
const tagName = `v${version}`;
const releaseName = `FolderBot ${tagName}`;
const artifacts = await findReleaseArtifacts(version);

if (artifacts.length === 0) {
  throw new Error(`No release artifacts were found in ./release for version ${version}`);
}

const release = await ensureRelease(owner, repo, token, {
  tagName,
  releaseName,
  version
});

for (const artifactPath of artifacts) {
  await uploadOrReplaceAsset(release, artifactPath, token);
}

console.log(`GitHub release ready: ${release.html_url}`);
console.log("Uploaded assets:");
for (const artifactPath of artifacts) {
  console.log(`- ${path.basename(artifactPath)}`);
}

async function ensureRelease(ownerValue, repoValue, tokenValue, { tagName: tag, releaseName: name, version: currentVersion }) {
  try {
    return await githubRequest(`/repos/${ownerValue}/${repoValue}/releases/tags/${tag}`, {
      token: tokenValue
    });
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("404")) {
      throw error;
    }
  }

  return githubRequest(`/repos/${ownerValue}/${repoValue}/releases`, {
    method: "POST",
    token: tokenValue,
    body: {
      tag_name: tag,
      name,
      draft: false,
      prerelease: false,
      generate_release_notes: false,
      body: `Local release upload for FolderBot ${currentVersion}.`
    }
  });
}

async function uploadOrReplaceAsset(release, filePath, tokenValue) {
  const fileName = path.basename(filePath);
  const existingAsset = release.assets?.find((asset) => asset.name === fileName);

  if (existingAsset) {
    await githubRequest(`/repos/${owner}/${repo}/releases/assets/${existingAsset.id}`, {
      method: "DELETE",
      token: tokenValue
    });
  }

  await githubUpload(release.upload_url, filePath, tokenValue);
}

async function findReleaseArtifacts(currentVersion) {
  const releaseDir = path.join(process.cwd(), "release");
  const entries = await fs.readdir(releaseDir, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(releaseDir, entry.name))
    .filter((filePath) => isVersionedArtifact(filePath, currentVersion))
    .sort((left, right) => left.localeCompare(right));
}

function isVersionedArtifact(filePath, currentVersion) {
  const fileName = path.basename(filePath);
  if (!fileName.includes(currentVersion)) {
    return false;
  }

  if (fileName.includes(".__uninstaller")) {
    return false;
  }

  const extension = path.extname(fileName).toLowerCase();
  return [".exe", ".dmg", ".deb", ".appimage", ".zip", ".blockmap", ".7z"].includes(extension);
}
