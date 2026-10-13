// difnote's private git folders, as text: the files it writes into one, and
// how it reads what git prints. Pure: hooks/register.tsx runs git.

import type { Bare, FileDiff, Hunk } from '../types'
import { shownPath } from './review'

// Every command runs with the person's own git settings off, also any
// given through the environment, so none of them changes what difnote
// records; and with git's messages in English.
export const ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_PARAMETERS: '',
  GIT_CONFIG_COUNT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  LC_ALL: 'C',
}

// A private git folder's commands also name the folder, its work tree, its
// index and its objects, so that none of git's own variables Claude Code
// may have been started with can point them at another repository.
export function envOf(git: string, folder: string, common = git): Record<string, string> {
  return {
    ...ENV,
    GIT_DIR: git,
    GIT_COMMON_DIR: common,
    GIT_WORK_TREE: folder,
    GIT_INDEX_FILE: `${git}/index`,
    GIT_OBJECT_DIRECTORY: `${common}/objects`,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: '',
    GIT_NAMESPACE: '',
  }
}

// The person's repository, as git's variables name it, with their own
// ignore file, so what it lists is what difnote's own git folder would
// skip: its git folder, the one it shares with its other work trees (for a
// work tree or a submodule, whose .git is a file naming its git folder),
// and the top of the repository.
export function repoEnvOf(dirs: { git: string; common: string }, top: string, excludesFile: string | null): Record<string, string> {
  return {
    ...envOf(dirs.git, top, dirs.common),
    ...(excludesFile === null ? {} : { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.excludesFile', GIT_CONFIG_VALUE_0: excludesFile }),
  }
}

// Where a path names one, from a folder: absolute as given, else under it.
export function under(folder: string, path: string): string {
  return path.startsWith('/') ? path : `${folder}/${path}`
}

// The git folder a .git file names (`gitdir: <path>`); null for other text.
export function gitdirOf(text: string, top: string): string | null {
  const path = /^gitdir:\s*(.+)$/m.exec(text)?.[1]?.trim()
  return path === undefined ? null : under(top, path)
}

// The most files a folder may have for difnote to watch it, and the largest
// file it keeps a copy of, in bytes.
export const MOST_FILES = 50_000
export const MOST_KEPT = 1_048_576

// What difnote never records in a folder that isn't a git repository, which
// has its own .gitignore for these.
export const SKIPPED = [
  'node_modules/',
  '.venv/',
  'venv/',
  '__pycache__/',
  '.cache/',
  '.pytest_cache/',
  '.mypy_cache/',
  '.tox/',
  '.next/',
  'dist/',
  'build/',
  'target/',
  '.gradle/',
]

// Where difnote's own settings start in a private git folder's config file.
const SETTINGS = "# difnote's settings, written again when a session starts"

// A private git folder's settings: git's own, as `git init` wrote them for
// this machine, but not bare; then difnote's, after any it wrote before:
// the person's folder as its work tree, nothing kept of old states, nothing
// done on its own, and the person's own ignore file, their settings off.
// git reads whether a folder is bare before it follows an include, so it
// all goes in the one file.
export function configOf(own: string, folder: string, excludesFile: string | null): string {
  const gits = (own.split(SETTINGS)[0] ?? '').trimEnd().replace(/^(\s*bare\s*=\s*)true\s*$/m, '$1false')
  return [
    gits,
    SETTINGS,
    '[core]',
    `\tworktree = ${quoted(folder)}`,
    '\tlogAllRefUpdates = false',
    '\tautocrlf = false',
    '\tfsmonitor = false',
    '\tsplitIndex = false',
    ...(excludesFile === null ? [] : [`\texcludesFile = ${quoted(excludesFile)}`]),
    '[gc]',
    '\tauto = 0',
    '',
  ].join('\n')
}

const quoted = (value: string) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`

// What a private git folder ignores beyond the folder's .gitignore files: in
// a git repository, what the repository's own .git/info/exclude ignores; in
// another folder, SKIPPED; and in a folder difnote watches only for the
// files Claude wrote into it, its subfolders.
export function excludeOf(kind: 'repository' | 'folder' | 'files', own: string): string {
  const lines =
    kind === 'repository'
      ? ["# The repository's own .git/info/exclude", own.trimEnd()]
      : ['# What difnote never records', ...SKIPPED, ...(kind === 'files' ? ['# Only the files in the folder itself', '/*/'] : [])]
  return `${lines.join('\n')}\n`
}

// A file difnote keeps no copy of, as it records it: why, its size and
// when it changed, so a change to it still shows.
export const PLACEHOLDER = 'difnote: no copy kept'
type Kept = { why: 'large' | 'secret' | 'unreadable'; size: number }

export function placeholderOf(why: Kept['why'], size: number, changedAt: number): string {
  return `${PLACEHOLDER}\n${why} ${size} ${Math.round(changedAt)}\n`
}

function keptOf(lines: readonly string[]): Kept | null {
  const [why, size] = lines[1]?.split(' ') ?? []
  if (lines[0] !== PLACEHOLDER || (why !== 'large' && why !== 'secret' && why !== 'unreadable')) {
    return null
  }
  return { why, size: Number(size) }
}

// The names of files that hold secrets, which difnote keeps no copy of.
const SECRET = /^(?:\.env(?:\..+)?|.+\.(?:pem|key|p12|pfx)|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..+)?|\.netrc|\.pgpass)$/i

export function isSecret(path: string): boolean {
  return SECRET.test(path.slice(path.lastIndexOf('/') + 1))
}

// fast-import's input for the placeholders: each a blob, then its id asked
// for, so the ids come out one to a line in order.
export function blobsOf(texts: readonly string[]): string {
  return `${texts.map((text, i) => `blob\nmark :${i + 1}\ndata ${text.length}\n${text}\nget-mark :${i + 1}\n`).join('')}done\n`
}

// One file in what git printed for the difference of two states: its path
// in the folder, how it changed (A added, D deleted, M modified), the ids of
// its contents before and after, its hunks, whether git found it binary, and
// whether the output was cut before its hunks ended.
export type Entry = { path: string; status: string; before: string; after: string; hunks: Hunk[]; isBinary: boolean; isCut: boolean }

// What git's diff-tree printed: its list of changed files, NUL-separated, then
// each file's patch in the same order. `isCut` where git printed more than
// was read: the files whose patches were cut short are marked.
export function entriesOf(out: string, isCut: boolean): Entry[] {
  const parts = out.split('\0')
  const entries: Entry[] = []
  let at = 0
  while (at + 1 < parts.length && parts[at]?.startsWith(':') === true) {
    const [, , before = '', after = '', status = ''] = (parts[at] ?? '').slice(1).split(' ')
    entries.push({ path: parts[at + 1] ?? '', status, before, after, hunks: [], isBinary: false, isCut: true })
    at += 2
  }
  const patches = parts
    .slice(at)
    .join('\0')
    .replace(/^\0+/, '')
    .split(/^diff --git /m)
    .slice(1)
  patches.forEach((patch, i) => {
    const entry = entries[i]
    if (entry !== undefined) {
      Object.assign(entry, patchOf(patch), isCut && i === patches.length - 1 ? { isCut: true } : {})
    }
  })

  return entries
}

// One file's patch: binary, or its hunks, numbered as difnote numbers them
// (a side with no lines starts at the line after); cut where a hunk ends
// short.
function patchOf(patch: string): Pick<Entry, 'hunks' | 'isBinary' | 'isCut'> {
  const lines = patch.split('\n')
  let at = lines.findIndex(line => line.startsWith('@@ ') || line.startsWith('Binary files '))
  if (at < 0) {
    return { hunks: [], isBinary: false, isCut: false }
  }
  if (lines[at]?.startsWith('Binary files ') === true) {
    return { hunks: [], isBinary: true, isCut: false }
  }

  const hunks: Hunk[] = []
  while (lines[at]?.startsWith('@@ ') === true) {
    const head = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[at] ?? '')
    if (head === null) {
      break
    }
    const oldLines = head[2] === undefined ? 1 : Number(head[2])
    const newLines = head[4] === undefined ? 1 : Number(head[4])
    const hunk: Hunk = {
      oldStart: Number(head[1]) + (oldLines === 0 ? 1 : 0),
      oldLines,
      newStart: Number(head[3]) + (newLines === 0 ? 1 : 0),
      newLines,
      lines: [],
    }
    let olds = oldLines
    let news = newLines
    at += 1
    while ((olds > 0 || news > 0) && at < lines.length) {
      const line = lines[at] ?? ''
      at += 1
      if (line.startsWith('\\')) {
        continue
      }
      const sign = line.startsWith('+') || line.startsWith('-') ? line[0] : ' '
      olds -= sign === '+' ? 0 : 1
      news -= sign === '-' ? 0 : 1
      hunk.lines.push(sign === ' ' && !line.startsWith(' ') ? ` ${line}` : line)
    }
    if (olds > 0 || news > 0) {
      return { hunks, isBinary: false, isCut: true }
    }
    hunks.push(hunk)
    while (lines[at]?.startsWith('\\') === true) {
      at += 1
    }
  }

  return { hunks, isBinary: false, isCut: false }
}

// The content ids of the files below that need their sizes asked for: the
// sides of binary files, of files cut short, and the real side of a file
// that crossed the size difnote keeps.
export function sizesWanted(entries: readonly Entry[]): string[] {
  const none = /^0+$/
  return entries.flatMap(entry => {
    const { old, now } = keptSides(entry)
    const sides =
      entry.isBinary || entry.isCut
        ? [entry.before, entry.after]
        : old !== null || now !== null
          ? [old === null ? entry.before : '', now === null ? entry.after : '']
          : []
    return sides.filter(id => id !== '' && !none.test(id))
  })
}

// What cat-file printed for `sizesWanted`: each id's size.
export function sizesOf(out: string): Map<string, number> {
  return new Map(
    out.split('\n').flatMap(line => {
      const [id, type, size] = line.split(' ')
      return id !== undefined && type !== 'missing' && size !== undefined ? [[id, Number(size)] as const] : []
    }),
  )
}

// The placeholder on each side of a file's change, where it has one.
function keptSides(entry: Entry): { old: Kept | null; now: Kept | null } {
  const side = (sign: string) =>
    entry.hunks.flatMap(hunk => hunk.lines.filter(line => line.startsWith(' ') || line.startsWith(sign)).map(line => line.slice(1)))
  return { old: keptOf(side('-')), now: keptOf(side('+')) }
}

// A file of a watched folder as the pane lists it.
export function fileOf(entry: Entry, folder: string, cwd: string, sizes: ReadonlyMap<string, number>, changedAt: number): FileDiff {
  const path = `${folder}/${entry.path}`
  const isCreate = entry.status === 'A'
  const isDelete = entry.status === 'D'
  // A patch cut short can't be read for placeholders: git's sizes stand.
  const { old, now } = entry.isCut ? { old: null, now: null } : keptSides(entry)
  const sizeOf = (id: string, kept: Kept | null, isGone: boolean) => (isGone ? null : (kept?.size ?? sizes.get(id) ?? null))
  const why = entry.isCut ? 'cut' : (now?.why ?? old?.why ?? (entry.isBinary ? 'binary' : null))
  const bare: Bare | null = why === null ? null : { why, before: sizeOf(entry.before, old, isCreate), after: sizeOf(entry.after, now, isDelete) }
  const hunks = bare === null ? entry.hunks : []
  const lines = hunks.flatMap(hunk => hunk.lines)

  return {
    path,
    shown: shownPath(path, cwd),
    isCreate,
    isDelete,
    hunks,
    added: lines.filter(line => line.startsWith('+')).length,
    removed: lines.filter(line => line.startsWith('-')).length,
    bare,
    changedAt,
    doc: null,
  }
}
