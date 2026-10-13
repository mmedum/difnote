// What the pane lists and what the prompt gets: the changes since the last
// review as one diff per file, the rows the person moves over, and the
// notes written on them as the prompt carries them.

import type { Change, DocEdit, FileDiff, Hunk, Note } from '../types'
import { edited, hunksOf, linesOf, patched } from './diff'

// One of Claude's changes from its Edit or Write record; null for any other
// tool, a record without the fields, or a change held for review, which
// left the file as it was.
export function changeOf(id: string, tool: string, record: unknown): Change | null {
  if (!isRecord(record) || record.staged === true || typeof record.filePath !== 'string') {
    return null
  }

  const path = record.filePath
  const hunks = Array.isArray(record.structuredPatch) ? record.structuredPatch.filter(isHunk) : []
  const before = typeof record.originalFile === 'string' ? record.originalFile : null
  if (tool === 'Write' && typeof record.content === 'string') {
    return { id, path, before, after: record.content, isCreate: record.type === 'create', hunks, doc: null }
  }
  if (tool === 'Edit' && typeof record.oldString === 'string' && typeof record.newString === 'string') {
    const fromHunks = before === null || hunks.length === 0 ? null : patched(before, hunks)
    const after = fromHunks ?? (before === null ? null : edited(before, record.oldString, record.newString, record.replaceAll === true))
    return { id, path, before, after, isCreate: false, hunks, doc: null }
  }

  return null
}

// The Google Docs tools that change a document, by the end of their names,
// whatever the server is called: the ones of github.com/mmedum/google-docs-mcp.
const DOC_TOOL =
  /^mcp__.+__(create_document|edit_document|format_document|edit_table|insert_object|layout_document|manage_tabs|delete_tab|review_suggestion)$/

// A Google Doc's link, from its id or any of its links.
export function docLink(document: string): string {
  const id = /\/d\/([\w-]+)/.exec(document)?.[1] ?? document.trim()
  return `https://docs.google.com/document/d/${id}/edit`
}

// One of Claude's edits of a Google Doc, from its tool call and result;
// null for any other tool, a dry run, or a call the server refused or
// failed, which it answers in square brackets.
export function docOf(id: string, tool: string, input: unknown, result: unknown, titles: ReadonlyMap<string, string>): Change | null {
  const name = DOC_TOOL.exec(tool)?.[1]
  const text = textOf(result)
  if (name === undefined || !isRecord(input) || input.dry_run === true || text.trimStart().startsWith('[')) {
    return null
  }
  const link =
    name === 'create_document'
      ? (/https:\/\/docs\.google\.com\/document\/d\/[\w-]+/.exec(text)?.[0] ?? null)
      : typeof input.document === 'string'
        ? input.document
        : null
  if (link === null) {
    return null
  }
  const path = docLink(link)
  // The mode the server answered it used; else the one asked for; else the
  // server's own default, suggestions.
  const mode = /"mode":\s*"(\w+)"/.exec(text)?.[1] ?? (typeof input.mode === 'string' ? input.mode : 'suggest')
  const how: DocEdit['how'] =
    name === 'create_document'
      ? 'create'
      : name === 'review_suggestion'
        ? 'review'
        : name === 'manage_tabs' || name === 'delete_tab'
          ? 'direct'
          : mode === 'direct' || mode === 'comment'
            ? mode
            : 'suggest'
  const title = name === 'create_document' && typeof input.title === 'string' ? input.title : (titles.get(path) ?? null)
  return { id, path, before: null, after: null, isCreate: how === 'create', hunks: [], doc: { how, title } }
}

// A Google Doc's title, from what reading it answered: get_document's first
// line is the title, its second the link.
export function titleOf(tool: string, result: unknown): [string, string] | null {
  if (!/^mcp__.+__get_document$/.test(tool)) {
    return null
  }
  const [title = '', link = ''] = textOf(result).split('\n')
  return title.trim() === '' || !link.startsWith('https://docs.google.com/document/') ? null : [docLink(link), title.trim()]
}

// A tool's result as text: as given, or its text parts.
function textOf(result: unknown): string {
  if (typeof result === 'string') {
    return result
  }
  const parts = Array.isArray(result) ? result : isRecord(result) && Array.isArray(result.content) ? result.content : []
  return parts.flatMap(part => (isRecord(part) && typeof part.text === 'string' ? [part.text] : [])).join('\n')
}

// The files Claude changed, by its Edit and Write records, the one changed
// last first: each one's hunks from before Claude's first change to after
// its latest. Where the file before the first change or after the latest is
// unknown, or the diff too large, the latest change's own hunks stand in.
export function filesOf(changes: readonly Change[], cwd: string, titles: ReadonlyMap<string, string> = new Map()): FileDiff[] {
  const byPath = new Map<string, Change[]>()
  for (const change of changes) {
    byPath.set(change.path, [...(byPath.get(change.path) ?? []), change])
  }

  return [...byPath.entries()]
    .map(([path, list]) => {
      const first = list[0]
      const latest = list.at(-1)
      const docs = list.flatMap(change => (change.doc === null ? [] : [change.doc]))
      if (docs.length > 0) {
        // The title Claude read last, also after the edit.
        const title = titles.get(path) ?? docs.findLast(doc => doc.title !== null)?.title ?? null
        return {
          last: changes.findLastIndex(change => change.path === path),
          file: {
            path,
            shown: title ?? /\/d\/([\w-]+)/.exec(path)?.[1] ?? path,
            isCreate: docs.some(doc => doc.how === 'create'),
            isDelete: false,
            hunks: [],
            added: 0,
            removed: 0,
            bare: null,
            changedAt: 0,
            doc: docs.map(doc => doc.how),
          },
        }
      }
      const before = first?.isCreate === true ? '' : (first?.before ?? null)
      const after = latest?.after ?? null
      const worked = before === null || after === null ? null : hunksOf(linesOf(before), linesOf(after))
      const hunks = worked ?? latest?.hunks ?? []
      const lines = hunks.flatMap(hunk => hunk.lines)
      return {
        last: changes.findLastIndex(change => change.path === path),
        file: {
          path,
          shown: shownPath(path, cwd),
          isCreate: first?.isCreate === true,
          isDelete: false,
          hunks,
          added: lines.filter(line => line.startsWith('+')).length,
          removed: lines.filter(line => line.startsWith('-')).length,
          bare: null,
          changedAt: 0,
          doc: null,
        },
      }
    })
    .toSorted((x, y) => y.last - x.last)
    .map(({ file }) => file)
}

// A path as the person reads it: relative to the session's folder when it
// is inside it, else as it is.
export function shownPath(path: string, cwd: string): string {
  const folder = cwd.endsWith('/') ? cwd : `${cwd}/`
  return path.startsWith(folder) ? path.slice(folder.length) : path
}

// What the pane draws, top to bottom. The person moves over the file rows,
// the hunk headers and the changed lines; context lines are only read.
export type Row =
  | { kind: 'file'; key: string; file: FileDiff }
  | { kind: 'hunk'; key: string; file: FileDiff; hunk: Hunk; from: number; to: number; changed: string[] }
  | { kind: 'line'; key: string; file: FileDiff; sign: '+' | '-'; text: string; at: number }
  | { kind: 'context'; key: string; file: FileDiff; text: string; at: number }

// What a row's key holds of a line's text: enough to tell a line Claude
// changed after a note was written on it from the line the note was on.
const KEY_TEXT = 60

// The rows of the files. A line's `at` is its number in the file after
// Claude's change, or, for a removed line, the number of the line now in
// its place. A changed line's key names its file, its side, its text and
// which of the lines with that text it is, not its number, so lines Claude
// adds or removes above it leave a note on it where it was; a hunk's, its
// first changed line the same way.
export function rowsOf(files: readonly FileDiff[]): Row[] {
  return files.flatMap(file => {
    const seen = new Map<string, number>()
    const nth = (text: string) => {
      const n = seen.get(text) ?? 0
      seen.set(text, n + 1)
      return `${n}:${text.slice(0, KEY_TEXT)}`
    }
    return [
      { kind: 'file' as const, key: `file:${file.path}`, file },
      ...file.hunks.flatMap(hunk => {
        const changed = hunk.lines.filter(line => line.startsWith('+') || line.startsWith('-'))
        const lines: Row[] = []
        let oldLine = hunk.oldStart
        let newLine = hunk.newStart
        for (const line of hunk.lines) {
          const text = line.slice(1)
          if (line.startsWith('+')) {
            lines.push({ kind: 'line', key: `line:${file.path}:${nth(line)}`, file, sign: '+', text, at: newLine })
            newLine += 1
          } else if (line.startsWith('-')) {
            lines.push({ kind: 'line', key: `line:${file.path}:${nth(line)}`, file, sign: '-', text, at: newLine })
            oldLine += 1
          } else if (line.startsWith(' ')) {
            lines.push({ kind: 'context', key: `context:${file.path}:${newLine}`, file, text, at: newLine })
            oldLine += 1
            newLine += 1
          }
        }
        // A hunk spans its changed lines, not the context around them.
        const at = lines.flatMap(row => (row.kind === 'line' ? [row.at] : []))
        const from = Math.min(...at)
        const to = Math.max(...at)
        const key = `hunk:${file.path}:${nth(`@${changed[0] ?? ''}`)}`
        return [{ kind: 'hunk' as const, key, file, hunk, from, to, changed }, ...lines]
      }),
    ]
  })
}

// How many changed lines of a hunk a note on its header quotes.
export const HUNK_QUOTE = 3

// A note's anchor and quote, from the row it is written on: a line's number
// and text, marked when the line was removed; a hunk's range of lines and
// its first changed lines, each with its - or +, so old reads apart from
// new; a file's path alone. `shift` moves the numbers to where the lines
// stand now (see placeOf).
export function anchorOf(row: Row, shift = 0): { anchor: string; quote: string[] } {
  if (row.kind === 'file') {
    return { anchor: row.file.doc === null ? row.file.shown : `${row.file.shown} (${row.file.path})`, quote: [] }
  }
  if (row.kind === 'hunk') {
    const range = row.to > row.from ? `${row.from + shift}-${row.to + shift}` : `${row.from + shift}`
    const quote = row.changed.slice(0, HUNK_QUOTE)
    return { anchor: `${row.file.shown}:${range}`, quote: row.changed.length > HUNK_QUOTE ? [...quote, '…'] : quote }
  }

  return { anchor: `${row.file.shown}:${row.at + shift}${row.kind === 'line' && row.sign === '-' ? ' (removed)' : ''}`, quote: [row.text] }
}

// The number of the line with this text nearest to line `near`, in the file
// as it is now; null where the file has no such line.
export function lineNow(file: string, text: string, near: number): number | null {
  let best: number | null = null
  file.split('\n').forEach((line, i) => {
    if (line === text && (best === null || Math.abs(i + 1 - near) < Math.abs(best - near))) {
      best = i + 1
    }
  })
  return best
}

// Where a row's lines are in the file as it is now, after Claude's last Edit
// or Write: a formatter, a shell command or the person may have changed the
// file since. The lines of the row's hunk that are in the file, its added
// and context lines, are found as one block, the copy nearest where they
// were, so a line such as `}` that the file has many times goes with its own
// hunk. Where the block was changed too, a row moves as far as the nearest
// of the hunk's lines the file still has, an added line first by its own.
// `changed` where the row's own line is gone, or none of its hunk is left.
export function placeOf(row: Row, rows: readonly Row[], file: string): { shift: number; changed: boolean } {
  const at = rows.indexOf(row)
  let first = at
  while (first > 0 && rows[first]?.kind !== 'hunk') {
    first -= 1
  }
  let last = first + 1
  while (last < rows.length && rows[last]?.kind !== 'hunk' && rows[last]?.kind !== 'file') {
    last += 1
  }
  const stays = rows
    .slice(first + 1, last)
    .flatMap((one, i) => (one.kind === 'context' || (one.kind === 'line' && one.sign === '+') ? [{ ...one, index: first + 1 + i }] : []))
  if (stays.length === 0) {
    return { shift: 0, changed: false }
  }

  const lines = file.split('\n')
  const from = (stays[0]?.at ?? 1) - 1
  let block: number | null = null
  for (let i = 0; i + stays.length <= lines.length; i += 1) {
    if (stays.every((one, j) => lines[i + j] === one.text) && (block === null || Math.abs(i - from) < Math.abs(block - from))) {
      block = i
    }
  }
  if (block !== null) {
    return { shift: block - from, changed: false }
  }

  // An added line comes first here, as the nearest to itself.
  const added = row.kind === 'line' && row.sign === '+'
  for (const one of stays.toSorted((x, y) => Math.abs(x.index - at) - Math.abs(y.index - at))) {
    const now = lineNow(file, one.text, one.at)
    if (now !== null) {
      return { shift: now - one.at, changed: added && one.key !== row.key }
    }
  }
  return { shift: 0, changed: true }
}

// The line that heads the notes in the prompt box; the prompt you send with
// it ends the review.
export const NOTES_HEADER = 'Notes on the changes:'

// The notes as they go into the prompt box: one line saying what they are,
// then each note's anchor, the code it quotes and the person's words, in
// the order of the rows they are on. Each anchor is where its row is in the
// file as it is now, where `files` holds it (see placeOf); a note on a line
// the file no longer has says "(since changed)". A note whose row is gone,
// as Claude changed it since, keeps the anchor it was written with, says
// so, and comes last.
export function promptOf(notes: readonly Note[], rows: readonly Row[], files: ReadonlyMap<string, string> = new Map()): string {
  const order = new Map(rows.map((row, i) => [row.key, i]))
  const placed = notes.map((note, i) => ({ note, at: order.get(note.target) ?? rows.length + i }))
  const blocks = placed
    .toSorted((x, y) => x.at - y.at)
    .map(({ note, at }) => {
      const row = rows[at]
      if (row === undefined) {
        return [`${note.anchor} (since changed)`, ...note.quote.map(line => `> ${line}`), note.text].join('\n')
      }
      const file = files.get(row.file.path)
      const { shift, changed } = row.kind === 'file' || file === undefined ? { shift: 0, changed: false } : placeOf(row, rows, file)
      const { anchor, quote } = anchorOf(row, shift)
      return [changed ? `${anchor} (since changed)` : anchor, ...quote.map(line => `> ${line}`), note.text].join('\n')
    })

  return [NOTES_HEADER, ...blocks].join('\n\n')
}

function isHunk(value: unknown): value is Hunk {
  return (
    isRecord(value) &&
    typeof value.oldStart === 'number' &&
    typeof value.oldLines === 'number' &&
    typeof value.newStart === 'number' &&
    typeof value.newLines === 'number' &&
    Array.isArray(value.lines) &&
    value.lines.every(line => typeof line === 'string')
  )
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// A file's change as a short fingerprint: the same while its change is the
// same, another once anything in it changes, as when Claude edits it again.
export function fingerprintOf(file: FileDiff): string {
  const text = JSON.stringify([file.isCreate, file.isDelete, file.bare, file.doc, file.hunks])
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0
  }
  return `${hash.toString(16)}:${text.length}`
}

// A hunk as unified-diff text, as Claude Code's highlighter reads it: its
// header (a side with no lines numbered from the line before it), then its
// lines.
export function hunkText(hunk: Hunk): string {
  const start = (line: number, count: number) => (count === 0 ? line - 1 : line)
  const header = `@@ -${start(hunk.oldStart, hunk.oldLines)},${hunk.oldLines} +${start(hunk.newStart, hunk.newLines)},${hunk.newLines} @@`
  return [header, ...hunk.lines].join('\n')
}

// A hunk cut into pieces after each of the lines at `after` (indexes into
// its lines), each piece numbered where it starts, so the code can be drawn
// in parts with a note under a line.
export function splitHunk(hunk: Hunk, after: ReadonlySet<number>): Hunk[] {
  const pieces: Hunk[] = []
  let piece: Hunk = { oldStart: hunk.oldStart, oldLines: 0, newStart: hunk.newStart, newLines: 0, lines: [] }
  hunk.lines.forEach((line, i) => {
    piece.lines.push(line)
    if (!line.startsWith('+')) {
      piece.oldLines += 1
    }
    if (!line.startsWith('-')) {
      piece.newLines += 1
    }
    if (after.has(i) && i < hunk.lines.length - 1) {
      pieces.push(piece)
      piece = { oldStart: piece.oldStart + piece.oldLines, oldLines: 0, newStart: piece.newStart + piece.newLines, newLines: 0, lines: [] }
    }
  })
  pieces.push(piece)
  return pieces
}
