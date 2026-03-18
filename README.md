# FolderBot

FolderBot is a cross-platform Electron desktop app for renaming and organizing TV media files. The current app includes:

- manual batch rename with preview
- TMDb and TheTVDB provider support
- undo history for manual renames
- automation watcher for TV episodes
- automation history and undo
- season-folder repair tooling for existing shows

## Run Locally

```bash
npm install
npm run dev
```

## Production build

```bash
npm run build
```

To generate packaged desktop binaries:

```bash
npm run package
```

## GitHub Release Flow

This repo is set up for a local GitHub publishing flow driven by `.env.local`.

1. Copy `.env.example` to `.env.local`
2. Fill in:

```env
GH_RELEASE_OWNER=
GH_RELEASE_REPO=
GH_TOKEN=
```

3. Initialize the GitHub repo and local remote:

```bash
npm run github:repo:init
```

4. Make your first commit and push:

```bash
git add .
git commit -m "Initial import"
git push -u origin main
```

5. After you build a new version, upload the current version's local artifacts from `release/` to GitHub Releases:

```bash
npm run github:release
```

`github:release` uses the version from `package.json`, creates or updates the GitHub release tag `v<version>`, and uploads all matching local artifacts for that version from the `release/` folder.

## Notes

- `.env.local` is ignored by git and should never be committed.
- `GH_TOKEN` should be a GitHub token with repo access.
- `github:release` uploads the artifacts for the current package version only.
