import { githubRequest, gitOutput, printScriptUsage, readReleaseEnv, runGit } from "./github-common.mjs";

if (process.argv.includes("--help")) {
  printScriptUsage([
    "Usage: npm run github:repo:init",
    "",
    "Creates the GitHub repository if needed, initializes local git if missing,",
    "and configures the origin remote to https://github.com/<owner>/<repo>.git."
  ]);
  process.exit(0);
}

const { owner, repo, token } = await readReleaseEnv();
const remoteUrl = `https://github.com/${owner}/${repo}.git`;

await ensureLocalGitRepo();
await ensureGithubRepoExists(owner, repo, token);
await configureOriginRemote(remoteUrl);

console.log(`GitHub repository is ready: ${remoteUrl}`);
console.log("Next steps:");
console.log("1. git add .");
console.log('2. git commit -m "Initial import"');
console.log("3. git push -u origin main");

async function ensureLocalGitRepo() {
  try {
    await gitOutput(["rev-parse", "--is-inside-work-tree"]);
  } catch {
    await runGit(["init", "-b", "main"]);
  }
}

async function ensureGithubRepoExists(ownerValue, repoValue, tokenValue) {
  try {
    await githubRequest(`/repos/${ownerValue}/${repoValue}`, { token: tokenValue });
    return;
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("404")) {
      throw error;
    }
  }

  const viewer = await githubRequest("/user", { token: tokenValue });
  const body = {
    name: repoValue,
    private: false,
    has_issues: true,
    has_projects: false,
    has_wiki: false
  };

  if (viewer.login === ownerValue) {
    await githubRequest("/user/repos", {
      method: "POST",
      token: tokenValue,
      body
    });
    return;
  }

  await githubRequest(`/orgs/${ownerValue}/repos`, {
    method: "POST",
    token: tokenValue,
    body
  });
}

async function configureOriginRemote(remoteUrlValue) {
  try {
    const currentUrl = await gitOutput(["remote", "get-url", "origin"]);
    if (currentUrl === remoteUrlValue) {
      return;
    }

    await runGit(["remote", "set-url", "origin", remoteUrlValue]);
  } catch {
    await runGit(["remote", "add", "origin", remoteUrlValue]);
  }
}
