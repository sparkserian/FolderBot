# FolderBot

FolderBot is a cross-platform Electron desktop app for renaming and organizing TV episodes and movies.

## Current Features

- Manual batch rename with preview before applying changes
- Metadata sources: `Local parser`, `TMDb`, and `TheTVDB`
- Manual rename history with undo for full batches or selected items
- Automation watcher for both TV episodes and movies
- Separate automation destinations for:
  - TV source library
  - TV mirror library
  - movie source library
  - movie mirror library
- Launch at login support for installed builds
- Automation history with undo
- Existing-show season repair for one or more selected folders

## Media Behavior

### TV episodes

FolderBot can detect common TV episode patterns such as:

- `S01E02`
- `1x02`
- `Season 1 Episode 2`

When provider data is available, episodes can be renamed into a format like:

```txt
Show Title - S01E02 - Episode Title.ext
```

### Movies

Movies can be renamed from the local parser without an online lookup.

Current movie output format:

```txt
Movie Title (Year) Source HDR/DV Codec Resolution.ext
```

Examples:

```txt
Blade Runner (1982) WEBRip HDR10 x265 1080p.mkv
Alien (1979) BluRay x264 1080p.mkv
```

The movie parser currently preserves:

- year
- source tags such as `WEBRip`, `WEB-DL`, `BluRay`, `Remux`
- HDR-family tags such as `HDR`, `HDR10`, `HDR10+`, `DV`
- codec tags such as `x264`, `x265`
- resolution such as `1080p`, `2160p`

## Automation Flow

FolderBot watches one inbox folder for settled downloads.

### TV automation

- renames the episode
- copies it to the configured TV mirror library
- moves it to the configured TV source library
- creates show and season folders as needed

### Movie automation

- renames the movie
- copies it to the configured movie mirror library
- moves it to the configured movie source library
- places movies directly in the movie root with no per-movie subfolder

Notes:

- automated movies currently use the local parser path
- automation repair is for TV episode history items only

## Run Locally

```bash
npm install
npm run dev
```

## Build

App build:

```bash
npm run build
```

Package desktop binaries:

```bash
npm run package
```

Platform-specific packaging examples:

```bash
npx electron-builder --win --x64
npx electron-builder --mac --arm64
```

## Windows Notes

- The installable build uses NSIS and should uninstall through Windows `Add or Remove Programs`
- The portable `.exe` does not have an uninstall flow; it is removed manually

## GitHub Release Flow

This repo uses a local GitHub publishing flow driven by `.env.local`.

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

4. Commit and push your changes:

```bash
git add .
git commit -m "Your commit message"
git push -u origin main
```

5. Build the version you want to publish
6. Upload the current version's local artifacts from `release/`:

```bash
npm run github:release
```

`github:release` uses the version from `package.json`, creates or updates the GitHub release tag `v<version>`, and uploads matching local artifacts from `release/`.

## Notes

- `.env.local` is ignored by git and should not be committed
- `GH_TOKEN` should have repo access
- `github:release` uploads artifacts for the current package version only
- bump the app version before building a new release
