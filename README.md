# difnote

Review the diff of what changed since you last looked, write a note on any line or hunk, and get your notes in the prompt to edit and send back.

[![CI](https://github.com/mmedum/difnote/actions/workflows/ci.yml/badge.svg)](https://github.com/mmedum/difnote/actions/workflows/ci.yml) [![Release](https://img.shields.io/github/v/release/mmedum/difnote?label=release)](https://github.com/mmedum/difnote/releases/latest)

_difnote_ is a diff and a note: you read what changed, and you say what you think of it, anchored to the line it's about. Its icon says the same: a removed line, an added one, and a note on it.

![The difnote pane showing src/api/client.ts after Claude made fetchOrders take a timeoutMs parameter: one hunk as Claude Code's highlighted diff, three removed lines in red and two added lines in green, long lines wrapped, and the note "Read the default from config, not a literal." right under the added line it's on.](docs/screenshot.png)

When Claude has changed a few files, the feedback you want to give is usually about specific lines: "name this", "keep that guard", "why this file?". Typing that into the prompt means quoting the code by hand. `/difnote` opens a pane with one diff per file, everything that changed in the folders Claude works in since your last review: Claude's edits, its shell commands, its subagents, a formatter, or you. Move to a line, a hunk or a file and press Enter to write a note; press `s`, and the notes go into the prompt box after whatever you've typed, each with its place and the code it's about:

```text
Notes on the changes:

src/api/client.ts:42
> const timeout = 30;
Name this and read it from config.

src/db/pool.ts:12-14
> -  const pool = new Pool(opts)
> +  const pool = createPool(config)
Keep the old name; callers rely on it.
```

You edit them, add what you want Claude to do, and send them yourself. difnote never sends anything to Claude.

## Install

```text
/plugin install difnote --marketplace mmedum/difnote
```

difnote needs `git` on your machine, but your folders don't have to be git repositories. Tested with Claude Code 2.1.296 and git 2.55 in a terminal. Mods don't draw in the VS Code panel, or with `-p`.

Third-party marketplaces don't update on their own. To update, run `claude plugin update difnote@difnote` and restart Claude Code. To remove difnote, run `claude plugin uninstall difnote@difnote`.

## Using it

`/difnote` opens its pane with the keyboard, and closes it when it's the one shown. Esc steps back one level at a time and closes the pane last, as `/diff`'s dialog does. Claude Code puts every mod's pane in the same dock beside the transcript (in a wide fullscreen terminal; otherwise above the prompt), one at a time as tabs: ctrl+x tab switches between them. difnote asks for a dock 100 columns wide, but a width you set yourself wins; ctrl+x ← widens the dock, ctrl+x → narrows it again.

- **The files** changed since your last review, the one changed last first: each with its icon, what it adds and removes, and how many notes it has. The top line says since when. Enter opens a file.
- **One file:** each hunk under a header, drawn as Claude Code's own highlighted diff, long lines wrapped, each note right under the line it's on, then the way on to the next file.
- **Picking a line:** Enter on a hunk header puts a cursor column beside its code; the code keeps its colors. `j` and `k` move along the changed lines, and `c` or Enter writes a note on one. Enter on the header again, or Esc, takes the column away.
- **Notes:** `c` writes one on the row the cursor is on: a file, a hunk or a line, its field opening right under it. Enter saves it, saving it empty removes it, and Esc cancels, leaving the note as it was. Notes you haven't put in the prompt box yet stay through `/clear` and restarts, kept for the folder the session runs in.

| Key       | Does                                                                  |
| --------- | --------------------------------------------------------------------- |
| Enter     | open a file; on a hunk header, pick a line; on a line, write a note   |
| `j` / `k` | the next or previous file, hunk or line                               |
| `c`       | write a note on the row the cursor is on                              |
| `s`       | put the notes into the prompt box, after your draft                   |
| `r`       | with no notes waiting, mark everything shown reviewed                 |
| `h`       | back                                                                  |
| Esc       | back one level: cancel a note, stop picking, back to the files, close |

- **What it lists:** every change in the folders Claude works in, whoever made it: Claude's Edit and Write, its shell commands, its subagents, a formatter or you. A folder is watched from the moment it comes up: the session's folder when the session starts, a folder Claude edits or writes a file in, and a git repository a shell command names by its path or goes into with `cd`. difnote records each such folder before Claude's first change there. A git repository inside a watched folder is watched on its own.
- **What it doesn't watch:** your home folder, its Desktop, Documents and Downloads folders, temporary folders, Claude Code's own folder, and any folder with more than 50,000 files. For a folder outside your home folder and outside the session's, it watches only a git repository. The pane lists each folder it doesn't watch, and why. There, only the changes Claude made with its Edit and Write tools show, as they do for a file that the folder's `.gitignore` leaves out.
- **Files without lines:** a binary file, a file over 1 MiB, and a file named like a secret (`.env`, `.env.*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa` and its kin, `.netrc`, `.pgpass`) show as changed, with their sizes, but without lines: difnote keeps no copy of the last two. A large or secret file whose time changed but whose content didn't shows as changed too, since difnote compares only its size and time. When very much changed at once, a file whose lines didn't fit in what git can hand difnote in one go says so, and shows its lines once the rest is reviewed.
- **Google Docs:** a Google Doc Claude edited through a Google Docs server's tools ([google-docs-mcp](https://github.com/mmedum/google-docs-mcp)'s `edit_document`, `format_document`, `edit_table`, `insert_object`, `layout_document`, `manage_tabs`, `delete_tab`, `review_suggestion` or `create_document`) shows as one row, by its title once Claude has read it. Opening it says how many edits were made as suggestions, directly or as comments, with its link: you review it in Google Docs, where suggestions wait for you to accept or reject them. A note on it goes into the prompt with its title and link.
- **When a review ends:** when you send Claude a prompt of your own after the pane showed the changes, or when you press `r`. What the pane showed counts as reviewed; anything that changed after its last look shows next time. While notes wait to go into the prompt, the review stays open. Slash commands don't end it. The reviewed state belongs to the folder, so it holds across sessions: another session's review in the same folder moves it for both.
- **The notes in the prompt:** a note on a line quotes it, one on a removed line says so, one on a hunk quotes its first changed lines with their `-` and `+`, and one on a file gives its path. When you press `s`, difnote reads each file you wrote notes on and numbers each note where its code is now, so lines added or removed since the pane looked don't throw the numbers off. A note on a line the file no longer has says `(since changed)`, numbered by the lines left around it. If a dialog holds the prompt box, the notes stay in the pane and a message says so.
- **Large changes:** a file draws its hunks up to 60,000 characters of code and says how many it left out; the cursor column reaches a hunk's first 300 lines.

## Settings

Set these in `/config` (type `difnote` to find them) or with `/plugin configure difnote@difnote`. A color takes a theme role, such as `success` or `inactive`, or a color: `#7aa2f7`, `rgb(122,162,247)`, `ansi256(110)` or `ansi:cyan`. A value difnote can't read leaves the default.

- **File icons** (on by default): a [Nerd Font](https://www.nerdfonts.com/) icon before each file, in its language's color: nvim-web-devicons' whole set, found the way it finds them (by the file's name, then its longest extension). Turn it off if your terminal's font has no Nerd Font glyphs.
- **Added color** (`success` by default): how many lines a file or hunk adds.
- **Removed color** (`error` by default): how many lines it removes.
- **Note color** (`suggestion` by default): your notes in the pane.
- **Quiet color** (`inactive` by default): folders, hints and the cursor column.

The code itself takes Claude Code's own diff colors, as in `/diff`.

## How it works

Mods run with your permissions, so here is everything difnote touches. `claude plugin validate` lists the same.

For each folder it watches, difnote keeps a private git folder in Claude Code's data folder for difnote, and uses it to record the folder: once before Claude first changes it, and again each time the pane looks. The pane shows the difference from the state you last reviewed. Your folder doesn't need to be a git repository. If it is one, difnote only reads it and never writes to your `.git`, index, branches, stash or hooks.

### What it runs

`git`, and only `git`. Each command is written out in full in `hooks/register.tsx`; the paths and ids that differ from call to call go on its standard input, never on its command line. Your own git settings are switched off for difnote's commands (`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, and no settings given through the environment), except to ask for your global ignore file, so they can't change what difnote records. Each command also names the git folder it works on, its work tree and its index in git's own variables (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE` and their kin), so none that Claude Code was started with can point it elsewhere.

| Command                                                                     | Runs                                                               | Why                                                                                                                                    |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `git --version`                                                             | when a session starts                                              | to know whether git is there; without it, only Claude's Edit and Write show                                                            |
| `git config --global --path --get core.excludesFile`                        | when a session starts                                              | your own global ignore file, which difnote's records follow too                                                                        |
| `git init --quiet`                                                          | the first time difnote watches a folder                            | to make its private git folder                                                                                                         |
| `git --no-optional-locks ls-files -z --cached --ignored --exclude-standard` | each time a git repository is recorded                             | the files your repository tracks though its `.gitignore` or your own ignore file matches them, so they are recorded too; it only reads |
| `git ls-files -z --others --exclude-standard`                               | each time a folder is recorded                                     | the files that are new since the last record, and not ignored                                                                          |
| `git diff-files -z --name-only`                                             | each time a folder is recorded                                     | the files that changed since the last record                                                                                           |
| `git update-index -z --add --remove --stdin`                                | each time a folder is recorded                                     | to record those files, up to 1 MiB each                                                                                                |
| `git update-index -z --force-remove --stdin`                                | when a file became a folder                                        | to take it out of the record                                                                                                           |
| `git fast-import --quiet --done`                                            | for a file over 1 MiB, named like a secret, or unreadable          | a placeholder with its size and time, in place of its content                                                                          |
| `git update-index -z --index-info`                                          | after `fast-import`                                                | to record those placeholders                                                                                                           |
| `git write-tree`                                                            | each time a folder is recorded                                     | to keep the record as one state                                                                                                        |
| `git update-ref --stdin`                                                    | after each record, when a review ends, for a folder unused 30 days | to point at the state shown and the state reviewed, or let them go                                                                     |
| `git rev-parse --verify --quiet refs/difnote/base`                          | when a session first watches a folder                              | whether it has a reviewed state already                                                                                                |
| `git diff-tree … refs/difnote/base refs/difnote/shown`                      | when the pane looks                                                | the difference between the reviewed state and now                                                                                      |
| `git cat-file --batch-check`                                                | for files without lines                                            | their sizes                                                                                                                            |
| `git check-ignore -z --stdin`                                               | when the pane looks                                                | which of Claude's Edit and Write files a watched folder ignores                                                                        |
| `git read-tree --empty`                                                     | for a folder unused for 30 days                                    | to empty its record                                                                                                                    |
| `git gc --quiet --prune=1.hour.ago`                                         | once a day per folder, and for a folder unused for 30 days         | to pack the records and let go of states no review needs                                                                               |

All but `version`, `config`, `init` and the one that reads your repository run inside difnote's private git folder (`git --git-dir=.`). Whether a folder is in a git repository, and where its top is, difnote finds by looking for a `.git` folder or file above it, without running git. Git runs with Claude Code's own rule for mods: your repository's hooks are off.

### What it reads

- The folders it watches, through git, as above, and each changed file's size and time (`$.fs.list`, `$.fs.stat`). Of your own repositories: whether a folder holds a `.git` folder or file, to find where a repository starts; a `.git` file's and the git folder's `commondir`, for a work tree or a submodule; `.git/info/exclude`, which it copies into its private git folder so its records ignore what yours do; and, through git, the list of files the repository tracks. It writes nothing there.
- The results of Claude's Edit and Write calls in this conversation, as they happen and, when a session starts or restarts, from the conversation Claude Code stored (`$.session.messages`): each file's path, the file before the change and after it, and the change's hunks. They stand in for files in folders difnote doesn't watch.
- The commands of Claude's shell calls, for the paths they name, and the list of files Claude Code reports a command changed in a git repository.
- The calls Claude makes to a Google Docs server's editing tools, and what `get_document` answers: each document's link, the mode an edit was made in, and the document's title.
- The prompt box when you press `s`, only to tell whether it's empty, so the notes go after your draft with a blank line between.
- The files you wrote notes on, when you press `s` (`$.fs.read`), to number each note where its code is in the file now.
- The session's id and folder, and the color options.

### What it keeps, and where

- **Its records of your folders**, under Claude Code's data folder for difnote: `~/.claude/plugins/data/difnote-difnote/roots/` when installed from this repository's marketplace (inside the plugin's own folder, under `.data/`, when you load it with `--plugin-dir`). For each folder, one private git folder holds the text of its files up to 1 MiB, and of larger files and files named like secrets only their size and time. Only two states are kept, the one you last reviewed and the one the pane last showed. Once a day git lets go of older ones. A folder unused for 30 days is emptied. Claude Code deletes a plugin's data folder when you uninstall the plugin; you can also delete it yourself at any time, and difnote starts over.
- **Claude Code's plugin store**, which only difnote reads: your notes until they go into the prompt box, by the session's folder; when each watched folder was last reviewed, used and tidied; and where the last review of Claude's Edit and Write records ended in each of the last 100 sessions.

### What it writes

- Your notes into the prompt box when you press `s` (`$.prompt.fill`, after the draft). You send them yourself.
- Its private git folders and the plugin store, as above. Nothing in your own folders.

### What its hooks change

Nothing that passes through them. Its hooks on tool calls and prompts hand them on unchanged. Before Claude changes a folder difnote hasn't recorded yet, its hook waits up to 5 seconds for that record. It adds the `/difnote` command and its pane.

## Privacy

difnote collects no data about you and sends nothing anywhere. It runs only on your machine, inside Claude Code. It keeps copies of the text files in the folders it watches, up to 1 MiB each and never of files named like secrets, on your machine only, as described above, until your next review, or 30 days unused.

## Contributing

Questions and bugs: [open an issue](https://github.com/mmedum/difnote/issues). For a pull request, open an issue first. [CONTRIBUTING.md](CONTRIBUTING.md) says how to run, test and release difnote. To report a security problem, see [SECURITY.md](SECURITY.md).

## License

[Apache-2.0](LICENSE) © 2026 Mark Medum Bundgaard. The file icons in `hooks/devicons.ts` come from [nvim-web-devicons](https://github.com/nvim-tree/nvim-web-devicons), MIT License, © 2023 nvim-tree; the file carries its notice.
