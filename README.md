# FolderBot

FolderBot is a cross-platform Electron desktop app for renaming and organizing TV episodes and movies.

## Current Features

- Manual batch rename with a side-by-side preview before anything is written
- Metadata sources: `Local parser`, `TMDb`, and `TheTVDB`
- Series confirmation grouped by show, so a whole season is one answer
- Manual rename history with undo for full batches or selected items
- Automation watcher for both TV episodes and movies
- Separate automation destinations for:
  - TV source library
  - TV mirror library
  - movie source library
  - movie mirror library
- Launch at login support for installed builds
- Automation history with undo and a per-item show fix
- Existing-show season repair for one or more selected folders
- Tabbed settings and history, and a tray icon that renders on Windows

## Media Behavior

### TV episodes

Season and episode markers are read no matter what separates them. Anything that is not a
letter or digit counts as a separator, so all of these resolve to the same episode:

- `S01E02`
- `S01 E02`, `S01_E02`, `S01.E02`, `S01-E02`, `S01xE02`
- `S1E2`, `S01EP02`, `S 01 E 02`
- `1x02` and `01 x 02`
- `Season 1 Episode 2` and `Season 01 - Episode 02`
- `Show S01 05` and multi-episode files such as `S01E01-E02`

Files with an episode number but no season, such as `Show - Ep 5`, are read as absolute
episode numbers and mapped with provider data.

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

Tracker sites and release-group names in front of the title are dropped, so
`www.SomeTracker.com - The Dark Knight (2008) 1080p.mkv` resolves to `The Dark Knight`.
When a name holds more than one year, a year in brackets wins, and otherwise the last one
does, which keeps titles like `Blade Runner 2049 (2017)` intact.

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

## Development Scripts

Check filename parsing against the regression cases in `scripts/check-parser.mjs`:

```bash
npm run check:parser
```

Regenerate the app, installer, and tray icons from `build/icon-glyph.svg`. This needs a local
Chrome, Chromium, or Edge to rasterize, and writes `build/icon.png`, `build/icon.ico`, and
`src/main/tray-icon.ts`:

```bash
npm run icons
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
- Installing a newer build over an older one keeps settings and history. Both live in the
  Electron user data folder, which is keyed to the app ID and product name, and neither changes
  between releases

### Upgrading from 1.0.21 or earlier

Those builds shipped an uninstaller whose custom hook ran `nsExec::ExecToLog` without popping
the return value off the NSIS stack. With FolderBot not running, `taskkill` exits with `128`
instead of `0`, and the uninstaller exits non-zero.

A new installer runs the old uninstaller to remove the previous version. When that keeps
failing it reports `FolderBot cannot be closed. Please close it manually and then click Retry`,
then `Failed to uninstall all the application files`. The wording names the wrong cause: any
non-zero exit produces it, whether or not the app is running.

The broken uninstaller is the one already on disk, so no new installer can repair it. Clear
the old install once:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows-repair-install.ps1
```

Add `-WhatIfOnly` to see what it would remove without changing anything. It never touches
`%APPDATA%\FolderBot`, so credentials and history survive. Upgrades from 1.0.22 onward do not
need this.
- The window draws its own title bar and uses the Windows overlay for the system buttons, so
  there is no native menu strip

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
