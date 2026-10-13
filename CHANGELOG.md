# Changelog

Notable changes to difnote. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and difnote uses [Semantic Versioning](https://semver.org/). While it is on 0.x, keys and commands may change between minor versions.

## [Unreleased]

## [0.2.0] - 2026-10-14

### Added

- `v` marks a file viewed, as on GitHub: its row goes quiet with a ✓, and the mark drops once the file changes again, so what Claude changes after your notes shows again.
- `r` asks before it marks everything reviewed, as a review can't be undone.
- The pane names the folders it watches again from earlier sessions here, and `x` on one stops watching it from here, leaving its changes unreviewed.
- When a folder unused for 30 days is emptied with changes you hadn't reviewed, the session says so, in a message and in the pane.

### Changed

- The pane is one list: Enter opens a file's hunks right under its row, and `h` or Esc closes it again, the cursor back on its row; there is no separate file view and no line picking. difnote draws its own cursor, a bar beside its row, that moves over files, folder headings, hunk headers and changed lines with `j`/`k` or the arrows. The summary stays at the top and the keys at the bottom, however long the file; the first key says what Enter does. Files are grouped under their folders, by name. Long lines wrap, and `w` cuts them to one row but the cursor's. `n` opens the next file. A new Cursor color option.
- `/difnote` no longer closes the pane. With the pane open, behind another tab or with the keyboard in the prompt box, it gives the pane the keyboard again, where you left it, a note you were writing too; Esc closes it.
- A review ends only when you choose, with `r`. Sending your notes and your other prompts leave the list as it is, so you can go on reviewing while Claude works; before, any prompt you sent after the pane showed the changes marked them reviewed.

### Fixed

- Going back from a file put the cursor on the wrong file.
- Where a note or the cursor splits a hunk that reaches line 10, 100 or 1,000, its line numbers no longer shift a column between the parts.
- difnote runs its commands on its private git folders from `/`. Run from that folder, git read a path, and the name of a reviewed state, as files of the folder being watched when the private git folder lay inside it, as it does with difnote loaded from its own repository: that folder failed with "ambiguous argument 'refs/difnote/base'".
- An open pane looks again by itself 10 seconds after its last look, so changes no hook sees, yours, a script's or another session's, show without reopening it; before, a pane with nothing in it never looked again. A look by itself first asks git whether anything is new, with two commands that only read, and records only the folders where something is; it waits longer after a slow look, leaves a folder whose look took over 3 seconds twice to the other looks, pauses while you write a note, and stops while the pane is closed or behind another tab.
- A later session in the same folder watches again the folders outside it that Claude changed in earlier sessions there, such as a repository Claude changed with `cd`, while their changes wait for review; before, they showed only in the session that made them. A look no longer counts as using a folder for the 30-day emptying: Claude changing it, a review or a session starting in it does.

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

[Unreleased]: https://github.com/mmedum/difnote/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/mmedum/difnote/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/mmedum/difnote/releases/tag/v0.1.0
