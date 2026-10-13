# Contributing to difnote

Thank you for helping. Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).

difnote is small and quiet on purpose, so a change starts as an issue: for anything past a typo, [open one](https://github.com/mmedum/difnote/issues) first, so we agree on the shape before you write code.

## Run it from your clone

You need Claude Code (CI tests with the version pinned in `.github/workflows/ci.yml`), git, and Node, for `npx`.

Start an interactive session with difnote loaded from your folder:

```sh
claude --plugin-dir .
```

That session also writes Claude Code's API types into `.claude-plugin/types/`, which the type-check needs. Loaded this way, difnote keeps its records of the folders it watches in `.data/` in your clone, which git ignores.

## Checks

CI runs all of these with the same pinned versions. Run them before you open a pull request:

```sh
claude plugin validate --strict .
claude plugin test .
npx --yes -p typescript@7.0.2 tsc -p . --noEmit
npx --yes oxfmt@0.72.0 --check
npx --yes -p oxlint@1.87.0 -p oxlint-tsgolint@7.0.2003 oxlint --type-aware --deny-warnings hooks tests
npx --yes markdownlint-cli2@0.23.3
```

`npx --yes oxfmt@0.72.0` without `--check` formats the code and the Markdown.

## Code

- Everything that touches `$` lives in `hooks/register.tsx`: Claude Code follows `$` only into functions of the same file. The other modules in `hooks/` (`diff.ts`, `review.ts`, `git.ts`, `folders.ts`, `pane.tsx`, `paint.ts`) are pure: they take values and return values or trees.
- Every git command is written out in full where `$.process.run` runs it, in `git()` in `hooks/register.tsx`; paths and ids go on its standard input. A new command needs a row in the README's "What it runs" table.
- Each `$.state` value is declared in `types/index.d.ts`.
- difnote stays quiet: its pane opens only when you ask, it never sends anything to Claude itself, and it leaves your draft in the prompt box as it was, adding the notes after it.
- difnote is written in lowercase, always, also at the start of a sentence. Write American English.
- Comments say why, not what.

## Tests

- Test through the public surface: mount the pane, press its rows, type in its field, and raise the engine's events. `tests/kit.tsx` stands in for Claude Code and the files Claude changes, and `tests/fakegit.ts` for git. The fake answers only the commands difnote runs, the way git does; a change to a command needs a check against real git too, in a session started with `claude --plugin-dir .`.
- State expected values literally, one behavior per test.
- A test must be able to fail: break the code it covers and watch it fail.
- Fixtures use neutral names, never real session names or paths.

## Pull requests

- One change per pull request, linked to its issue.
- Add a line under `## [Unreleased]` in `CHANGELOG.md` for anything a user would notice.
- When difnote reads, runs or writes something new, add it to "How it works" in the README. That list must stay complete: it's what people, and the plugin directory, check difnote against.

## Releasing

For the maintainer:

1. Bump `version` in `.claude-plugin/plugin.json`. Installed copies only update when it changes.
2. In `CHANGELOG.md`, turn `[Unreleased]` into the version's section with today's date, and update the links at the bottom.
3. Commit, push and wait for CI.
4. Tag `vX.Y.Z` (annotated) and publish a GitHub Release with the version's section.

difnote follows [Semantic Versioning](https://semver.org/). While it is on 0.x, keys and commands may change between minor versions.
