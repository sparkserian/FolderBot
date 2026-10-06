# Design

Chosen 2026-10-06: a calm native Windows 11 app. It should feel like it shipped with
Windows, next to Settings and File Explorer, not like a web page in a frame.

## World

- Mica window material behind a translucent sidebar and title bar; content sits on one
  slightly lifted layer with a rounded top-left corner, as in Windows Settings.
- Follows the system light or dark setting (`prefers-color-scheme`) and the Windows accent
  colour (passed from `systemPreferences.getAccentColor()`, fallback `#0067C0`).
- Type: Segoe UI Variable (Display for page titles, Text for everything else) on Windows;
  the platform UI font elsewhere. Scale follows Fluent: 28 title, 20 subtitle, 14 body
  strong, 14 body, 12 caption.
- Icons: Phosphor regular, 16 px in rows, 20 px in navigation.
- Corners 4 px on controls, 8 px on cards and dialogs. Borders are 1 px hairlines at low
  contrast; elevation comes from a soft offset shadow on dialogs and flyouts only.

## Status vocabulary

Status is the loudest thing in the app and the only place colour carries meaning.

| Stage | Colour | Icon |
|---|---|---|
| copying, moving, matching | accent | animated progress |
| arriving, settling, queued | neutral | clock / hourglass |
| locked | caution (amber) | lock |
| failed | critical (red) | warning |
| filed | success (green) | check |
| skipped | neutral, dimmed | skip |

Progress always shows bytes done of total, speed, time left, and which step of how many.

## Layout

- Left navigation: Activity, Rename, History; Settings pinned at the bottom with the
  watcher's one-line state above it.
- Activity is the home screen. It answers "what is FolderBot doing right now?" before
  anything else.
- Settings uses Windows settings cards: icon, title, one-line description, control on the
  right. Changes save as they are made.
