# Changelog

Notable changes to difnote. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and difnote uses [Semantic Versioning](https://semver.org/). While it is on 0.x, keys and commands may change between minor versions.

## [Unreleased]

## [0.1.0] - 2026-10-13

### Added

- `/difnote` opens a pane, and closes it when it's the one shown, with everything that changed since your last review in the folders Claude works in, whoever changed it: Claude's Edit and Write, its shell commands and subagents, a formatter or you. The files come first, each with its icon and what it adds and removes; Enter opens one, its hunks drawn as Claude Code's own highlighted diff, long lines wrapped.
- Works in any folder, git repository or not: difnote records each folder before Claude's first change there, in a private git folder of its own, and never writes to yours. It needs git; the README lists every git command it runs.
- It doesn't watch your home folder, its Desktop, Documents and Downloads, temporary folders, Claude Code's own folder, or a folder over 50,000 files, and says so in the pane; there, Claude's Edit and Write show.
- Binary files, files over 1 MiB and files named like secrets show as changed, with their sizes, without lines; difnote keeps no copy of the last two.
- A Google Doc Claude edited through a Google Docs server shows as one row, with how its edits were made and its link, to review in Google Docs.
- Notes on a file, a hunk or a line: `c` writes one on the row the cursor is on; Enter on a hunk header puts a cursor column beside its code to pick a line. Enter saves, an empty note removes it, Esc cancels. Notes not yet sent stay through `/clear` and restarts, for the session's folder.
- `s` puts the notes into the prompt box after your draft, under "Notes on the changes:", each as `path:line`, the quoted code and your words, for you to edit and send. It reads the noted files first, so each number is where the code is now.
- `j` and `k` walk the rows; `h` and Esc step back, Esc closing the pane last.
- A review ends when you send Claude your own prompt after the pane showed it, unless notes are waiting, or when you press `r`. What the pane showed counts as reviewed, across sessions.
- Options: File icons, and colors for added and removed counts, notes and quiet text.

[Unreleased]: https://github.com/mmedum/difnote/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/mmedum/difnote/releases/tag/v0.1.0
