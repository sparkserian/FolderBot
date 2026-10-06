# FolderBot 2.0 rebuild

Started 2026-10-06. One stage at a time; tick each when it passes typecheck,
the check scripts and a build, then commit it to `main`.

Decisions (William, 2026-10-06):
- Updates download quietly from GitHub Releases and ask to restart. If the
  prompt is ignored, the update installs on the next quit.
- One-click installer for the current user only. No wizard, no admin prompt.
- Look: a calm native Windows 11 app that follows the system light or dark
  setting.

Kept as they are: the filename parser, the TMDb and TheTVDB providers, the
rename service, and the history stores. They have check scripts and work.

## Stages

- [x] 1. Watcher engine. Every inbox file is a job with a stage (found,
  growing, settling, locked, matching, copying, moving, filed, failed,
  skipped), a plain reason, its size, and copy progress (bytes, speed, time
  left). Copies stream in chunks so a 20 GB file reports progress. Locked or
  failed files say why and can be retried or skipped. Missing or unreachable
  folders and full drives are reported, not swallowed.
- [x] 2. Main process. Update service (electron-updater, GitHub provider),
  system notifications when a file is filed or fails, a tray that shows the
  watcher state, single IPC surface for jobs (retry, skip, open folder, open
  log).
- [x] 3. Interface rebuild in React. Sidebar: Activity, Rename, History,
  Settings. Activity is the live view of the watcher. Rename is drop, match,
  review, rename. History merges manual and automation records in one
  timeline. Settings: General (startup, language, updates), Metadata
  sources, Automation (setup), Maintenance (season repair), About.
- [x] 4. Installer and uninstaller. One-click per-user NSIS, stable artifact
  name, publish config for updates, removes an old 1.x install without
  running its uninstaller, uninstall removes login entries and asks whether
  to keep settings and history.
- [ ] 5. Verify and package. Check scripts updated, screenshots of every
  screen in light and dark, a large-file copy test on this Mac, Windows
  installer built.
