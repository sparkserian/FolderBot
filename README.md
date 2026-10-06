# FolderBot

FolderBot names and files TV episodes and movies on Windows, by hand or automatically.

- **Activity**: watches one inbox folder. When a download finishes and stops changing, FolderBot
  renames it, copies it to the mirror library and moves it into the source library. Every file
  shows what is happening and why: still arriving, settling, in use by another program, ready,
  copying (bytes, speed, time left, step), filed, failed (with the reason and what to do), or
  skipped. Failed files can be retried; busy-file and network problems retry on their own.
- **Rename**: drop a batch of files, check the new names side by side, rename. Names come from
  the filename alone (offline), TheTVDB or TMDb; online lookups ask once per show.
- **History**: one timeline of everything renamed or filed, with undo and a fix for a wrong show.
- **Settings**: folders, metadata keys, notifications, start at sign-in, updates, season-folder
  repair, the watcher log.

FolderBot keeps running in the tray while the watcher is on, notifies when files are filed or
fail, and updates itself from GitHub Releases.

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

## How the watcher files a file

1. A new file in the inbox is watched until its size and date stop changing for the settle time
   (45 seconds by default). A matching `.part`, `.crdownload`, `.!qb` or similar file means the
   download is still running.
2. FolderBot checks it can open the file. If another program holds it, the file shows as "In use"
   until it is released.
3. Files are filed one at a time, oldest first. FolderBot checks there is room on both library
   drives, then copies to the mirror library and moves into the source library. Copies stream in
   8 MB chunks to a `.folderbot-partial` file that is renamed into place only when complete.
4. The result is recorded in History, where it can be undone. An undone file goes back to the
   inbox and is left alone until it changes.

Only files directly in the inbox are filed. Videos inside a folder in the inbox are reported on
the Activity page so they are not silently ignored.

## Install, update, uninstall

- **Install**: run `FolderBot-Setup-<version>.exe`. It installs for the current user only, needs
  no admin rights, adds Start menu and desktop shortcuts, and opens FolderBot. The installer is
  not code-signed, so Windows SmartScreen asks for confirmation the first time.
- **Updates**: FolderBot checks GitHub Releases 15 seconds after starting and every 4 hours,
  downloads a new version in the background and shows "Restart to update". If ignored, the
  update installs the next time FolderBot quits.
- **Uninstall**: Settings › Apps › FolderBot › Uninstall. It asks whether to delete settings and
  history (kept by default). Updates never delete them.
- **Moving from 1.x**: the 2.x installer removes a 1.x install itself rather than running its old
  uninstaller (which failed on 1.0.21 and earlier). Settings and history in
  `%APPDATA%\FolderBot` are kept. `scripts/windows-repair-install.ps1` remains for a stuck 1.x
  install, but should no longer be needed.

## Development

```bash
npm install
node node_modules/electron/install.js   # npm 11 skips Electron's download script
npm run dev
```

Checks (all run by `npm run check`):

- `npm run check:parser`: filename parsing regression cases
- `npm run check:storage`: settings and history files survive interrupted writes
- `npm run check:watcher`: drives the real watcher against a temporary inbox (arriving,
  settling, partial downloads, copy progress on a 1.5 GB file, failures, skips)
- `npm run check:ui`: loads the built interface in headless Chrome with a stub bridge

`npm run preview:ui -- <outDir>` saves screenshots of every page in light and dark with sample
data (`scripts/ui-stub.js`), for design review without Windows.

## Build and release

```bash
npm run package    # release/FolderBot-Setup-<version>.exe, built on macOS or Windows
npm run release    # checks, builds and publishes to GitHub Releases (needs GH_TOKEN)
```

Bump `version` in `package.json` before a release; installed copies update to it automatically.
Design notes are in `PRODUCT.md` and `DESIGN.md`; the 2.0 rebuild plan is `docs/plan.md`.
