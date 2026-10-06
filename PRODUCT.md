# Product

## Platform

Desktop app (Electron), Windows first. macOS builds run for development only.

## Users

William, and anyone like him, keeping a home media library on Windows: TV episodes and
movies arrive in a downloads folder and need clean names, the right show and season
folders, and a second copy on a mirror drive. Files are often large (2 to 60 GB) and drives
are often external or networked.

## Product purpose

FolderBot names and files TV episodes and movies. Two jobs:

1. Automatic: watch one inbox folder, and when a download finishes, rename it, copy it to
   the mirror library and move it into the source library.
2. By hand: drop a batch of files, check the new names, rename them.

Every change can be undone from History.

## The rule that matters most

The user must always know what FolderBot is doing with a file and why: still arriving,
settling, locked by another program, queued, copying (with progress and time left),
filed, failed (with the reason and a fix), or skipped. "Waiting" with no reason is a bug.

## Constraints

- Runs in the background from the tray, often for days. Must be quiet when all is well
  and clear when something needs attention.
- Never loses or half-writes a file. Copies land under a temporary name and are renamed
  into place only when complete.
- Settings and history live in the user data folder and survive every update.
