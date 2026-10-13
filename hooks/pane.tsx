// The pane, in two views redrawn in place: the files changed since the last
// review, and one file, each hunk drawn as Claude Code's own highlighted
// diff under a header. Picking a line puts a cursor column beside a hunk's
// code, which keeps its colors.

import type { ElementTable } from 'claude-code'
import type { Bare, DocEdit, FileDiff, Note, Watch } from '../types'
import { iconOf } from './icons'
import type { Row } from './review'
import { hunkText, splitHunk } from './review'

export type Ui = Pick<ElementTable, 'Box' | 'Text' | 'Button' | 'Code'>
export type InputElement = ElementTable<'terminal' | 'desktop'>['Input']

// The color options, each a theme role or a color (see paint.ts): the lines
// a file or hunk adds and removes, as counted; the notes; and the quiet text,
// folders and hints. The code itself takes Claude Code's own diff colors.
export type Colors = { added: string; removed: string; note: string; quiet: string }

// What drawing needs: the elements (an Input where the surface has one),
// the width, the colors, whether files show their icons, the files and all
// their rows, what difnote watches, whether it is looking, the time now,
// the notes, the file open (null for the list), the hunk being picked from,
// the row whose note field is open, and what the person's presses do.
export type PaneView = {
  ui: Ui
  Input?: InputElement | undefined
  columns: number
  colors: Colors
  hasIcons: boolean
  files: readonly FileDiff[]
  rows: readonly Row[]
  watch: Watch
  isLooking: boolean
  now: number
  notes: readonly Note[]
  file: string | null
  picking: string | null
  editing: string | null
  open: (path: string) => void
  back: () => void
  pick: (hunk: string) => void
  write: (row: Row) => void
  save: (row: Row, text: string) => void
  send: () => void
  move: (step: number) => void
  note: () => void
  reviewed: () => void
}

// The keys of the note field, which takes the focus ring when it opens, and
// of the rows that lead out of a file: back to the list, on to the next file.
export const FIELD = 'note-field'
export const BACK = 'back'
export const NEXT = 'next'

// The most of a file's hunks drawn as code, in characters, and of a hunk's
// lines the cursor column reaches: past them, the pane says how much it left
// out.
export const MOST_CODE = 60_000
export const MOST_LINES = 300

// Cut to `width` cells, an ellipsis marking the cut; tabs as two spaces.
// A code point is taken as one cell.
export function fit(text: string, width: number): string {
  // oxlint-disable-next-line typescript/no-misused-spread
  const chars = [...text.replaceAll('\t', '  ')]
  if (chars.length <= width) {
    return chars.join('')
  }

  return width <= 0 ? '' : `${chars.slice(0, width - 1).join('')}…`
}

// Cut from the start, for a path: its end is what tells files apart.
export function fitStart(text: string, width: number): string {
  // oxlint-disable-next-line typescript/no-misused-spread
  const chars = [...text]
  if (chars.length <= width) {
    return text
  }

  return width <= 0 ? '' : `…${chars.slice(chars.length - width + 1).join('')}`
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

// The line at the top of the list: what the pane covers and what it holds.
export function summaryOf(view: Pick<PaneView, 'files' | 'notes' | 'watch' | 'isLooking' | 'now'>): string {
  const { files, notes, isLooking } = view
  return [
    `since ${sinceOf(view)}`,
    plural(files.length, 'file', 'files'),
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

// How Claude edited a Google Doc, in the doc's view: whether it made it,
// how many edits of each kind, and that it is reviewed in Google Docs.
export function docWords(hows: readonly DocEdit['how'][]): string {
  const counts = (['suggest', 'direct', 'comment', 'review'] as const).flatMap(how => {
    const n = hows.filter(one => one === how).length
    return n === 0 ? [] : [`${n} ${n === 1 ? HOW[how][0] : HOW[how][1]}`]
  })
  const parts = [...(hows.includes('create') ? ['made by Claude'] : []), ...counts]
  return `In Google Docs: ${parts.join(', ')}. Review it there, where suggestions wait for you and version history keeps the rest:`
}

// What a file drawn without lines is, in the list.
const BARE: Record<Bare['why'], string> = {
  binary: 'binary',
  large: 'over 1 MiB',
  secret: 'secret',
  unreadable: 'unreadable',
  cut: 'too much at once',
}

// Why a file has no lines, and its sizes, in the file's view.
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

// The rows of one hunk: its changed lines and the context around them.
function linesOfHunk(own: readonly Row[], hunkKey: string): Row[] {
  const from = own.findIndex(row => row.key === hunkKey)
  const after = own.slice(from + 1)
  const end = after.findIndex(row => row.kind === 'hunk')
  return end < 0 ? after : after.slice(0, end)
}

// The rows j and k walk, in the order drawn: the files in the list; in a
// file, its title, its hunk headers (and the changed lines of the hunk being
// picked from) and the next file.
export function walkOf(view: Pick<PaneView, 'files' | 'rows' | 'file' | 'picking'>): string[] {
  if (view.file === null) {
    return view.files.map(file => `file:${file.path}`)
  }
  const own = view.rows.filter(row => row.file.path === view.file)
  const at = view.files.findIndex(file => file.path === view.file)
  const picked =
    view.picking === null
      ? []
      : linesOfHunk(own, view.picking)
          .slice(0, MOST_LINES)
          .filter(row => row.kind === 'line')

  return [
    ...own.flatMap(row =>
      row.kind === 'file' || row.kind === 'hunk' ? [row.key, ...(row.key === view.picking ? picked.map(line => line.key) : [])] : [],
    ),
    ...(at >= 0 && at < view.files.length - 1 ? [NEXT] : []),
  ]
}

export function paneOf(view: PaneView) {
  const { ui, columns, colors, files, watch } = view
  const { Box, Text } = ui
  const width = Math.max(1, columns)
  if (files.length === 0) {
    const empty = !watch.hasGit
      ? ['No changes from Claude since your last review.', "Without git, difnote sees only Claude's Edit and Write."]
      : view.isLooking
        ? ['Looking at the folders Claude works in…']
        : [`No changes since ${sinceOf(view)}.`]
    return (
      <Box flexDirection="column" width={width}>
        {empty.map(line => (
          <Text key={line} color={colors.quiet}>
            {fit(line, width)}
          </Text>
        ))}
        {/* Notes still waiting, on changes no longer there, can still go. */}
        {view.notes.length > 0 && goneOf(view, width)}
        {view.notes.length > 0 && keysOf(view, false)}
        {skippedOf(view, width)}
      </Box>
    )
  }

  const shown = files.find(file => file.path === view.file)
  return (
    <Box flexDirection="column" width={width}>
      {shown === undefined ? listOf(view, width) : fileOf(view, shown, width)}
      {keysOf(view, shown !== undefined)}
      {shown === undefined && goneOf(view, width)}
      {shown === undefined && skippedOf(view, width)}
    </Box>
  )
}

// The folders the session works in that difnote doesn't watch, and why; in
// them, only Claude's Edit and Write show.
function skippedOf(view: PaneView, width: number) {
  const { ui, colors, watch } = view
  if (watch.skipped.length === 0) {
    return null
  }
  return (
    <ui.Box flexDirection="column" marginTop={1}>
      <ui.Text color={colors.quiet} wrap="wrap">
        Not watched, so only Claude's Edit and Write show there:
      </ui.Text>
      {watch.skipped.map(({ folder, why }) => (
        <ui.Text key={`skipped:${folder}`} color={colors.quiet}>
          {fitStart(`  ${folder} (${why})`, width)}
        </ui.Text>
      ))}
    </ui.Box>
  )
}

// A file's name as a row shows it: its icon in its color, its folder quiet
// and its name in the text's own color, cut from the start to `width`.
function nameOf(view: PaneView, file: FileDiff, width: number) {
  const { ui, colors, hasIcons } = view
  const icon = file.doc === null ? iconOf(file.path) : GOOGLE_DOC
  const shown = fitStart(file.shown, width - (hasIcons ? 2 : 0))
  const slash = file.doc === null ? shown.lastIndexOf('/') : -1
  return [
    ...(hasIcons ? [<ui.Text color={icon.color}>{`${icon.glyph} `}</ui.Text>] : []),
    ...(slash < 0 ? [] : [<ui.Text color={colors.quiet}>{shown.slice(0, slash + 1)}</ui.Text>]),
    shown.slice(slash + 1),
  ]
}

// What a file adds and removes, in the added and removed colors; "new" for
// a file created, "deleted" for one gone; and, for a file without lines,
// what it is.
function countsOf(view: PaneView, file: FileDiff) {
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

// The list: one row per file, the one changed last first, with what it adds
// and removes and how many notes it has. Enter opens it; c notes the file.
function listOf(view: PaneView, width: number) {
  const { ui, colors, files, notes } = view
  const { Box, Button, Text } = ui
  const added = files.reduce((sum, file) => sum + file.added, 0)
  const removed = files.reduce((sum, file) => sum + file.removed, 0)
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={colors.quiet}>{fit(summaryOf(view), width - 14)}</Text>
        <Text color={colors.added}>{` +${added}`}</Text>
        <Text color={colors.removed}>{` −${removed}`}</Text>
      </Text>
      {files.map(file => {
        const key = `file:${file.path}`
        const count = notes.filter(note => note.path === file.path).length
        const facts = `${factsOf(file)}${count > 0 ? ` ✎${count}` : ''}`
        return (
          <Box key={`row:${key}`} flexDirection="column">
            <Button key={key} plain onPress={() => view.open(file.path)}>
              {nameOf(view, file, width - facts.length - 1)}
              {countsOf(view, file)}
              {count > 0 ? <Text color={colors.note}>{` ✎${count}`}</Text> : ''}
            </Button>
            {noteRow(view, key, width, '  ')}
          </Box>
        )
      })}
    </Box>
  )
}

// One file: the way back, its title (Enter or c notes the file), then each
// hunk under its header as highlighted code, its line notes after it; and the
// way on to the next file. Enter on a hunk header puts a cursor column beside
// its code to pick a line; again, takes it away.
function fileOf(view: PaneView, file: FileDiff, width: number) {
  const { ui, colors, files, rows, notes, picking, editing } = view
  const { Box, Button, Code, Text } = ui
  const own = rows.filter(row => row.file.path === file.path)
  const title = own.find(row => row.kind === 'file')
  const at = files.indexOf(file)
  const next = files[at + 1]
  let budget = MOST_CODE
  let left = 0

  const hunks = own.flatMap(row => {
    if (row.kind !== 'hunk') {
      return []
    }
    const lines = linesOfHunk(own, row.key)
    const hasNote = (key: string) => notes.some(note => note.target === key)
    const count = lines.filter(line => hasNote(line.key)).length + (hasNote(row.key) ? 1 : 0)
    const text = hunkText(row.hunk)
    if (text.length > budget) {
      left += 1
      return []
    }
    budget -= text.length
    const isPicking = row.key === picking
    // The code is cut after each line with a note, or with its note field
    // open, so the note sits right under its line.
    const after = new Set(lines.flatMap((line, i) => (line.kind === 'line' && (hasNote(line.key) || line.key === editing) ? [i] : [])))
    let offset = 0
    const pieces = splitHunk(row.hunk, after).map(piece => {
      const start = offset
      const rowsOfPiece = lines.slice(start, start + piece.lines.length)
      offset += piece.lines.length
      const last = rowsOfPiece.at(-1)
      return (
        <Box key={`piece:${row.key}:${start}`} flexDirection="column">
          <Box flexDirection="row">
            {isPicking && cursorColumn(view, rowsOfPiece, start)}
            <Box flexGrow={1}>
              {/* Long lines wrap, but beside the cursor column, which marks one row per line. */}
              <Code source={hunkText(piece)} format="diff" path={file.path} wrap={isPicking ? 'truncate-end' : 'wrap'} />
            </Box>
          </Box>
          {last?.kind === 'line' && noteRow(view, last.key, width, '    ')}
        </Box>
      )
    })
    return [
      <Box key={`row:${row.key}`} flexDirection="column" marginTop={1}>
        <Button key={row.key} plain onPress={() => view.pick(row.key)}>
          <Text color={colors.quiet}>{fit(hunkLabel(row, count), width)}</Text>
        </Button>
        {noteRow(view, row.key, width, '  ')}
        {pieces}
      </Box>,
    ]
  })

  return (
    <Box flexDirection="column">
      <Button key={BACK} plain hotkey="h" label={`back to ${plural(files.length, 'file', 'files')}`} onPress={view.back} />
      {title !== undefined && (
        <Box key={`row:${title.key}`} flexDirection="column" marginTop={1}>
          <Button key={title.key} plain onPress={() => view.write(title)}>
            {nameOf(view, file, width - factsOf(file).length - ` · ${at + 1}/${files.length}`.length)}
            {countsOf(view, file)}
            <Text color={colors.quiet}>{` · ${at + 1}/${files.length}`}</Text>
          </Button>
          {noteRow(view, title.key, width, '  ')}
        </Box>
      )}
      {file.bare !== null && (
        <Box marginTop={1}>
          <Text color={colors.quiet} wrap="wrap">
            {bareOf(file.bare)}
          </Text>
        </Box>
      )}
      {file.doc !== null && (
        <Box marginTop={1} flexDirection="column">
          <Text color={colors.quiet} wrap="wrap">
            {docWords(file.doc)}
          </Text>
          <Text wrap="wrap">{file.path}</Text>
        </Box>
      )}
      {hunks}
      {left > 0 && <Text color={colors.quiet}>{fit(`+${plural(left, 'more hunk', 'more hunks')}, too large to draw`, width)}</Text>}
      {next !== undefined && (
        <Box marginTop={1}>
          <Button key={NEXT} plain label={fit(`next: ${next.shown}`, width)} onPress={() => view.open(next.path)} />
        </Box>
      )}
    </Box>
  )
}

// Beside a piece of a hunk's code, one cell per line, `start` its first
// line's place in the hunk: a mark the cursor stops on for each changed line
// among the hunk's first MOST_LINES, ✎ where it has a note; nothing for
// context. Enter or c writes a note on the line.
function cursorColumn(view: PaneView, lines: readonly Row[], start: number) {
  const { ui, notes } = view
  const { Box, Button, Text } = ui
  return (
    <Box flexDirection="column" width={2}>
      {lines.map((row, i) =>
        row.kind === 'line' && start + i < MOST_LINES ? (
          <Button key={row.key} plain dimColor label={notes.some(note => note.target === row.key) ? '✎' : '›'} onPress={() => view.write(row)} />
        ) : (
          <Text key={`gap:${row.key}`}> </Text>
        ),
      )}
    </Box>
  )
}

// The note on a row, under it; its field instead while it is open.
function noteRow(view: PaneView, key: string, width: number, indent: string) {
  const { ui, colors, notes, editing, rows } = view
  if (editing === key) {
    const row = rows.find(one => one.key === key)
    return row === undefined ? null : fieldOf(view, row, width)
  }
  const note = notes.find(one => one.target === key)
  return note === undefined ? null : (
    <ui.Text key={`note:${key}`} color={colors.note} wrap="wrap">
      {`${indent}✎ ${note.text}`}
    </ui.Text>
  )
}

// The one-line note field: Enter saves, an empty note removes it, Esc
// cancels. On a line, it says which.
function fieldOf(view: PaneView, row: Row, width: number) {
  const { ui, Input, colors, notes } = view
  if (Input === undefined) {
    return <ui.Text color={colors.quiet}>{fit('  Notes need the terminal or the desktop app.', width)}</ui.Text>
  }
  const was = notes.find(note => note.target === row.key)?.text ?? ''
  const label = row.kind === 'line' ? `✎ ${row.at}${row.sign === '-' ? ' (removed)' : ''}` : '✎'
  return (
    <ui.Box key={`field:${row.key}`} paddingLeft={2}>
      <Input
        key={FIELD}
        label={label}
        value={was}
        placeholder="Enter saves · empty removes · Esc cancels"
        submitLabel="save"
        autoFocus
        onSubmit={text => view.save(row, text)}
      />
    </ui.Box>
  )
}

// The keys, last: j and k walk the rows, c notes the row the cursor is on,
// s puts the notes into the prompt box; with no notes, r marks everything
// shown reviewed.
function keysOf(view: PaneView, isFile: boolean) {
  const { ui, colors, notes } = view
  const { Box, Button, Text } = ui
  return (
    <Box flexDirection="row" flexWrap="wrap" columnGap={2} marginTop={1}>
      <Text color={colors.quiet}>{isFile ? '↵ pick a line · Esc back' : '↵ open · Esc close'}</Text>
      <Button key="key-next" plain hotkey="j" label="next" onPress={() => view.move(1)} />
      <Button key="key-previous" plain hotkey="k" label="previous" onPress={() => view.move(-1)} />
      <Button key="key-note" plain hotkey="c" label="note" onPress={view.note} />
      {notes.length > 0 && <Button key="send" plain hotkey="s" label={`send ${plural(notes.length, 'note', 'notes')}`} onPress={view.send} />}
      {notes.length === 0 && <Button key="key-reviewed" plain hotkey="r" label="mark all reviewed" onPress={view.reviewed} />}
    </Box>
  )
}

// Notes whose row is gone, as what they were on changed since.
function goneOf(view: PaneView, width: number) {
  const { ui, colors, notes, rows } = view
  const keys = new Set(rows.map(row => row.key))
  const gone = notes.filter(note => !keys.has(note.target))
  if (gone.length === 0) {
    return null
  }
  return (
    <ui.Box flexDirection="column" marginTop={1}>
      <ui.Text color={colors.quiet}>{fit('Notes on lines changed since:', width)}</ui.Text>
      {gone.map(note => (
        <ui.Text key={`gone:${note.target}`} color={colors.note} wrap="wrap">
          {`  ✎ ${note.anchor} · ${note.text}`}
        </ui.Text>
      ))}
    </ui.Box>
  )
}
