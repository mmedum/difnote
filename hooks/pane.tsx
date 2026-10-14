// The pane: one list of the files changed since the last review. Enter
// opens a file's hunks under its own row, drawn as Claude Code's highlighted
// diff, and closes it again. difnote draws its own window over the list,
// with the summary pinned above it and the keys pinned below, and its own
// cursor, a bar beside the row it is on. The rows are planned before they
// are drawn (layoutOf): what each is, how many rows of the pane it takes,
// and which the cursor stops on; the window and the drawing read the same
// plan, so what is counted is what is drawn.

import type { ElementTable, RenderElement } from 'claude-code'
import type { Bare, DocEdit, FileDiff, Hunk, Note, Place, Watch } from '../types'
import { isInside, parentOf } from './folders'
import { iconOf } from './icons'
import type { Row } from './review'
import { fingerprintOf, hunkText } from './review'

export type Ui = Pick<ElementTable, 'Box' | 'Text' | 'Button' | 'Code'>
export type InputElement = ElementTable<'terminal' | 'desktop'>['Input']

// The color options, each a theme role or a color (see paint.ts): the lines
// a file or hunk adds and removes, as counted; the notes; the quiet text,
// folders and hints; and the cursor's bar. The code itself takes Claude
// Code's own diff colors.
export type Colors = { added: string; removed: string; note: string; quiet: string; cursor: string }

// What planning and drawing need: the elements (an Input where the surface
// has one), the pane's width and height, whether it holds the keyboard, the
// colors, whether files show their icons, the files and all their rows,
// what difnote watches, whether it is looking, the time now, the notes, the
// row whose note field is open, and where the person is.
export type PaneView = {
  ui: Ui
  Input?: InputElement | undefined
  columns: number
  height: number
  isFocused: boolean
  colors: Colors
  hasIcons: boolean
  files: readonly FileDiff[]
  rows: readonly Row[]
  watch: Watch
  isLooking: boolean
  now: number
  notes: readonly Note[]
  editing: string | null
  place: Place
  viewed: Record<string, string>
}

// Whether the person marked a file viewed, and it hasn't changed since.
export function isViewed(view: Pick<PaneView, 'viewed'>, file: FileDiff): boolean {
  const mark = view.viewed[file.path]
  return mark !== undefined && mark === fingerprintOf(file)
}

// What the person's keys and the note field do.
export type Actions = {
  act: () => void
  down: () => void
  up: () => void
  out: () => void
  in: () => void
  note: () => void
  next: () => void
  wrap: () => void
  viewed: () => void
  send: () => void
  reviewed: () => void
  drop: () => void
  close: () => void
  save: (row: Row, text: string) => void
}

// The keys of the button that keeps Claude Code's focus ring, which Enter
// presses, and of the note field, which takes the ring while it is open.
export const ENTER = 'enter'
export const FIELD = 'note-field'

// The start of the keys of the rows naming the folders carried from earlier
// sessions.
export const FOLDER = 'folder:'

// Rows a code line may take, wrapped; past them its text is cut, marked …
export const MOST_ROWS = 12

// A tab in code, spaced out by difnote to the next of these columns, so the
// rows a line takes are known before Claude Code draws it.
const TAB = 4

// Blank rows past the keys: the pane clips them, and so has rows to scroll,
// which makes the arrows reach difnote as scrolls rather than walk the
// buttons.
const MARGIN_ROWS = 3

// Cut to `width` cells, an ellipsis marking the cut; tabs as two spaces.
export function fit(text: string, width: number): string {
  const chars = codePoints(text.replaceAll('\t', '  '))
  let cells = 0
  let end = 0
  for (; end < chars.length; end += 1) {
    const next = cells + cellsOf(chars[end] ?? '')
    if (next > width) {
      break
    }
    cells = next
  }
  if (end === chars.length) {
    return chars.join('')
  }
  if (width <= 0) {
    return ''
  }
  // Room for the ellipsis.
  let kept = chars.slice(0, end)
  while (kept.length > 0 && cellsOf(kept.join('')) > width - 1) {
    kept = kept.slice(0, -1)
  }
  return `${kept.join('')}…`
}

// Cut from the start, for a path: its end is what tells files apart.
export function fitStart(text: string, width: number): string {
  if (cellsOf(text) <= width) {
    return text
  }
  if (width <= 0) {
    return ''
  }
  const chars = codePoints(text)
  let kept: string[] = []
  for (let i = chars.length - 1; i >= 0 && cellsOf([chars[i] ?? '', ...kept].join('')) <= width - 1; i -= 1) {
    kept = [chars[i] ?? '', ...kept]
  }
  return `…${kept.join('')}`
}

// A text's characters as the terminal places them: one per code point, a
// pair of surrogates together.
function codePoints(text: string): string[] {
  return Array.from(text)
}

// How many cells of the terminal a text takes: two for a wide character,
// as East Asian scripts and most emoji are, none for a combining mark or a
// zero-width character, one for the rest.
export function cellsOf(text: string): number {
  let cells = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    cells += isZeroWidth(code) ? 0 : isWide(code) ? 2 : 1
  }
  return cells
}

function isZeroWidth(code: number): boolean {
  return (code >= 0x0300 && code <= 0x036f) || (code >= 0x200b && code <= 0x200f) || code === 0xfe0f || code === 0x20e3
}

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x1fa70 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  )
}

// A line of code with its tabs spaced out to the next TAB column.
export function untabbed(text: string): string {
  if (!text.includes('\t')) {
    return text
  }
  let out = ''
  for (const char of text) {
    out += char === '\t' ? ' '.repeat(TAB - (cellsOf(out) % TAB)) : char
  }
  return out
}

// Prose cut into lines of at most `width` cells, at spaces where it can be,
// a word longer than a line cut where it must be.
export function wrapped(text: string, width: number): string[] {
  const room = Math.max(1, width)
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    let line = ''
    for (const word of paragraph.split(' ')) {
      const joined = line === '' ? word : `${line} ${word}`
      if (cellsOf(joined) <= room) {
        line = joined
        continue
      }
      if (line !== '') {
        lines.push(line)
      }
      line = word
      while (cellsOf(line) > room) {
        const chars = codePoints(line)
        let cut = 0
        while (cut < chars.length && cellsOf(chars.slice(0, cut + 1).join('')) <= room) {
          cut += 1
        }
        lines.push(chars.slice(0, Math.max(1, cut)).join(''))
        line = chars.slice(Math.max(1, cut)).join('')
      }
    }
    lines.push(line)
  }
  return lines
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

// The line at the top: what the pane covers and what it holds.
export function summaryOf(view: Pick<PaneView, 'files' | 'notes' | 'watch' | 'isLooking' | 'now' | 'viewed'>): string {
  const { files, notes, isLooking } = view
  const seen = files.filter(file => isViewed(view, file)).length
  return [
    `since ${sinceOf(view)}`,
    plural(files.length, 'file', 'files'),
    ...(seen === 0 ? [] : [`${seen} viewed`]),
    ...(notes.length === 0 ? [] : [plural(notes.length, 'note', 'notes')]),
    ...(isLooking ? ['looking…'] : []),
  ].join(' · ')
}

// Since when the pane shows changes: the time the oldest state it compares
// against was recorded, the day too when not today; else the last review.
function sinceOf(view: Pick<PaneView, 'watch' | 'now'>): string {
  const { since } = view.watch
  return since === null ? 'your last review' : timeOf(since, view.now)
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// A time on this machine's clock, as 14:02, or 9 Oct 14:02 when not on the
// day of `now`.
export function timeOf(at: number, now: number): string {
  const then = new Date(at)
  const clock = `${String(then.getHours()).padStart(2, '0')}:${String(then.getMinutes()).padStart(2, '0')}`
  return then.toDateString() === new Date(now).toDateString() ? clock : `${then.getDate()} ${MONTHS[then.getMonth()] ?? ''} ${clock}`
}

// A size in bytes, as people read it.
export function sizeOf(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  return bytes < 1_048_576 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1_048_576).toFixed(1)} MB`
}

// A Google Doc's icon: Font Awesome's Google mark, in Google's blue.
const GOOGLE_DOC = { glyph: '\u{f1a0}', color: '#4285f4' }

const HOW: Record<Exclude<DocEdit['how'], 'create'>, [string, string]> = {
  suggest: ['edit as suggestions', 'edits as suggestions'],
  direct: ['edit made directly', 'edits made directly'],
  comment: ['edit as comments', 'edits as comments'],
  review: ['time it accepted or rejected suggestions', 'times it accepted or rejected suggestions'],
}

// How Claude edited a Google Doc, under its row: whether it made it, how
// many edits of each kind, and that it is reviewed in Google Docs.
export function docWords(hows: readonly DocEdit['how'][]): string {
  const counts = (['suggest', 'direct', 'comment', 'review'] as const).flatMap(how => {
    const n = hows.filter(one => one === how).length
    return n === 0 ? [] : [`${n} ${n === 1 ? HOW[how][0] : HOW[how][1]}`]
  })
  const parts = [...(hows.includes('create') ? ['made by Claude'] : []), ...counts]
  return `In Google Docs: ${parts.join(', ')}. Review it there, where suggestions wait for you and version history keeps the rest:`
}

// What a file drawn without lines is, in its row.
const BARE: Record<Bare['why'], string> = {
  binary: 'binary',
  large: 'over 1 MiB',
  secret: 'secret',
  unreadable: 'unreadable',
  cut: 'too much at once',
}

// Why a file has no lines, and its sizes, under its row.
export function bareOf(bare: Bare): string {
  const why = {
    binary: 'A binary file',
    large: 'Over 1 MiB, so difnote keeps no copy of it',
    secret: 'Named like a secret, so difnote keeps no copy of it',
    unreadable: "git couldn't read it",
    cut: 'Too much changed at once for difnote to read its lines',
  }[bare.why]
  const { before, after } = bare
  // Sizes that read the same rounded read in bytes, so the change shows.
  const isSame = before !== null && after !== null && before !== after && sizeOf(before) === sizeOf(after)
  const bytes = (size: number) => `${size.toLocaleString('en-US')} B`
  const sizes =
    before !== null && after !== null
      ? isSame
        ? `${bytes(before)} → ${bytes(after)}`
        : `${sizeOf(before)} → ${sizeOf(after)}`
      : after !== null
        ? `now ${sizeOf(after)}`
        : before !== null
          ? `was ${sizeOf(before)}`
          : ''
  return `${why}: no lines to show.${sizes === '' ? '' : ` ${sizes}.`}`
}

// A hunk header's words: the lines it spans, what it adds and removes, and
// its notes.
export function hunkLabel(row: Extract<Row, { kind: 'hunk' }>, notes: number): string {
  const lines = row.to > row.from ? `lines ${row.from}–${row.to}` : `line ${row.from}`
  const added = row.changed.filter(line => line.startsWith('+')).length
  const removed = row.changed.length - added
  const counts = [added > 0 ? `+${added}` : '', removed > 0 ? `−${removed}` : ''].filter(part => part !== '').join(' ')
  return [lines, counts, ...(notes > 0 ? [`✎${notes}`] : [])].join(' · ')
}

// The folders carried from earlier sessions that still hold changes, each
// with how many of the files listed are in it.
export function carriedOf(view: Pick<PaneView, 'files' | 'watch'>): { folder: string; usedAt: number; count: number }[] {
  return view.watch.carried.flatMap(one => {
    const count = view.files.filter(file => file.doc === null && isInside(file.path, one.folder)).length
    return count === 0 ? [] : [{ ...one, count }]
  })
}

// The files as the list groups them: under the folder they are watched in,
// the session's first and the rest by path, Google Docs last; in each, by
// their folder in it, folders by path and then the files at its top; each
// folder's files by name. A folder's key names its root and its path in it.
export type Group = { root: string; label: string; dirs: { key: string; dir: string; files: FileDiff[] }[] }

export function groupsOf(files: readonly FileDiff[], watch: Pick<Watch, 'roots' | 'home'>): Group[] {
  const own = watch.roots[0] ?? ''
  const rootOf = (file: FileDiff): string => {
    if (file.doc !== null) {
      return DOCS
    }
    if (!file.shown.startsWith('/')) {
      return own
    }
    const found = watch.roots.filter(root => root !== own && isInside(file.path, root)).toSorted((x, y) => y.length - x.length)[0]
    return found ?? parentOf(file.path)
  }
  const inRoot = (file: FileDiff, root: string): string => {
    if (file.doc !== null) {
      return ''
    }
    const path = file.shown.startsWith('/') ? file.path.slice(root.length + 1) : file.shown
    const cut = path.lastIndexOf('/')
    return cut < 0 ? '' : path.slice(0, cut)
  }
  const byRoot = new Map<string, FileDiff[]>()
  for (const file of files) {
    const root = rootOf(file)
    byRoot.set(root, [...(byRoot.get(root) ?? []), file])
  }
  const order = (root: string) => (root === own ? 0 : root === DOCS ? 2 : 1)
  return [...byRoot]
    .toSorted(([x], [y]) => order(x) - order(y) || (x < y ? -1 : x > y ? 1 : 0))
    .map(([root, list]) => {
      const byDir = new Map<string, FileDiff[]>()
      for (const file of list) {
        const dir = inRoot(file, root)
        byDir.set(dir, [...(byDir.get(dir) ?? []), file])
      }
      const dirs = [...byDir]
        .toSorted(([x], [y]) => (x === '' ? 1 : 0) - (y === '' ? 1 : 0) || (x < y ? -1 : x > y ? 1 : 0))
        .map(([dir, inDir]) => ({
          key: `dir:${root}|${dir}`,
          dir,
          files: inDir.toSorted((x, y) => (nameIn(x) < nameIn(y) ? -1 : nameIn(x) > nameIn(y) ? 1 : 0)),
        }))
      return { root, label: root === DOCS ? DOCS : homed(root, watch.home), dirs }
    })
}

// The heading Google Docs are listed under.
const DOCS = 'Google Docs'

// A file's name in its row: the last part of its path; a Google Doc's title.
function nameIn(file: FileDiff): string {
  return file.doc === null ? file.shown.slice(file.shown.lastIndexOf('/') + 1) : file.shown
}

// A folder written from the home folder as ~.
function homed(folder: string, home: string | null): string {
  return home !== null && isInside(folder, home) ? `~${folder.slice(home.length)}` : folder
}

// ---------------------------------------------------------------------------
// The plan.

// The rows by their file's path, made once for each set of rows.
let byFile: { rows: readonly Row[] | null; map: Map<string, Row[]> } = { rows: null, map: new Map() }
function byFileOf(rows: readonly Row[]): Map<string, Row[]> {
  if (byFile.rows !== rows) {
    const map = new Map<string, Row[]>()
    for (const row of rows) {
      const list = map.get(row.file.path)
      if (list === undefined) {
        map.set(row.file.path, [row])
      } else {
        list.push(row)
      }
    }
    byFile = { rows, map }
  }
  return byFile.map
}

// One thing the list shows, the rows of the pane it takes, and its key: a
// file's row; the open file's hunk headers and code lines, each line with
// its numbers on both sides and the gutter's digits; a note under its row,
// its lines already cut; the note field; prose cut into lines; a folder
// from earlier sessions.
type Base = { key: string; rows: number }
type HunkRow = Extract<Row, { kind: 'hunk' }>
type LineRow = Extract<Row, { kind: 'line' | 'context' }>
export type Item =
  | (Base & { kind: 'file'; file: FileDiff; indent: number })
  | (Base & { kind: 'hunk'; row: HunkRow })
  | (Base & { kind: 'code'; row: LineRow; hunk: string; line: string; old: number; new: number; digits: number; isCut: boolean })
  | (Base & { kind: 'note'; lines: string[]; indent: number })
  | (Base & { kind: 'field'; row: Row })
  | (Base & { kind: 'text'; lines: string[]; tone: 'quiet' | 'plain' })
  | (Base & { kind: 'folder'; folder: string; usedAt: number; count: number })
  | (Base & { kind: 'root'; label: string; count: number })
  | (Base & { kind: 'dir'; dir: string; count: number; isClosed: boolean; indent: number })

// The digits of a diff's gutter as Claude Code draws a hunk: those of the
// last line number its header spans on either side.
export function gutterDigits(hunk: Hunk): number {
  return String(Math.max(1, hunk.oldStart + hunk.oldLines - 1, hunk.newStart + hunk.newLines - 1)).length
}

// The rows of the pane a line of code takes at `room` cells beside its
// gutter, wrapped as Claude Code wraps code: by character.
function codeRows(text: string, room: number): number {
  return Math.max(1, Math.ceil(cellsOf(text) / Math.max(1, room)))
}

// Whether the cursor stops on an item: files, hunk headers, changed lines
// and folders; context, notes and prose are only read.
export function isStop(item: Item): boolean {
  return (
    item.kind === 'file' ||
    item.kind === 'dir' ||
    item.kind === 'hunk' ||
    item.kind === 'folder' ||
    (item.kind === 'code' && item.row.kind === 'line')
  )
}

// The items of the list at a width, for where the person is.
export function itemsOf(view: PaneView, cursor: string | null): Item[] {
  const { files, rows, notes, editing, place, columns } = view
  // Every row gives its first column to the cursor's bar.
  const width = Math.max(4, columns - 1)
  const items: Item[] = []
  const noteOf = (key: string) => notes.find(note => note.target === key)
  const under = (row: Row, indent: number) => {
    if (editing === row.key) {
      items.push({ kind: 'field', key: `field:${row.key}`, rows: width - indent < 60 ? 2 : 1, row })
      return
    }
    const note = noteOf(row.key)
    if (note !== undefined) {
      const lines = wrapped(`✎ ${note.text}`, width - indent - 2)
      items.push({ kind: 'note', key: `note:${row.key}`, rows: lines.length, lines, indent })
    }
  }
  const prose = (key: string, text: string, tone: 'quiet' | 'plain', indent = 0) => {
    const lines = wrapped(text, width - indent).map(line => `${' '.repeat(indent)}${line}`)
    items.push({ kind: 'text', key, rows: lines.length, lines, tone })
  }

  // A file's row; open, its hunks, each header then its lines, with the
  // notes under the rows they are on.
  const planFile = (file: FileDiff, indent: number) => {
    items.push({ kind: 'file', key: `file:${file.path}`, rows: 1, file, indent })
    const own = byFileOf(rows).get(file.path) ?? []
    const title = own.find(row => row.kind === 'file')
    if (title !== undefined) {
      under(title, indent + 2)
    }
    if (place.open !== file.path) {
      return
    }
    if (file.doc !== null) {
      prose(`doc:${file.path}`, docWords(file.doc), 'quiet', indent + 2)
      prose(`link:${file.path}`, file.path, 'plain', indent + 2)
    } else if (file.bare !== null) {
      prose(`bare:${file.path}`, bareOf(file.bare), 'quiet', indent + 2)
    }
    let hunk: HunkRow | null = null
    let digits = 1
    let old = 0
    let now = 0
    for (const row of own) {
      if (row.kind === 'hunk') {
        hunk = row
        digits = gutterDigits(row.hunk)
        old = row.hunk.oldStart
        now = row.hunk.newStart
        items.push({ kind: 'hunk', key: row.key, rows: 1, row })
        under(row, 2)
      } else if ((row.kind === 'line' || row.kind === 'context') && hunk !== null) {
        const sign = row.kind === 'context' ? ' ' : row.sign
        const text = untabbed(row.text)
        // The gutter: the number's digits, a space before and after them,
        // and the sign.
        const room = width - (digits + 3)
        const isCompact = place.isCompact && row.key !== cursor
        const full = codeRows(text, room)
        const shown = isCompact ? 1 : Math.min(full, MOST_ROWS)
        const isCut = !isCompact && full > MOST_ROWS
        const line = `${sign}${isCut ? fit(text, MOST_ROWS * room - 1) : text}`
        items.push({ kind: 'code', key: row.key, rows: shown, row, hunk: hunk.key, line, old, new: now, digits, isCut })
        old += sign === '+' ? 0 : 1
        now += sign === '-' ? 0 : 1
        if (row.kind === 'line') {
          under(row, 4)
        }
      }
    }
  }

  const groups = groupsOf(files, view.watch)
  // A group's heading says where its files are: shown unless the one group
  // is the session's own folder.
  const isHeaded = groups.length > 1 || groups.some(group => group.root !== (view.watch.roots[0] ?? ''))
  for (const group of groups) {
    if (isHeaded) {
      items.push({
        kind: 'root',
        key: `root:${group.root}`,
        rows: 1,
        label: group.label,
        count: group.dirs.reduce((sum, dir) => sum + dir.files.length, 0),
      })
    }
    for (const dir of group.dirs) {
      const isClosed = place.closed.includes(dir.key)
      if (dir.dir !== '') {
        items.push({ kind: 'dir', key: dir.key, rows: 1, dir: dir.dir, count: dir.files.length, isClosed, indent: 0 })
      }
      if (!isClosed) {
        for (const file of dir.files) {
          planFile(file, dir.dir === '' ? 0 : 2)
        }
      }
    }
  }

  if (files.length === 0 && !view.watch.hasGit) {
    prose('nogit', "Without git, difnote sees only Claude's Edit and Write.", 'quiet')
  }
  const carried = carriedOf(view)
  if (carried.length > 0) {
    items.push({ kind: 'text', key: 'gap:carried', rows: 1, lines: [''], tone: 'quiet' })
    prose('heading:carried', 'From earlier sessions here, until you review them:', 'quiet')
    for (const one of carried) {
      items.push({ kind: 'folder', key: `${FOLDER}${one.folder}`, rows: 1, ...one })
    }
  }
  const keys = new Set(rows.map(row => row.key))
  const gone = notes.filter(note => !keys.has(note.target))
  if (gone.length > 0) {
    items.push({ kind: 'text', key: 'gap:gone', rows: 1, lines: [''], tone: 'quiet' })
    prose('heading:gone', 'Notes on lines changed since:', 'quiet')
    for (const note of gone) {
      const lines = wrapped(`✎ ${note.anchor} · ${note.text}`, width - 4)
      items.push({ kind: 'note', key: `gone:${note.target}`, rows: lines.length, lines, indent: 2 })
    }
  }
  const blocks: [string, string, string[]][] = [
    ['slow', "Slow to look at, so looked at only after Claude's changes or a key:", view.watch.slow],
    ['skipped', "Not watched, so only Claude's Edit and Write show there:", view.watch.skipped.map(({ folder, why }) => `${folder} (${why})`)],
    ['lost', "Emptied after 30 days unused, with changes you hadn't reviewed:", view.watch.lost],
  ]
  for (const [name, heading, lines] of blocks) {
    if (lines.length > 0) {
      items.push({ kind: 'text', key: `gap:${name}`, rows: 1, lines: [''], tone: 'quiet' })
      prose(`heading:${name}`, heading, 'quiet')
      lines.forEach((line, i) => prose(`${name}:${i}`, line, 'quiet', 2))
    }
  }
  return items
}

// The keys the footer offers on the cursor's item, in the order shown, each
// with its hotkey (null for the button Enter presses), its label and what
// it does; while a note is being written, none.
export type Key = { key: string; hotkey: string | null; label: string; act: keyof Omit<Actions, 'save'> }

export function keysOf(view: PaneView, item: Item | undefined, order: readonly FileDiff[]): Key[] {
  if (view.editing !== null) {
    return []
  }
  const open = view.place.open
  const hasNote = (key: string) => view.notes.some(note => note.target === key)
  const isInOpen = item !== undefined && (item.kind === 'hunk' || item.kind === 'code')
  const isOpenFile = item?.kind === 'file' && open === item.file.path
  const enter: Key[] =
    item === undefined
      ? []
      : item.kind === 'file'
        ? [{ key: ENTER, hotkey: null, label: isOpenFile ? '↵ close' : '↵ open', act: 'act' }]
        : item.kind === 'dir'
          ? [{ key: ENTER, hotkey: null, label: item.isClosed ? '↵ open folder' : '↵ close folder', act: 'act' }]
          : item.kind === 'folder'
            ? [{ key: ENTER, hotkey: null, label: '↵ open newest', act: 'act' }]
            : item.kind === 'root'
              ? []
              : [{ key: ENTER, hotkey: null, label: hasNote(item.key) ? '↵ edit note' : '↵ note', act: 'act' }]
  const inLabel =
    item?.kind === 'file' ? (isOpenFile ? 'in' : 'open') : item?.kind === 'dir' && item.isClosed ? 'open' : item?.kind === 'hunk' ? 'in' : null
  const outLabel =
    isInOpen || isOpenFile ? 'close' : item?.kind === 'file' && item.indent > 0 ? 'folder' : item?.kind === 'dir' && !item.isClosed ? 'close' : null
  const current = item?.kind === 'file' ? item.file.path : open
  const isLast = order.length === 0 || order.at(-1)?.path === current
  const canNote = item !== undefined && (item.kind === 'file' || item.kind === 'hunk' || item.kind === 'code')
  const marked = item?.kind === 'file' ? item.file : isInOpen ? view.files.find(one => one.path === open) : undefined
  const viewedLabel = marked === undefined ? null : isViewed(view, marked) ? 'not viewed' : 'viewed'
  return [
    ...enter,
    ...(inLabel === null ? [] : [{ key: 'key-in', hotkey: 'l', label: inLabel, act: 'in' } as const]),
    ...(outLabel === null ? [] : [{ key: 'key-out', hotkey: 'h', label: outLabel, act: 'out' } as const]),
    ...(canNote ? [{ key: 'key-note', hotkey: 'c', label: 'note', act: 'note' } as const] : []),
    ...(viewedLabel === null ? [] : [{ key: 'key-viewed', hotkey: 'v', label: viewedLabel, act: 'viewed' } as const]),
    ...(open !== null && !isLast ? [{ key: 'key-next', hotkey: 'n', label: 'next file', act: 'next' } as const] : []),
    ...(open !== null ? [{ key: 'key-wrap', hotkey: 'w', label: view.place.isCompact ? 'wrap' : 'compact', act: 'wrap' } as const] : []),
    ...(item?.kind === 'folder' ? [{ key: 'key-drop', hotkey: 'x', label: 'stop watching', act: 'drop' } as const] : []),
    ...(view.notes.length > 0
      ? [{ key: 'send', hotkey: 's', label: `send ${plural(view.notes.length, 'note', 'notes')}`, act: 'send' } as const]
      : view.files.length > 0
        ? [{ key: 'key-reviewed', hotkey: 'r', label: 'mark all reviewed', act: 'reviewed' } as const]
        : []),
    ...(item !== undefined ? [{ key: 'key-down', hotkey: 'j', label: 'down', act: 'down' } as const] : []),
    ...(item !== undefined ? [{ key: 'key-up', hotkey: 'k', label: 'up', act: 'up' } as const] : []),
    { key: 'key-close', hotkey: 'q', label: 'close', act: 'close' },
  ]
}

// The text a key shows: its hotkey and label, as Claude Code draws a plain
// button with a hotkey; Enter's button its label alone.
function keyText(one: Key): string {
  return one.hotkey === null ? one.label : `${one.hotkey}: ${one.label}`
}

const FIELD_HINT = '↵ save · empty removes · Esc cancels'

// The rows the footer takes at a width: its keys laid out as Claude Code
// wraps a row of them, two cells apart.
function footerRows(keys: readonly Key[], width: number, isEditing: boolean): number {
  if (isEditing) {
    return wrapped(FIELD_HINT, width).length
  }
  let rows = 1
  let used = 0
  for (const one of keys) {
    const cells = cellsOf(keyText(one))
    if (used > 0 && used + 2 + cells > width) {
      rows += 1
      used = cells
    } else {
      used += (used > 0 ? 2 : 0) + cells
    }
  }
  return rows
}

// The list planned for the pane: its items, the files in the order listed,
// the keys of the items the cursor stops on, the cursor's key (the one
// asked for, else the nearest stop left of it), the footer's keys, the rows
// the window has, its first item, and the open file's row when it stands in
// for the window's first row because it scrolled above it.
export type Layout = {
  items: Item[]
  order: FileDiff[]
  stops: string[]
  cursor: string | null
  keys: Key[]
  window: number
  top: number
  sticky: Item | null
}

export function layoutOf(view: PaneView): Layout {
  const asked = view.place.cursor
  // The cursor's own rows depend on whether it is on a line, so the plan
  // is made once for the key asked, then checked.
  let items = itemsOf(view, asked)
  let stops = items.filter(isStop).map(item => item.key)
  const cursor = stops.includes(asked ?? '') ? asked : nearestStop(items, asked, view.place.open)
  if (cursor !== asked) {
    items = itemsOf(view, cursor)
    stops = items.filter(isStop).map(item => item.key)
  }
  const at = items.findIndex(item => item.key === cursor)
  const order = groupsOf(view.files, view.watch).flatMap(group => group.dirs.flatMap(dir => dir.files))
  const keys = keysOf(view, items[at], order)
  const width = Math.max(4, view.columns)
  const window = Math.max(3, view.height - 1 - footerRows(keys, width, view.editing !== null))
  const margin = window < 12 ? 1 : 2
  let top = topFor(items, at, view.place.top, window, margin)
  let sticky = stickyAt(items, top, view.place.open)
  if (sticky !== null) {
    top = topFor(items, at, top, window - 1, margin)
    sticky = stickyAt(items, top, view.place.open)
  }
  return { items, order, stops, cursor, keys, window, top, sticky }
}

// A stop for a cursor whose row is gone, as after a review or Claude's
// change of its line: the open file's row, else the first stop.
function nearestStop(items: readonly Item[], asked: string | null, open: string | null): string | null {
  if (asked !== null && open !== null) {
    const own = items.find(item => item.kind === 'file' && item.file.path === open)
    if (own !== undefined) {
      return own.key
    }
  }
  return items.find(isStop)?.key ?? null
}

// The first item the window shows: the one asked for, moved as little as it
// takes to show the cursor with `margin` rows around it, and never so far
// down that the window ends short of its height with items left above.
export function topFor(items: readonly Item[], at: number, asked: number, window: number, margin: number): number {
  const rowsOf = (from: number, to: number) => items.slice(from, to).reduce((sum, item) => sum + item.rows, 0)
  let top = Math.max(0, Math.min(asked, items.length - 1))
  if (at >= 0) {
    if (at < top) {
      top = at
    }
    while (top > 0 && rowsOf(top, at) < margin) {
      top -= 1
    }
    while (top < at && rowsOf(top, at + 1) + margin > window) {
      top += 1
    }
  }
  // No empty rows at the bottom while items sit above the window.
  while (top > 0 && rowsOf(top - 1, items.length) <= window) {
    top -= 1
  }
  return top
}

// The open file's row, when the window starts inside that file below it.
function stickyAt(items: readonly Item[], top: number, open: string | null): Item | null {
  if (open === null) {
    return null
  }
  const at = items.findIndex(item => item.kind === 'file' && item.file.path === open)
  if (at < 0 || at >= top) {
    return null
  }
  const end = items.findIndex(
    (item, i) =>
      i > at && (item.kind === 'file' || item.kind === 'dir' || item.kind === 'root' || item.kind === 'folder' || item.key.startsWith('gap:')),
  )
  return top < (end < 0 ? items.length : end) ? (items[at] ?? null) : null
}

// ---------------------------------------------------------------------------
// The drawing.

export function paneOf(view: PaneView, layout: Layout, actions: Actions): RenderElement {
  const { ui, colors, files, notes, columns } = view
  const { Box, Text } = ui
  const width = Math.max(1, columns)
  const added = files.reduce((sum, file) => sum + file.added, 0)
  const removed = files.reduce((sum, file) => sum + file.removed, 0)
  const totals = files.length === 0 ? '' : ` +${added} −${removed}`
  const header =
    files.length === 0 && notes.length === 0 ? (
      <Text color={colors.quiet}>{fit(emptyOf(view), width)}</Text>
    ) : (
      <Text>
        <Text color={colors.quiet}>{fit(summaryOf(view), width - cellsOf(totals))}</Text>
        {files.length > 0 && <Text color={colors.added}>{` +${added}`}</Text>}
        {files.length > 0 && <Text color={colors.removed}>{` −${removed}`}</Text>}
      </Text>
    )

  return (
    <Box flexDirection="column" width={width}>
      <Box flexShrink={0}>{header}</Box>
      <Box flexDirection="column" height={layout.window} overflow="hidden" flexShrink={0}>
        {bodyOf(view, layout, actions)}
      </Box>
      <Box flexShrink={0}>{footerOf(view, layout, actions)}</Box>
      {Array.from({ length: MARGIN_ROWS }, (_, i) => (
        <Text key={`margin:${i}`}> </Text>
      ))}
    </Box>
  )
}

// What the pane says with no files changed.
function emptyOf(view: PaneView): string {
  if (!view.watch.hasGit) {
    return 'No changes from Claude since your last review.'
  }
  return view.isLooking ? 'Looking at the folders Claude works in…' : `No changes since ${sinceOf(view)}.`
}

// The rows the window shows: from its first item until it is full, the
// open file's row first when it scrolled above. Lines of one hunk next to
// one another are drawn as one piece of code; the cursor's line is a piece
// of its own, beside its bar.
function bodyOf(view: PaneView, layout: Layout, actions: Actions): RenderElement[] {
  const drawn: RenderElement[] = []
  let filled = 0
  if (layout.sticky !== null) {
    drawn.push(itemOf(view, layout, layout.sticky, actions, true))
    filled += 1
  }
  let run: Extract<Item, { kind: 'code' }>[] = []
  const flush = () => {
    if (run.length > 0) {
      drawn.push(codeOf(view, run, false))
      run = []
    }
  }
  for (let i = layout.top; i < layout.items.length && filled < layout.window; i += 1) {
    const item = layout.items[i]
    if (item === undefined) {
      break
    }
    filled += item.rows
    if (item.kind === 'code' && item.key !== layout.cursor) {
      if (run.length > 0 && run[0]?.hunk !== item.hunk) {
        flush()
      }
      run.push(item)
      continue
    }
    flush()
    drawn.push(item.kind === 'code' ? codeOf(view, [item], true) : itemOf(view, layout, item, actions, false))
  }
  flush()
  return drawn
}

// The bar column every row starts with: the cursor's mark on its row,
// dimmed while the pane doesn't hold the keyboard.
function barOf(view: PaneView, isCursor: boolean): RenderElement {
  const { ui, colors } = view
  return isCursor ? (
    <ui.Text color={colors.cursor} dimColor={!view.isFocused}>
      ▌
    </ui.Text>
  ) : (
    <ui.Text> </ui.Text>
  )
}

// A piece of code: lines of one hunk, drawn as Claude Code's highlighted
// diff of the file, numbered where its first line stands.
function codeOf(view: PaneView, lines: readonly Extract<Item, { kind: 'code' }>[], isCursor: boolean): RenderElement {
  const { ui, place } = view
  const first = lines[0]
  if (first === undefined) {
    return <ui.Text> </ui.Text>
  }
  const piece: Hunk = {
    oldStart: first.old,
    oldLines: lines.filter(one => !one.line.startsWith('+')).length,
    newStart: first.new,
    newLines: lines.filter(one => !one.line.startsWith('-')).length,
    lines: lines.map(one => one.line),
  }
  // Cut lines only where the person asked for it, and never the cursor's.
  const wrap = place.isCompact && !isCursor ? 'truncate-end' : 'wrap'
  // A piece's gutter is as wide as its own numbers: one with fewer digits
  // than its hunk is moved over, so the numbers line up as the whole's
  // would. The room stays uncolored: Claude Code's diff colors are its
  // highlighter's, which no theme color matches.
  return (
    <ui.Box key={`code:${first.key}`} flexDirection="row" flexShrink={0}>
      {barOf(view, isCursor)}
      <ui.Box flexGrow={1} paddingLeft={first.digits - gutterDigits(piece)}>
        <ui.Code source={hunkText(piece)} format="diff" path={first.row.file.path} wrap={wrap} />
      </ui.Box>
    </ui.Box>
  )
}

// Every other item: a file's row, a hunk header, a note, the note field,
// prose, or a folder from earlier sessions.
function itemOf(view: PaneView, layout: Layout, item: Item, actions: Actions, isSticky: boolean): RenderElement {
  const { ui, colors, notes } = view
  const { Box, Text } = ui
  const width = Math.max(4, view.columns - 1)
  const isCursor = item.key === layout.cursor && !isSticky
  const row = (content: RenderElement) => (
    <Box key={`${isSticky ? 'sticky:' : ''}${item.key}`} flexDirection="row" flexShrink={0} {...(item.kind === 'file' ? { height: 1 } : {})}>
      {barOf(view, isCursor)}
      {content}
    </Box>
  )
  switch (item.kind) {
    case 'file': {
      const { file } = item
      const count = notes.filter(note => note.path === file.path).length
      const isOpen = view.place.open === file.path
      const at = layout.order.indexOf(file)
      const place = isOpen ? ` · ${at + 1}/${layout.order.length}` : ''
      const tail = `${factsOf(file)}${count > 0 ? ` ✎${count}` : ''}${place}`
      const lead = `${' '.repeat(item.indent)}${isOpen ? '▾ ' : ''}`
      // Viewed, the whole row is quiet and marked, its counts too.
      if (isViewed(view, file)) {
        const mark = `${lead}✓ `
        return row(
          <Text key={item.key} color={colors.quiet}>
            {`${mark}${fitStart(nameIn(file), width - cellsOf(tail) - cellsOf(mark) - 1)}${tail}`}
          </Text>,
        )
      }
      return row(
        <Text key={item.key}>
          {lead === '' ? '' : <Text color={colors.quiet}>{lead}</Text>}
          {nameOf(view, file, width - cellsOf(tail) - cellsOf(lead) - 1)}
          {countsOf(view, file)}
          {count > 0 ? <Text color={colors.note}>{` ✎${count}`}</Text> : ''}
          {place === '' ? '' : <Text color={colors.quiet}>{place}</Text>}
        </Text>,
      )
    }
    case 'root':
      return row(
        <Text key={item.key} bold>
          {fitStart(item.label, width - cellsOf(` · ${plural(item.count, 'file', 'files')}`))}
          <Text color={colors.quiet}>{` · ${plural(item.count, 'file', 'files')}`}</Text>
        </Text>,
      )
    case 'dir': {
      const facts = ` · ${plural(item.count, 'file', 'files')}`
      const mark = item.isClosed ? '▸ ' : ''
      return row(
        <Text key={item.key} color={colors.quiet}>
          {`${mark}${fitStart(`${item.dir}/`, width - cellsOf(facts) - cellsOf(mark))}${facts}`}
        </Text>,
      )
    }
    case 'hunk': {
      const lines = byFileOf(view.rows).get(item.row.file.path) ?? []
      const from = lines.indexOf(item.row)
      const end = lines.findIndex((one, i) => i > from && one.kind === 'hunk')
      const own = lines.slice(from + 1, end < 0 ? lines.length : end)
      const hasNote = (key: string) => notes.some(note => note.target === key)
      const count = own.filter(one => hasNote(one.key)).length + (hasNote(item.key) ? 1 : 0)
      return row(
        <Text key={item.key} color={colors.quiet}>
          {fit(`  ${hunkLabel(item.row, count)}`, width)}
        </Text>,
      )
    }
    case 'code':
      return codeOf(view, [item], isCursor)
    case 'note':
      return (
        <Box key={item.key} flexDirection="column" flexShrink={0}>
          {item.lines.map((line, i) => (
            <Text key={`${item.key}:${i}`} color={colors.note}>
              {`${' '.repeat(item.indent + 1)}${i === 0 ? '' : '  '}${line}`}
            </Text>
          ))}
        </Box>
      )
    case 'field':
      return fieldOf(view, item.row, actions)
    case 'text':
      return (
        <Box key={item.key} flexDirection="column" flexShrink={0}>
          {item.lines.map((line, i) => (
            <Text key={`${item.key}:${i}`} {...(item.tone === 'quiet' ? { color: colors.quiet } : {})}>
              {` ${line}`}
            </Text>
          ))}
        </Box>
      )
    case 'folder': {
      const facts = ` · ${plural(item.count, 'file', 'files')} · last used ${timeOf(item.usedAt, view.now)}`
      return row(<Text key={item.key} color={colors.quiet}>{`  ${fitStart(item.folder, width - cellsOf(facts) - 2)}${facts}`}</Text>)
    }
    default:
      return row(<Text> </Text>)
  }
}

// A file's name as its row shows it, under its folder's heading: its icon
// in its color and its name, cut from the start to `width`.
function nameOf(view: PaneView, file: FileDiff, width: number): (RenderElement | string)[] {
  const { ui, hasIcons } = view
  const icon = file.doc === null ? iconOf(file.path) : GOOGLE_DOC
  return [...(hasIcons ? [<ui.Text color={icon.color}>{`${icon.glyph} `}</ui.Text>] : []), fitStart(nameIn(file), width - (hasIcons ? 2 : 0))]
}

// What a file adds and removes, in the added and removed colors; "new" for
// a file created, "deleted" for one gone; and, for a file without lines,
// what it is.
function countsOf(view: PaneView, file: FileDiff): RenderElement[] {
  const { ui, colors } = view
  if (file.doc !== null) {
    return [<ui.Text color={colors.quiet}>{factsOf(file)}</ui.Text>]
  }
  const counts = file.isCreate
    ? [<ui.Text color={colors.added}> new</ui.Text>]
    : file.isDelete
      ? [<ui.Text color={colors.removed}> deleted</ui.Text>]
      : file.bare === null
        ? [<ui.Text color={colors.added}>{` +${file.added}`}</ui.Text>, <ui.Text color={colors.removed}>{` −${file.removed}`}</ui.Text>]
        : []
  return file.bare === null ? counts : [...counts, <ui.Text color={colors.quiet}>{` ${BARE[file.bare.why]}`}</ui.Text>]
}

// countsOf's text, for the room it takes.
function factsOf(file: FileDiff): string {
  if (file.doc !== null) {
    return ` Google Doc · ${plural(file.doc.length, 'edit', 'edits')}`
  }
  const counts = file.isCreate ? ' new' : file.isDelete ? ' deleted' : file.bare === null ? ` +${file.added} −${file.removed}` : ''
  return file.bare === null ? counts : `${counts} ${BARE[file.bare.why]}`
}

// The one-line note field, under its row: Enter saves, an empty note
// removes it, Esc cancels. On a line, it says which.
function fieldOf(view: PaneView, row: Row, actions: Actions): RenderElement {
  const { ui, Input, colors, notes } = view
  if (Input === undefined) {
    return <ui.Text color={colors.quiet}>{fit('  Notes need the terminal or the desktop app.', view.columns)}</ui.Text>
  }
  const was = notes.find(note => note.target === row.key)?.text ?? ''
  const label = row.kind === 'line' ? `✎ ${row.gutter}${row.sign === '-' ? ' (removed)' : ''}` : '✎'
  return (
    <ui.Box key={`field:${row.key}`} paddingLeft={2} flexShrink={0}>
      <Input
        key={FIELD}
        label={label}
        value={was}
        placeholder="Enter saves · empty removes · Esc cancels"
        submitLabel="save"
        autoFocus
        onSubmit={text => actions.save(row, text)}
      />
    </ui.Box>
  )
}

// The keys, pinned under the window: the button Enter presses, saying what
// it does on the cursor's row, then each key that works there. A key
// shows whenever it works, as a hotkey works only while its button is
// drawn; the row wraps rather than leave one out.
function footerOf(view: PaneView, layout: Layout, actions: Actions): RenderElement {
  const { ui, colors } = view
  if (view.editing !== null) {
    return <ui.Text color={colors.quiet}>{FIELD_HINT}</ui.Text>
  }
  return (
    <ui.Box flexDirection="row" flexWrap="wrap" columnGap={2}>
      {layout.keys.map(one =>
        one.hotkey === null ? (
          <ui.Button key={one.key} plain label={one.label} onPress={actions[one.act]} />
        ) : (
          <ui.Button key={one.key} plain hotkey={one.hotkey} label={one.label} onPress={actions[one.act]} />
        ),
      )}
    </ui.Box>
  )
}
