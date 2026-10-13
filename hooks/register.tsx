// difnote lists what changed in the folders Claude works in since you last
// reviewed, one diff per file, lets you write a note on a line, a hunk or a
// file, and puts the notes into the prompt box for you to edit and send.

import type { EngineInterface, Register, Timer } from 'claude-code'
import { atom, read, update } from 'claude-code'
import type { Change, FileDiff, Note, Place, Watch } from '../types'
import type { Places } from './folders'
import { isInside, parentOf, pathsIn, placesOf, refusalOf, slugOf } from './folders'
import type { Entry } from './git'
import {
  ENV,
  MOST_FILES,
  MOST_KEPT,
  blobsOf,
  configOf,
  entriesOf,
  envOf,
  excludeOf,
  fileOf,
  gitdirOf,
  isSecret,
  placeholderOf,
  repoEnvOf,
  sizesOf,
  sizesWanted,
  under,
} from './git'
import { colorOf } from './paint'
import { ENTER, FIELD, FOLDER, groupsOf, layoutOf, paneOf } from './pane'
import type { Actions, Colors, Item, Layout, PaneView } from './pane'
import { anchorOf, changeOf, docOf, filesOf, fingerprintOf, isRecord, promptOf, rowsOf, titleOf } from './review'
import type { Row } from './review'

const NAME = 'difnote'
const PANE = 'difnote'

const diffs = atom({ plugin: 'difnote', key: 'diffs' } as const, [])
const watch = atom({ plugin: 'difnote', key: 'watch' } as const, {
  hasGit: false,
  since: null,
  looking: [],
  skipped: [],
  slow: [],
  carried: [],
  lost: [],
  roots: [],
  home: null,
})
const changes = atom({ plugin: 'difnote', key: 'changes' } as const, [])
const notes = atom({ plugin: 'difnote', key: 'notes' } as const, [])
const editing = atom({ plugin: 'difnote', key: 'editing' } as const, null)
const place = atom({ plugin: 'difnote', key: 'place' } as const, { open: null, cursor: null, top: 0, isCompact: false, closed: [] })
const viewed = atom({ plugin: 'difnote', key: 'viewed' } as const, {})

// The room the pane asks for: columns docked beside the transcript, rows
// seated above the prompt.
const DOCK_COLUMNS = 100
const INLINE_ROWS = 30

// Where each session's last review of Claude's Edit and Write records ended:
// the id of the newest change it covered, by session id, for the sessions
// reviewed last.
const BASELINES = 'baselines'
const KEPT_BASELINES = 100

// The notes not yet in the prompt box, kept through /clear and restarts,
// by the folder of the session they were written in: a session in another
// folder has its own.
const NOTES = 'notes'

// The files marked viewed, kept like the notes: by the session's folder.
const VIEWED = 'viewed'

// How long Claude's change waits for difnote to record a folder it hasn't
// recorded before; and how old a look may be when a key is pressed in the
// pane, as one back from behind another, before it looks again.
const WAIT_MS = 5_000
const STALE_MS = 2_000

// An open pane looks again by itself, for changes no hook sees (yours, a
// script's, another session's), POLL_MS after its last look ended, or PACE
// times as long as that look took, if longer. A folder whose look took over
// SLOW_MS SLOW_TIMES times is left to the looks Claude's changes and your
// keys make.
const POLL_MS = 10_000
const PACE = 20
const SLOW_MS = 3_000
const SLOW_TIMES = 2

// The answer to r's question that marks everything shown reviewed.
const SURE = 'Mark reviewed'

// The session's folder, which paths are written relative to; what the pane
// has shown since the review began (the newest Edit or Write record, and
// each folder's state); the last look and whether one is under way; the
// rows j and k walk as last drawn (a render can't write state, so they are
// kept here); and the element the focus ring is on.
let cwd = ''
let shownUpTo: string | null = null
let shownTrees = new Map<string, string>()
let looked: Looked | null = null
let lookedAt = 0
let ignored: ReadonlySet<string> = new Set()
// The files Claude changed before difnote had their folder's record.
let early: ReadonlySet<string> = new Set()
// The titles of the Google Docs Claude read, by link.
let titles: ReadonlyMap<string, string> = new Map()
let isLooking = false
let isAgain = false
// Whether the pane is open; the look by itself it waits for; whether one
// waited while a note was being written; and how long the last look took.
let isOpen = false
let timer: Timer | null = null
let isHeld = false
let lastLookMs = 0
// How many reviews ended, or folders were let go of with x, this session,
// so a look under way when one does knows its result is out of date.
let reviews = 0
// The list as last drawn: the keys and the wheel move the cursor over it.
let layout: Layout | null = null

// The changes to keep: each file's after-text only on its latest change,
// the one the diff reads it from.
function kept(list: readonly Change[]): Change[] {
  const later = new Set<string>()
  return list
    .toReversed()
    .map(change => {
      const isLatest = !later.has(change.path)
      later.add(change.path)
      return isLatest ? change : { ...change, after: null }
    })
    .toReversed()
}

// The files as the pane lists them: those of the watched folders, then those
// Claude changed elsewhere, or that a watched folder ignores, by its Edit and
// Write records. Worked out again only when one of them changes: a redraw
// for a key or a note costs no diff.
let listed: {
  diffs: readonly FileDiff[] | null
  changes: readonly Change[] | null
  ignored: ReadonlySet<string>
  early: ReadonlySet<string>
  titles: ReadonlyMap<string, string>
  files: FileDiff[]
} = { diffs: null, changes: null, ignored, early, titles, files: [] }
function listedFiles(found: readonly FileDiff[], list: readonly Change[]): FileDiff[] {
  if (listed.diffs !== found || listed.changes !== list || listed.ignored !== ignored || listed.early !== early || listed.titles !== titles) {
    const records = filesOf(
      list.filter(change => !isWatched(change.path) || ignored.has(change.path) || early.has(change.path)),
      cwd,
      titles,
    )
    const byRecord = new Set(records.map(one => one.path))
    listed = { diffs: found, changes: list, ignored, early, titles, files: [...found.filter(one => !byRecord.has(one.path)), ...records] }
  }
  return listed.files
}

async function filesNow($: EngineInterface): Promise<FileDiff[]> {
  return listedFiles(await read($, diffs), await read($, changes))
}

// The rows of the files listed, worked out again only when they change: a
// key that moves the cursor redraws without them.
let rowsFor: { files: readonly FileDiff[] | null; rows: Row[] } = { files: null, rows: [] }
function rowsOfFiles(files: readonly FileDiff[]): Row[] {
  if (rowsFor.files !== files) {
    rowsFor = { files, rows: rowsOf(files) }
  }
  return rowsFor.rows
}

// Claude's changes since the last review, from the conversation as Claude
// Code stored it: at the start, and after /clear, /resume or /branch.
async function readChanges($: EngineInterface) {
  const baselines = await $.store.get(BASELINES).catch(() => undefined)
  const ends = new Set(Object.values(isRecord(baselines) ? baselines : {}).filter(id => typeof id === 'string'))
  const messages = await $.session.messages().catch(() => [])
  const uses = messages.flatMap(message => (message.role === 'assistant' ? message.toolUses : []))
  for (const use of uses) {
    learnTitle(use.tool, use.result)
  }
  const all = uses.flatMap(use => {
    const change =
      use.isError === true
        ? null
        : (changeOf(use.tool_use_id, use.tool, use.result) ?? docOf(use.tool_use_id, use.tool, use.input, use.result, titles))
    return change === null ? [] : [change]
  })
  // Where a review in this conversation ended: under this session's id, or,
  // after /branch, the session it branched from. Tool-use ids are unique,
  // so any stored end found here is this conversation's.
  const from = all.findLastIndex(change => ends.has(change.id)) + 1
  await update($, changes, () => kept(all.slice(from)))
}

function learnTitle(tool: string, result: unknown) {
  const found = titleOf(tool, result)
  if (found !== null && titles.get(found[0]) !== found[1]) {
    titles = new Map([...titles, found])
  }
}

// The notes not yet sent, as the store keeps them.
async function readNotes($: EngineInterface) {
  const stored = await $.store.get(NOTES).catch(() => undefined)
  const own = isRecord(stored) ? stored[cwd] : undefined
  await update($, notes, () => (Array.isArray(own) ? own.filter(isNote) : []))
}

function isNote(value: unknown): value is Note {
  return (
    isRecord(value) &&
    typeof value.target === 'string' &&
    typeof value.path === 'string' &&
    typeof value.anchor === 'string' &&
    Array.isArray(value.quote) &&
    value.quote.every(line => typeof line === 'string') &&
    typeof value.text === 'string'
  )
}

// The files marked viewed, as the store keeps them.
async function readViewed($: EngineInterface) {
  const stored = await $.store.get(VIEWED).catch(() => undefined)
  const own = isRecord(stored) ? stored[cwd] : undefined
  const marks = isRecord(own) ? Object.entries(own).filter((entry): entry is [string, string] => typeof entry[1] === 'string') : []
  await update($, viewed, () => Object.fromEntries(marks))
}

// Sets the files marked viewed, in the pane and in the store.
async function setViewed($: EngineInterface, marks: Record<string, string>) {
  await update($, viewed, () => marks)
  const stored = await $.store.get(VIEWED).catch(() => undefined)
  const others = Object.entries(isRecord(stored) ? stored : {}).filter(([folder]) => folder !== cwd)
  const isEmpty = Object.keys(marks).length === 0
  await $.store.set(VIEWED, Object.fromEntries([...others, ...(isEmpty ? [] : [[cwd, marks] as const])])).catch(() => undefined)
}

// Changes the notes, in the pane and in the store.
async function setNotes($: EngineInterface, change: (list: Note[]) => Note[]) {
  let now: Note[] = []
  await update($, notes, list => {
    now = change(list)
    return now
  })
  const stored = await $.store.get(NOTES).catch(() => undefined)
  const others = Object.entries(isRecord(stored) ? stored : {}).filter(([folder]) => folder !== cwd)
  await $.store.set(NOTES, Object.fromEntries([...others, ...(now.length === 0 ? [] : [[cwd, now] as const])])).catch(() => undefined)
}

// Looks at the watched folders again; a look asked for while one is under
// way runs after it. A look by itself (`isTimer`) records only the folders
// git says changed, and redraws only when one did. The next look by itself
// is set from when this one ends.
async function refresh($: EngineInterface, isTimer = false) {
  if (isLooking) {
    isAgain = true
    return
  }
  isLooking = true
  const from = reviews
  const startedAt = await $.clock.now()
  let now: Looked
  let ignoring: ReadonlySet<string>
  try {
    const paths = (await read($, changes)).map(change => change.path)
    ;[now, ignoring] = await Promise.all([look($, isTimer), isTimer ? ignored : ignoredOf($, paths)])
  } finally {
    isLooking = false
  }
  lookedAt = await $.clock.now()
  lastLookMs = lookedAt - startedAt
  // A review that ended during the look made it out of date, states the
  // pane never showed: it is dropped, and the look made again.
  if (reviews !== from) {
    isAgain = false
    await refresh($)
    return
  }
  const isSame = looked !== null && isSameLook(looked, now)
  looked = now
  ignored = ignoring
  if (!isSame) {
    const hadFiles = (await filesNow($)).length > 0
    await update($, diffs, () => filesOfLook(now))
    await parkWhenListed($, hadFiles)
  }
  const said = watchOf()
  if (JSON.stringify(said) !== JSON.stringify(await read($, watch))) {
    await update($, watch, () => said)
  }
  if (isAgain) {
    isAgain = false
    await refresh($)
    return
  }
  schedule($)
}

// Whether a look found each folder as the last did.
function isSameLook(was: Looked, now: Looked): boolean {
  return (
    was.files.size === now.files.size &&
    [...now.files].every(([folder, files]) => was.files.get(folder) === files) &&
    was.failed.length === now.failed.length &&
    now.failed.every((one, i) => was.failed[i]?.folder === one.folder && was.failed[i]?.why === one.why)
  )
}

// Sets the open pane's next look by itself, in place of any set before.
function schedule($: EngineInterface) {
  timer?.cancel()
  timer = isOpen ? $.clock.after(Math.max(POLL_MS, PACE * lastLookMs), () => void tick($).catch(() => undefined)) : null
}

// The look by itself: none while one is under way (it sets the next); while
// the pane is behind another tab, or a note is being written, the next is
// set instead; a closed pane's ends.
async function tick($: EngineInterface) {
  timer = null
  if (!isOpen || isLooking) {
    return
  }
  if (!(await isShown($))) {
    schedule($)
  } else if ((await read($, editing)) !== null) {
    isHeld = true
    schedule($)
  } else {
    // A look that failed sets no next one: set here, the looks go on.
    await refresh($, true).finally(() => {
      if (timer === null) {
        schedule($)
      }
    })
  }
}

// Closes the note field; a look by itself held while it was open is made.
async function closeField($: EngineInterface) {
  await update($, editing, () => null)
  if (isHeld) {
    isHeld = false
    if (isOpen) {
      void refresh($, true).catch(() => undefined)
    }
  }
}

// The pane opened or closed: its looks by themselves start or stop.
function setOpen($: EngineInterface, open: boolean) {
  isOpen = open
  if (!open) {
    isHeld = false
  }
  schedule($)
}

async function isShown($: EngineInterface): Promise<boolean> {
  const pane = (await $.ui.panes().catch(() => [])).find(one => one.id === PANE)
  return pane?.isShown === true
}

// Ends the review of Claude's Edit and Write records the pane showed: the
// changes it covered leave the list, and where it ended is kept for a later
// /resume.
async function endReview($: EngineInterface, upTo: string) {
  let isEnded = false
  await update($, changes, list => {
    const at = list.findIndex(change => change.id === upTo)
    isEnded = at >= 0
    return at < 0 ? list : list.slice(at + 1)
  })
  const sessionId = await $.session.id().catch(() => null)
  if (!isEnded || sessionId === null) {
    return
  }
  const was = await $.store.get(BASELINES).catch(() => undefined)
  const others = Object.entries(isRecord(was) ? was : {}).filter(([id]) => id !== sessionId)
  await $.store.set(BASELINES, Object.fromEntries([...others.slice(-(KEPT_BASELINES - 1)), [sessionId, upTo]])).catch(() => undefined)
}

// Marks what the pane showed reviewed: each folder as it was shown, and
// Claude's records up to the newest shown; or what it showed when r was
// pressed (`shown`). What changed since stays.
async function markReviewed(
  $: EngineInterface,
  shown: { upTo: string | null; trees: ReadonlyMap<string, string> } = { upTo: shownUpTo, trees: shownTrees },
) {
  const { upTo, trees } = shown
  reviews += 1
  shownUpTo = null
  shownTrees = new Map()
  early = new Set()
  if (trees.size > 0) {
    // Only folders whose reviewed state moved leave the list: one git
    // couldn't move shows its changes until the next review.
    const done = await reviewed($, trees)
    await update($, diffs, list => list.filter(one => !done.some(folder => isInside(one.path, folder))))
    await update($, watch, () => watchOf())
  }
  if (upTo !== null) {
    await endReview($, upTo)
  }
  // What was marked viewed is reviewed now.
  await setViewed($, {})
  if (await isShown($)) {
    void refresh($).catch(() => undefined)
  }
}

// r: asks first, as a review can't be undone; the keyboard goes back to
// the pane after.
async function confirmReviewed($: EngineInterface) {
  // What the question is about: what the pane shows now, not what it may
  // show by the answer.
  const shown = { upTo: shownUpTo, trees: shownTrees }
  const count = (await filesNow($)).length
  const question = count === 1 ? 'Mark the 1 file shown reviewed?' : `Mark all ${count} files shown reviewed?`
  const answer = await $.ui.ask(question, { options: [SURE, 'Cancel'], header: 'difnote' }).catch(() => '')
  await openPane($).catch(() => undefined)
  if (answer === SURE) {
    await markReviewed($, shown)
  }
}

// x: the outside folder the cursor is on, else the only one carried from
// earlier sessions, no longer watched from here. Its changes leave the pane
// and this review, unreviewed, and later sessions here leave it out until
// Claude changes it again; a session in the folder itself still shows them.
async function dropFolder($: EngineInterface) {
  const list = (await read($, watch)).carried.map(one => one.folder)
  const at = layout?.cursor ?? null
  const target = at?.startsWith(FOLDER) === true ? at.slice(FOLDER.length) : list.length === 1 ? list[0] : undefined
  if (target === undefined || !carried.has(target)) {
    $.ui.toast('Move to a folder under "From earlier sessions here" first.')
    return
  }
  const gone = new Set([...active].filter(folder => isInside(folder, target) && isOutside(folder)))
  // A look under way still holds the folder: it is made again without it.
  reviews += 1
  for (const folder of gone) {
    active.delete(folder)
    carried.delete(folder)
    quiet.delete(folder)
    const one = times[folder]
    if (one !== undefined) {
      times[folder] = { ...one, from: one.from.filter(from => from !== cwd) }
    }
  }
  await saveTimes($)
  const keep = <T,>(map: ReadonlyMap<string, T>) => new Map([...map].filter(([folder]) => !gone.has(folder)))
  shownTrees = keep(shownTrees)
  if (looked !== null) {
    const now: Looked = { ...looked, trees: keep(looked.trees), files: keep(looked.files) }
    looked = now
    await update($, diffs, () => filesOfLook(now))
  }
  await update($, watch, () => watchOf())
  await park($)
}

// Puts the notes into the prompt box after what is there, a blank line
// between, and lets them go once the box holds them. Under a dialog the box
// takes nothing, and the notes stay.
async function sendNotes($: EngineInterface, rows: readonly Row[]) {
  const list = await read($, notes)
  if (list.length === 0) {
    return
  }
  // The files the notes are on, as they are now, so each note points where
  // its line stands; a file that can't be read keeps the numbers it had.
  const paths = [...new Set(list.map(note => note.path))]
  const reads = await Promise.all(paths.map(async path => [path, await $.fs.read(path).catch(() => null)] as const))
  const files = new Map(reads.flatMap(([path, text]) => (typeof text === 'string' ? [[path, text] as const] : [])))
  const draft = await $.prompt.read()
  const text = `${draft.text.trim() === '' ? '' : '\n\n'}${promptOf(list, rows, files)}`
  // oxlint-disable-next-line unicorn/no-array-fill-with-reference-type -- the prompt box's fill, not an array's
  const filled = await $.prompt.fill({ text, mode: 'append' })
  if (filled.isFilled) {
    await setNotes($, () => [])
  } else {
    $.ui.toast("The prompt box can't take the notes right now; they are kept.")
  }
}

// Writes, rewrites or, empty, removes the note on a row; the focus goes back
// to the row.
async function saveNote($: EngineInterface, row: Row, text: string) {
  const words = text.trim()
  const { anchor, quote } = anchorOf(row)
  const note: Note = { target: row.key, path: row.file.path, anchor, quote, text: words }
  await setNotes($, list => {
    const others = list.filter(one => one.target !== row.key)
    if (words === '') {
      return others
    }
    const at = list.findIndex(one => one.target === row.key)
    return at < 0 ? [...list, note] : list.map(one => (one.target === row.key ? note : one))
  })
  await closeField($)
  await park($)
}

// /difnote gives the pane the keyboard, opening it, bringing it to the
// front of the dock or taking the keyboard back from the prompt, and looks
// again. Esc closes the pane (see stepBack).
async function showPane($: EngineInterface) {
  await openPane($)
  setOpen($, true)
  void refresh($).catch(() => undefined)
}

async function openField($: EngineInterface, row: Row) {
  await update($, editing, () => row.key)
  await $.ui.focus({ requestId: PANE, key: FIELD }).catch(() => undefined)
}

// Opens the pane with the keyboard, on the button Enter presses, or on a
// note field left open: none is drawn for Enter while one is, and a park
// would wait for it, the keyboard at the prompt meanwhile. Esc steps back
// (see stepBack). Docked, the pane asks for room for code; a width the
// person set the dock to wins.
async function openPane($: EngineInterface) {
  await $.ui.open({ id: PANE, title: 'difnote', focus: true, closeOnEscape: true, columns: DOCK_COLUMNS, rows: INLINE_ROWS })
  if ((await read($, editing)) !== null) {
    await $.ui.focus({ requestId: PANE, key: FIELD }).catch(() => undefined)
  } else {
    await park($)
  }
}

// Puts Claude Code's focus ring on the button Enter presses, where it stays
// while difnote moves its own cursor: a ring on rows that come and go would
// be kept at its place among them, not on its row.
async function park($: EngineInterface) {
  await $.ui.focus({ requestId: PANE, key: ENTER }).catch(() => undefined)
}

// An empty pane draws no button for Enter, so a park found nothing to put
// the ring on: once files show, the ring goes onto the button, if the pane
// has the keyboard (a park never takes it from the prompt).
async function parkWhenListed($: EngineInterface, hadFiles: boolean) {
  if (hadFiles || (await filesNow($)).length === 0) {
    return
  }
  const pane = (await $.ui.panes().catch(() => [])).find(one => one.id === PANE)
  if (pane?.isFocused === true) {
    await park($)
  }
}

// Esc, the close mark or another plugin's close while the pane is open: one
// step back, the way /diff's dialog goes. A note field closes, leaving the
// note as it was; an open file closes, the cursor on its row. Only then does
// the pane close.
async function stepBack($: EngineInterface) {
  if ((await read($, editing)) !== null) {
    await closeField($)
    await park($)
    return
  }
  const { open } = await read($, place)
  if (open !== null) {
    await moveTo($, `file:${open}`, { open: null })
  }
}

// Whether there is a step to take back before the pane closes.
async function hasStep($: EngineInterface): Promise<boolean> {
  return (await read($, editing)) !== null || (await read($, place)).open !== null
}

// Closed, the pane forgets the file it had open, its cursor and an open note
// field: opened again, it starts at the top of the list.
async function forget($: EngineInterface) {
  await closeField($)
  await update($, place, was => ({ ...was, open: null, cursor: null, top: 0 }))
}

// Puts the cursor on a row, with other changes to where the person is; the
// window keeps showing what it showed, moved only as far as the cursor needs.
async function moveTo($: EngineInterface, key: string | null, change: Partial<Place> = {}) {
  const top = layout?.top ?? 0
  await update($, place, was => ({ ...was, top, ...change, cursor: key }))
  await park($)
}

// The item a key names in the list as last drawn.
function itemOf(key: string | null): Item | undefined {
  return key === null ? undefined : layout?.items.find(item => item.key === key)
}

// The stop `step` stops from the cursor, held at the ends; from none, the
// first or the last.
function stopFrom(step: number): string | null {
  const stops = layout?.stops ?? []
  if (stops.length === 0) {
    return null
  }
  const at = layout?.cursor === null || layout === null ? -1 : stops.indexOf(layout.cursor)
  const to = at < 0 ? (step > 0 ? 0 : stops.length - 1) : Math.min(stops.length - 1, Math.max(0, at + step))
  return stops[to] ?? null
}

// The key of the folder heading a file is listed under, if any.
async function headingOf(path: string, $: EngineInterface): Promise<string | null> {
  const groups = groupsOf(await filesNow($), await read($, watch))
  for (const group of groups) {
    for (const dir of group.dirs) {
      if (dir.dir !== '' && dir.files.some(one => one.path === path)) {
        return dir.key
      }
    }
  }
  return null
}

// Opens a file under its row, closing the one open; its folder opens if
// folded. The cursor goes to its first changed line, else its row.
async function openAt($: EngineInterface, path: string) {
  await closeField($)
  const rows = rowsOfFiles(await filesNow($))
  const first = rows.find(row => row.file.path === path && row.kind === 'line') ?? rows.find(row => row.file.path === path && row.kind === 'hunk')
  const dir = await headingOf(path, $)
  const { closed } = await read($, place)
  await moveTo($, first?.key ?? `file:${path}`, { open: path, closed: closed.filter(one => one !== dir) })
}

// Enter, on the button the ring stays on: what the cursor's row offers. A
// file opens or closes; a folder heading folds or unfolds its files; a
// folder from earlier sessions opens its newest file; a hunk or a line
// takes a note.
async function act($: EngineInterface) {
  const item = itemOf(layout?.cursor ?? null)
  const was = await read($, place)
  if (item?.kind === 'file') {
    await (was.open === item.file.path ? moveTo($, item.key, { open: null }) : openAt($, item.file.path))
  } else if (item?.kind === 'dir') {
    await toggleDir($, item)
  } else if (item?.kind === 'folder') {
    const newest = (await filesNow($)).filter(one => isInside(one.path, item.folder)).toSorted((x, y) => y.changedAt - x.changedAt)[0]
    if (newest !== undefined) {
      await openAt($, newest.path)
    }
  } else if (item?.kind === 'hunk' || item?.kind === 'code') {
    await noteOn($, item.key)
  }
}

// Folds a folder's files away, closing the file open in it; or unfolds them.
async function toggleDir($: EngineInterface, item: Extract<Item, { kind: 'dir' }>) {
  const was = await read($, place)
  const isClosing = !was.closed.includes(item.key)
  const isOpenInside = isClosing && was.open !== null && (await headingOf(was.open, $)) === item.key
  await moveTo($, item.key, {
    closed: isClosing ? [...was.closed, item.key] : was.closed.filter(one => one !== item.key),
    ...(isOpenInside ? { open: null } : {}),
  })
}

// h: out one level. From inside the open file, close it, the cursor on its
// row; on the open file's row, close it; on a file in a folder, to the
// folder's heading; on an unfolded heading, fold it.
async function goOut($: EngineInterface) {
  const item = itemOf(layout?.cursor ?? null)
  const was = await read($, place)
  if ((item?.kind === 'hunk' || item?.kind === 'code') && was.open !== null) {
    await moveTo($, `file:${was.open}`, { open: null })
  } else if (item?.kind === 'file' && was.open === item.file.path) {
    await moveTo($, item.key, { open: null })
  } else if (item?.kind === 'file' && item.indent > 0) {
    await moveTo($, await headingOf(item.file.path, $))
  } else if (item?.kind === 'dir' && !item.isClosed) {
    await toggleDir($, item)
  }
}

// l: in one level. A file opens; on the open file's row, to its first
// changed line; on a hunk header, to its first changed line; a folded
// heading unfolds.
async function goIn($: EngineInterface) {
  const item = itemOf(layout?.cursor ?? null)
  const was = await read($, place)
  if (item?.kind === 'file' && was.open !== item.file.path) {
    await openAt($, item.file.path)
  } else if (item?.kind === 'file') {
    const first = rowsOfFiles(await filesNow($)).find(row => row.file.path === item.file.path && row.kind === 'line')
    await moveTo($, first?.key ?? item.key)
  } else if (item?.kind === 'hunk') {
    const own = rowsOfFiles(await filesNow($))
    const at = own.findIndex(row => row.key === item.key)
    const first = own.slice(at + 1).find(row => row.kind === 'line' || row.kind === 'hunk')
    await moveTo($, first?.kind === 'line' ? first.key : item.key)
  } else if (item?.kind === 'dir' && item.isClosed) {
    await toggleDir($, item)
  }
}

// n: the next file in the list opens, the one open closing; the last stays.
async function nextFile($: EngineInterface) {
  const order = layout?.order ?? []
  const { open } = await read($, place)
  const item = itemOf(layout?.cursor ?? null)
  const from = open ?? (item?.kind === 'file' ? item.file.path : null)
  const at = order.findIndex(one => one.path === from)
  const next = order[at + 1]
  if (next !== undefined) {
    await openAt($, next.path)
  }
}

// v: the cursor's file marked viewed, or no longer: its row dims, and the
// mark drops by itself once its change changes. Marked, an open file
// closes and the cursor goes on to the next file not yet viewed.
async function toggleViewed($: EngineInterface) {
  const item = itemOf(layout?.cursor ?? null)
  const was = await read($, place)
  const path = item?.kind === 'file' ? item.file.path : item?.kind === 'hunk' || item?.kind === 'code' ? was.open : null
  const file = (await filesNow($)).find(one => one.path === path)
  if (file === undefined) {
    return
  }
  const marks = await read($, viewed)
  const print = fingerprintOf(file)
  if (marks[file.path] === print) {
    await setViewed($, Object.fromEntries(Object.entries(marks).filter(([one]) => one !== file.path)))
    await moveTo($, `file:${file.path}`)
    return
  }
  await setViewed($, { ...marks, [file.path]: print })
  const order = layout?.order ?? []
  const at = order.findIndex(one => one.path === file.path)
  const next = order.slice(at + 1).find(one => marks[one.path] !== fingerprintOf(one))
  const dir = next === undefined ? null : await headingOf(next.path, $)
  await moveTo($, `file:${(next ?? file).path}`, {
    ...(was.open === file.path ? { open: null } : {}),
    closed: was.closed.filter(one => one !== dir),
  })
}

// w: lines other than the cursor's cut to one row, or wrapped again.
async function toggleWrap($: EngineInterface) {
  const was = await read($, place)
  await moveTo($, layout?.cursor ?? was.cursor, { isCompact: !was.isCompact })
}

// c: a note on the row the cursor is on: a file, a hunk or a changed line.
async function noteOn($: EngineInterface, key: string | null) {
  const row = rowsOfFiles(await filesNow($)).find(one => one.key === key)
  if (row !== undefined) {
    await openField($, row)
  }
}

// The person's wheel, arrows, page keys, Home and End over the pane, which
// difnote scrolls itself. The wheel moves the window three rows a tick and
// takes the cursor along when it would leave it; an arrow moves the cursor
// a stop, a page key about a window, Home and End to the first or last.
async function scrolled($: EngineInterface, by: number, isWheel: boolean, contentRows: number) {
  if (layout === null || by === 0) {
    return
  }
  const { items, stops, window } = layout
  const step = Math.sign(by)
  if (isWheel) {
    let top = layout.top
    for (let rows = 0; rows < 3 * Math.abs(by);) {
      const next = top + step
      if (next < 0 || next >= items.length) {
        break
      }
      rows += (step > 0 ? items[top] : items[next])?.rows ?? 1
      top = next
    }
    const shown: string[] = []
    for (let i = top, rows = 0; i < items.length && rows < window; i += 1) {
      const item = items[i]
      if (item !== undefined) {
        rows += item.rows
        if (stops.includes(item.key)) {
          shown.push(item.key)
        }
      }
    }
    const cursor = layout.cursor !== null && shown.includes(layout.cursor) ? layout.cursor : step > 0 ? shown[0] : shown.at(-1)
    await update($, place, was => ({ ...was, top, cursor: cursor ?? was.cursor }))
    await park($)
    return
  }
  if (Math.abs(by) === 1) {
    await moveTo($, stopFrom(step))
  } else if (Math.abs(by) >= contentRows) {
    await moveTo($, (step > 0 ? stops.at(-1) : stops[0]) ?? null)
  } else {
    const at = items.findIndex(item => item.key === layout?.cursor)
    let i = Math.max(0, at)
    for (let rows = 0; rows < window - 2 && i + step >= 0 && i + step < items.length;) {
      i += step
      rows += items[i]?.rows ?? 1
    }
    while (i >= 0 && i < items.length && !stops.includes(items[i]?.key ?? '')) {
      i -= step
    }
    await moveTo($, items[i]?.key ?? stopFrom(step))
  }
}

// What the pane's keys and its note field do.
function actionsOf($: EngineInterface, rows: readonly Row[]): Actions {
  const run = (work: () => Promise<unknown>) => () => void work().catch(() => undefined)
  return {
    act: run(() => act($)),
    down: run(() => moveTo($, stopFrom(1))),
    up: run(() => moveTo($, stopFrom(-1))),
    out: run(() => goOut($)),
    in: run(() => goIn($)),
    note: run(() => noteOn($, layout?.cursor ?? null)),
    next: run(() => nextFile($)),
    wrap: run(() => toggleWrap($)),
    viewed: run(() => toggleViewed($)),
    send: run(() => sendNotes($, rows)),
    reviewed: run(() => confirmReviewed($)),
    drop: run(() => dropFolder($)),
    save: (row, text) => void saveNote($, row, text).catch(() => undefined),
  }
}

// The paths a tool call is about to change, and whether a shell command
// names them; none for a tool that changes no files.
function namedBy(e: unknown): { paths: string[]; isShell: boolean } {
  if (!isRecord(e)) {
    return { paths: [], isShell: false }
  }
  if ((e.tool === 'Edit' || e.tool === 'Write') && typeof e.file_path === 'string') {
    return { paths: [e.file_path], isShell: false }
  }
  if (e.tool === 'NotebookEdit' && typeof e.notebook_path === 'string') {
    return { paths: [e.notebook_path], isShell: false }
  }
  if ((e.tool === 'Bash' || e.tool === 'PowerShell') && typeof e.command === 'string') {
    return { paths: pathsIn(e.command, cwd, places.home), isShell: true }
  }
  return { paths: [], isShell: false }
}

// The files a shell command changed in a git repository, as Claude Code
// found them.
function changedBy(result: unknown): string[] {
  const found = isRecord(result) && isRecord(result.bashEditDiff) ? result.bashEditDiff.changedFiles : undefined
  return Array.isArray(found) ? found.filter(path => typeof path === 'string') : []
}

// ---------------------------------------------------------------------------
// The folders difnote watches. Each gets a private git folder, in Claude
// Code's data folder for difnote, which records the folder before Claude
// first changes it and again each time the pane looks; the pane shows what
// changed since the state the person last reviewed, whoever changed it.

type RunResult = Awaited<ReturnType<EngineInterface['process']['run']>>

// A folder difnote knows of: watched, with its private git folder, what kind
// of folder it is, and whether its first record is in (`ready` resolves
// with that); or skipped, with why.
type Watched = {
  folder: string
  state: 'watched'
  git: string
  kind: 'repository' | 'folder' | 'files'
  ready: Promise<boolean>
  hasBase: boolean
}
type Folder = Watched | { folder: string; state: 'skipped'; why: string }

// What a look found, by folder: the state it recorded, what a review marks
// reviewed, and the changed files; and the folders it couldn't look at,
// with why.
type Looked = { trees: Map<string, string>; files: Map<string, FileDiff[]>; failed: { folder: string; why: string }[] }

// When each folder's reviewed state was recorded, when it was last used and
// when its git folder was last tidied, what kind of folder it is, the
// folders of the sessions it carries changes for, and how many changed
// files the last look found, by folder: kept in the store, so a folder
// unused for long can be emptied, and a later session in a folder that
// Claude changed another from watches that one again while its changes wait
// for review. Used means Claude changed it, a review covered it or a session
// started in it; a look is no use.
type Times = { baseAt: number; usedAt: number; tidiedAt: number; kind: Watched['kind']; from: string[]; pending: number }
const FOLDERS = 'folders'

// The most session folders a folder carries changes for.
const MOST_FROM = 20

// Folder times as the store keeps them; kind, from and pending may be missing.
function timesOf(value: unknown): Times | null {
  if (!isRecord(value) || typeof value.baseAt !== 'number' || typeof value.usedAt !== 'number' || typeof value.tidiedAt !== 'number') {
    return null
  }
  const kind = value.kind === 'repository' || value.kind === 'files' ? value.kind : 'folder'
  const from = Array.isArray(value.from) ? value.from.filter(one => typeof one === 'string') : []
  const pending = typeof value.pending === 'number' ? value.pending : 0
  return { baseAt: value.baseAt, usedAt: value.usedAt, tidiedAt: value.tidiedAt, kind, from, pending }
}

// A folder's times as kept, or new ones from `now`.
function timesFor(folder: string, now: number): Times {
  const one = folders.get(folder)
  const kind = one?.state === 'watched' ? one.kind : 'folder'
  return times[folder] ?? { baseAt: now, usedAt: now, tidiedAt: now, kind, from: [], pending: 0 }
}

// Whether a folder is outside the session's own: not it, nor in it.
function isOutside(folder: string): boolean {
  return sessionFolder !== '' && !isInside(folder, sessionFolder)
}

// After Claude changed files in the folders found: each used now, with
// changes to review; one outside the session's folder is watched again by
// later sessions here until a look finds nothing in it left to review.
async function touched($: EngineInterface, found: readonly (Folder | null)[]) {
  const used = found.filter((one): one is Watched => one?.state === 'watched')
  if (used.length === 0) {
    return
  }
  const now = await $.clock.now()
  for (const { folder } of used) {
    const was = timesFor(folder, now)
    const from = isOutside(folder) ? [...new Set([...was.from, cwd])].slice(-MOST_FROM) : was.from
    times[folder] = { ...was, usedAt: now, pending: Math.max(was.pending, 1), from }
  }
  await saveTimes($)
}

const UNUSED_MS = 30 * 24 * 60 * 60 * 1000
const TIDY_MS = 24 * 60 * 60 * 1000

// The most repositories inside a watched folder that difnote watches too,
// and how deep inside one another it looks for them; the most files git
// may fail to read before a folder is skipped.
const MOST_NESTED = 20
const MOST_ROUNDS = 3
const MOST_UNREADABLE = 10

// Why a folder isn't watched, in the pane's words.
class Skip extends Error {}

let places: Places = { data: '', config: null, home: null }
let hasGit = false
let excludesFile: string | null = null
const folders = new Map<string, Folder>()
// The folders this session works in, watched or not.
const active = new Set<string>()
// Each folder's repository top, null for none, as git answered.
const tops = new Map<string, string | null>()
// The placeholders recorded, by path: their text, git's id for it, and the
// size and time it was recorded with.
const placeholders = new Map<string, { text: string; id: string; size: number; changedAt: number }>()
const looking = new Set<string>()
let times: Record<string, Times> = {}
// The session's own folder: its repository's top, else the session's.
let sessionFolder = ''
// What each folder's last full look left: the repositories git lists in it,
// and the ids of its reviewed state and of the state it recorded. A look by
// itself that finds all three the same, and no file but placeholders
// differing from the record, keeps the result. Another session in the same
// folder shares the record, and moves the recorded state when it looks.
const quiet = new Map<string, { nested: string; base: string; shown: string }>()
// How many of each folder's looks took over SLOW_MS.
const slowness = new Map<string, number>()
// The outside folders earlier sessions here left changes in, watched again;
// and the folders emptied at the start that still held changes not reviewed.
const carried = new Set<string>()
let lost: string[] = []
// The folders emptied this session, for git to pack their git folders.
const emptied = new Set<string>()

// A watched folder's private git folder.
function gitOf(folder: string): string {
  return `${places.data}/roots/${slugOf(folder)}/git`
}
let failed: { folder: string; why: string }[] = []

// What difnote watches, as the pane says it: the folders refused or that a
// look couldn't reach, the folders being recorded for the first time, and
// when the oldest state it compares against was recorded.
function watchOf(): Watch {
  const mine = [...active].flatMap(folder => {
    const one = folders.get(folder)
    return one === undefined ? [] : [one]
  })
  const since = mine.flatMap(one => {
    const time = one.state === 'watched' && one.hasBase ? times[one.folder] : undefined
    return time === undefined ? [] : [time.baseAt]
  })
  const skipped = mine.flatMap(one => (one.state === 'skipped' ? [{ folder: one.folder, why: one.why }] : []))
  return {
    hasGit,
    since: since.length === 0 ? null : Math.min(...since),
    looking: [...looking],
    skipped: [...skipped, ...failed],
    slow: [...active].filter(isSlow),
    carried: [...carried].filter(folder => active.has(folder)).map(folder => ({ folder, usedAt: times[folder]?.usedAt ?? 0 })),
    lost,
    roots: rootsOf(mine),
    home: places.home,
  }
}

// The folders the pane groups files under: the session's, its
// repository's top when that is above it, and each watched folder outside
// it that no other one holds.
function rootsOf(mine: readonly Folder[]): string[] {
  const outside = mine.flatMap(one => (one.state === 'watched' && isOutside(one.folder) ? [one.folder] : []))
  const outermost = outside.filter(folder => !outside.some(other => other !== folder && isInside(folder, other)))
  return [cwd, ...(sessionFolder !== '' && sessionFolder !== cwd ? [sessionFolder] : []), ...outermost.toSorted()]
}

function isSlow(folder: string): boolean {
  return (slowness.get(folder) ?? 0) >= SLOW_TIMES
}

function changed($: EngineInterface) {
  void update($, watch, () => watchOf()).catch(() => undefined)
}

// At the session's start: where to keep the git folders, whether git runs,
// the person's own ignore file, and the session's folder, recorded in the
// background if it has no record yet; then old records tidied.
async function startWatching($: EngineInterface): Promise<void> {
  places = placesOf($.plugin.root, cwd)
  folders.clear()
  tops.clear()
  placeholders.clear()
  active.clear()
  looking.clear()
  quiet.clear()
  slowness.clear()
  carried.clear()
  lost = []
  sessionFolder = ''
  failed = []
  hasGit = await git($, 'version', cwd).then(
    ran => ran.exitCode === 0,
    () => false,
  )
  if (!hasGit) {
    return
  }
  const stored = await $.store.get(FOLDERS).catch(() => undefined)
  times = Object.fromEntries(
    Object.entries(isRecord(stored) ? stored : {}).flatMap(([folder, value]) => {
      const one = timesOf(value)
      return one === null ? [] : [[folder, one] as const]
    }),
  )
  const asked = await git($, 'excludes', cwd).catch(() => null)
  excludesFile = asked?.exitCode === 0 && asked.stdout.trim() !== '' ? asked.stdout.trim() : null
  // Folders unused for long are emptied first, before any can be watched
  // again; the rest of the tidying goes on in the background.
  await letGo($).catch(() => undefined)
  if (lost.length > 0) {
    $.ui.toast(`Emptied after 30 days unused, with changes you hadn't reviewed: ${lost.join(', ')}`)
  }
  const top = await topOf($, cwd)
  sessionFolder = top ?? cwd
  const mine = follow($, sessionFolder, top === null ? 'folder' : 'repository')
  const now = await $.clock.now()
  // A session starting here uses its folder and the repositories in it.
  for (const [folder, one] of Object.entries(times)) {
    if (!isOutside(folder)) {
      one.usedAt = now
    }
  }
  await saveTimes($)
  // The folders outside it that Claude changed from here, and whose changes
  // wait for review, watched again: they show, as in the session that made
  // the change. One that is no longer a repository is, as any folder outside
  // the session's, watched for Claude's own files only.
  const wanted = Object.entries(times).filter(([folder, one]) => isOutside(folder) && one.from.includes(cwd) && now - one.usedAt <= UNUSED_MS)
  const found = await Promise.all(
    wanted.map(async ([folder]) => ((await $.fs.exists(folder).catch(() => false)) ? { folder, top: await topOf($, folder) } : null)),
  )
  for (const one of found) {
    if (one !== null) {
      follow($, one.folder, one.top === one.folder ? 'repository' : 'files')
      carried.add(one.folder)
    }
  }
  // Tidying waits for the session's folder's first record, so their git
  // calls don't hold each other's locks.
  void (mine.state === 'watched' ? mine.ready : Promise.resolve(false)).then(() => tidy($)).catch(() => undefined)
}

// Before Claude changes the files at `paths`: the folders they are in,
// watched from now on, each recorded first if it has no record yet, waiting
// up to `waitMs`. A shell command's paths count only in a git repository or
// a folder already watched; an Edit's or a Write's, in any folder.
async function beforeChange(
  $: EngineInterface,
  paths: readonly string[],
  isShell: boolean,
  waitMs: number,
): Promise<{ isRecorded: boolean; found: (Folder | null)[] }> {
  if (!hasGit) {
    return { isRecorded: true, found: [] }
  }
  const found = await Promise.all(paths.map(path => folderFor($, path, isShell).catch(() => null)))
  const waits = found.flatMap(one => (one?.state === 'watched' && !one.hasBase ? [one.ready] : []))
  if (waits.length > 0 && waitMs > 0) {
    await Promise.race([Promise.all(waits), $.clock.sleep(waitMs)])
  }
  return { isRecorded: found.every(one => one?.state !== 'watched' || one.hasBase), found }
}

// Whether a file is in a folder difnote has a record of: there, the
// records show its changes, whoever made them.
function isWatched(path: string): boolean {
  return [...folders.values()].some(
    one => one.state === 'watched' && one.hasBase && (one.kind === 'files' ? parentOf(path) === one.folder : isInside(path, one.folder)),
  )
}

// Records each folder this session works in as it is now, and compares it
// with its reviewed state. A look by itself (`isTimer`) keeps what the last
// look found for each folder git says nothing changed in, and for each slow
// one.
async function look($: EngineInterface, isTimer: boolean): Promise<Looked> {
  const was = looked
  // Looking at a folder finds the repositories inside it, which are looked
  // at in turn.
  const results: (Seen | null)[] = []
  const done = new Set<string>()
  for (let round = 0; round <= MOST_ROUNDS; round += 1) {
    const watched = [...active].flatMap(folder => {
      const one = folders.get(folder)
      return one?.state === 'watched' && !done.has(folder) ? [one] : []
    })
    if (watched.length === 0) {
      break
    }
    for (const one of watched) {
      done.add(one.folder)
    }
    results.push(...(await Promise.all(watched.map(entry => (isTimer ? keptOrLookAt($, entry, was) : lookAt($, entry))))))
  }
  // A folder a look was cut short in, as when Claude Code stopped the call
  // that started it, keeps what the last look found.
  const found: Looked = { trees: new Map(), files: new Map(), failed: [] }
  for (const result of results) {
    if (result !== null && 'tree' in result) {
      found.trees.set(result.folder, result.tree)
      found.files.set(result.folder, result.files)
    } else if (result !== null && result.isCut) {
      const tree = was?.trees.get(result.folder)
      if (tree !== undefined) {
        found.trees.set(result.folder, tree)
        found.files.set(result.folder, was?.files.get(result.folder) ?? [])
      }
    } else if (result !== null) {
      found.failed.push({ folder: result.folder, why: result.why })
    }
  }
  // How many changed files each folder holds, for the 30-day emptying to say
  // so. An outside folder with changes left to review, in it or a folder in
  // it, is watched again by later sessions here, whoever changed it; one
  // with nothing left is no longer.
  for (const [folder, files] of found.files) {
    const one = times[folder]
    if (one !== undefined) {
      const isClean = [...found.files].every(([other, list]) => !isInside(other, folder) || list.length === 0)
      const from = !isOutside(folder) ? one.from : isClean ? one.from.filter(at => at !== cwd) : [...new Set([...one.from, cwd])].slice(-MOST_FROM)
      times[folder] = { ...one, pending: files.length, from }
    }
  }
  await saveTimes($)
  failed = found.failed

  return found
}

// The files a look found, the one changed last first.
function filesOfLook(found: Looked): FileDiff[] {
  return [...found.files.values()].flat().toSorted((x, y) => y.changedAt - x.changedAt)
}

type Seen = { folder: string; tree: string; files: FileDiff[] } | { folder: string; why: string; isCut: boolean }

// A look by itself at one folder: what the last look found, for a slow
// folder or one git says nothing changed in; else a look.
async function keptOrLookAt($: EngineInterface, entry: Watched, was: Looked | null): Promise<Seen | null> {
  const tree = was?.trees.get(entry.folder)
  const files = was?.files.get(entry.folder)
  if (tree !== undefined && files !== undefined && (isSlow(entry.folder) || (await isQuiet($, entry).catch(() => false)))) {
    return { folder: entry.folder, tree, files }
  }
  return lookAt($, entry)
}

async function lookAt($: EngineInterface, entry: Watched): Promise<Seen | null> {
  if (!(await entry.ready)) {
    return null
  }
  const startedAt = await $.clock.now()
  try {
    const { tree, nested } = await record($, entry, false)
    ok(await inGit($, entry, 'refs', { stdin: `update refs/difnote/shown ${tree}\n` }), "git couldn't keep its state")
    // Read before the comparison: a review elsewhere that moves it between
    // the two makes the next look by itself look again.
    const base = await refOf($, entry, 'base')
    const diff = ok(await inGit($, entry, 'diff'), "git couldn't compare it")
    const entries = entriesOf(diff.stdout, diff.isStdoutTruncated)
    const wanted = sizesWanted(entries)
    const sizes =
      wanted.length === 0 ? new Map<string, number>() : sizesOf((await inGit($, entry, 'sizes', { stdin: `${wanted.join('\n')}\n` })).stdout)
    const files = await Promise.all(entries.map(async one => fileOf(one, entry.folder, cwd, sizes, await changedAt($, entry.folder, one))))
    quiet.set(entry.folder, { nested: nested.join('\0'), base, shown: tree })
    // Slow looks count only one after another: a quick one, as after the
    // folder's first big change, starts the count over.
    if ((await $.clock.now()) - startedAt > SLOW_MS) {
      slowness.set(entry.folder, (slowness.get(entry.folder) ?? 0) + 1)
    } else {
      slowness.delete(entry.folder)
    }
    return { folder: entry.folder, tree, files }
  } catch (error) {
    quiet.delete(entry.folder)
    return { folder: entry.folder, why: whyOf(error), isCut: isCut(error) }
  }
}

// Whether nothing changed in a folder since its last full look, by what git
// reads without writing: no file it doesn't have, the same repositories in
// it, the same reviewed state, and no file differing from the record but a
// placeholder whose size and time are those recorded.
async function isQuiet($: EngineInterface, entry: Watched): Promise<boolean> {
  const known = quiet.get(entry.folder)
  if (known === undefined) {
    return false
  }
  const [others, dirty, base, shown] = await Promise.all([
    inGit($, entry, 'others'),
    inGit($, entry, 'dirty'),
    refOf($, entry, 'base'),
    refOf($, entry, 'shown'),
  ])
  if (others.exitCode !== 0 || dirty.exitCode !== 0 || others.isStdoutTruncated || dirty.isStdoutTruncated) {
    return false
  }
  // A review, or another session's record, moved one of the states.
  if (base !== known.base || shown !== known.shown) {
    return false
  }
  // Any file new since the record lists beside the repositories in it.
  if (splitZ(others.stdout).join('\0') !== known.nested) {
    return false
  }
  const paths = splitZ(dirty.stdout)
  if (paths.some(path => !placeholders.has(`${entry.folder}/${path}`))) {
    return false
  }
  const facts = paths.length === 0 ? new Map() : await factsOf($, entry.folder, paths)
  return paths.every(path => {
    const fact = facts.get(path)
    const recorded = placeholders.get(`${entry.folder}/${path}`)
    return fact !== undefined && recorded !== undefined && recorded.size === fact.size && recorded.changedAt === fact.changedAt
  })
}

// The id of a folder's reviewed or last recorded state, as git keeps it in
// its files: read, not run.
async function refOf($: EngineInterface, entry: Watched, name: 'base' | 'shown'): Promise<string> {
  const loose = await $.fs.read(`${entry.git}/refs/difnote/${name}`).catch(() => null)
  if (loose !== null) {
    return loose.trim()
  }
  const packed = await $.fs.read(`${entry.git}/packed-refs`).catch(() => '')
  return new RegExp(`^(\\S+) refs/difnote/${name}$`, 'm').exec(packed)?.[1] ?? ''
}

async function changedAt($: EngineInterface, folder: string, entry: Entry): Promise<number> {
  if (entry.status === 'D') {
    return 0
  }
  const stat = await $.fs.stat(`${folder}/${entry.path}`).catch(() => null)
  return stat?.mtimeMs ?? 0
}

// Marks each folder's state as the pane showed it reviewed: the next look
// compares with it. A review uses the folder.
async function reviewed($: EngineInterface, trees: ReadonlyMap<string, string>): Promise<string[]> {
  const now = await $.clock.now()
  const done = await Promise.all(
    [...trees].map(async ([folder, tree]) => {
      const entry = folders.get(folder)
      const ran = entry?.state === 'watched' ? await inGit($, entry, 'refs', { stdin: `update refs/difnote/base ${tree}\n` }).catch(() => null) : null
      return ran?.exitCode === 0 ? [folder] : []
    }),
  )
  for (const folder of done.flat()) {
    times[folder] = { ...timesFor(folder, now), baseAt: now, usedAt: now }
  }
  await saveTimes($)
  return done.flat()
}

// Of the files Claude changed by its Edit and Write records, those inside a
// watched folder that it ignores: their changes show by the records.
async function ignoredOf($: EngineInterface, paths: readonly string[]): Promise<Set<string>> {
  const byFolder = new Map<Watched, string[]>()
  for (const path of paths) {
    const entry = [...folders.values()]
      .filter((one): one is Watched => one.state === 'watched' && one.hasBase && isInside(path, one.folder))
      .toSorted((x, y) => y.folder.length - x.folder.length)[0]
    if (entry !== undefined) {
      byFolder.set(entry, [...(byFolder.get(entry) ?? []), path.slice(entry.folder.length + 1)])
    }
  }
  const found = await Promise.all(
    [...byFolder].map(async ([entry, list]) => {
      const ran = await inGit($, entry, 'ignored', { stdin: zOf(list) }).catch(() => null)
      return splitZ(ran?.stdout ?? '').map(path => `${entry.folder}/${path}`)
    }),
  )
  return new Set(found.flat())
}

// The folder a path belongs to, watched from now on: its git repository's
// top, else the watched folder it is in; else, for an Edit or a Write, its
// own folder, for the files Claude writes there. Null where none fits.
async function folderFor($: EngineInterface, path: string, isShell: boolean): Promise<Folder | null> {
  const dir = await dirOf($, path, isShell ? 3 : 10)
  if (dir === null) {
    return null
  }
  const top = await topOf($, dir)
  if (top !== null) {
    return follow($, top, 'repository')
  }
  const known = [...folders.values()]
    .filter(one => one.state === 'watched' && (one.kind === 'files' ? dir === one.folder : isInside(dir, one.folder)))
    .toSorted((x, y) => y.folder.length - x.folder.length)[0]
  if (known !== undefined) {
    active.add(known.folder)
    return known
  }

  return isShell ? null : follow($, dir, 'files')
}

// The folder a path is or is in, the nearest that exists, looking up to
// `tries` folders up.
async function dirOf($: EngineInterface, path: string, tries: number): Promise<string | null> {
  let at = path
  for (let i = 0; i < tries && at !== '/'; i += 1) {
    const stat = await $.fs.stat(at).catch(() => null)
    if (stat !== null) {
      return stat.kind === 'dir' ? at : parentOf(at)
    }
    at = parentOf(at)
  }
  return null
}

// The top of the git repository a folder is in, unless difnote refuses it.
// The nearest folder holding a .git folder or file, as git finds a
// repository's top, but by looking, so no git variable Claude Code was
// started with can point elsewhere.
async function topOf($: EngineInterface, dir: string): Promise<string | null> {
  const known = tops.get(dir)
  if (known !== undefined) {
    return known
  }
  let top: string | null = null
  for (let at = dir; top === null; at = parentOf(at)) {
    if (await $.fs.exists(`${at}/.git`).catch(() => false)) {
      top = at
    } else if (at === '/') {
      break
    }
  }
  const found = top !== null && refusalOf(top, places) === null ? top : null
  tops.set(dir, found)
  return found
}

// A repository's git folder, and the one its work trees share: its .git
// folder, or the one its .git file names, for a work tree or a submodule.
async function repoDirsOf($: EngineInterface, top: string): Promise<{ git: string; common: string } | null> {
  const stat = await $.fs.stat(`${top}/.git`).catch(() => null)
  const own = stat?.kind === 'dir' ? `${top}/.git` : gitdirOf(await $.fs.read(`${top}/.git`).catch(() => ''), top)
  if (own === null) {
    return null
  }
  const common = await $.fs.read(`${own}/commondir`).catch(() => null)
  return { git: own, common: common === null || common.trim() === '' ? own : under(own, common.trim()) }
}

// A folder the session works in, from now on: watched, its first record
// taken in the background, or skipped, with why.
function follow($: EngineInterface, folder: string, kind: Watched['kind']): Folder {
  active.add(folder)
  const known = folders.get(folder)
  if (known !== undefined) {
    return known
  }
  const why =
    refusalOf(folder, places) ?? (kind === 'files' && (places.home === null || !isInside(folder, places.home)) ? 'outside your home folder' : null)
  if (why !== null) {
    const skipped = { folder, state: 'skipped' as const, why }
    folders.set(folder, skipped)
    changed($)
    return skipped
  }
  const entry: Watched = {
    folder,
    state: 'watched',
    git: gitOf(folder),
    kind,
    ready: Promise.resolve(false),
    hasBase: false,
  }
  folders.set(folder, entry)
  entry.ready = begin($, entry).then(
    () => {
      entry.hasBase = true
      changed($)
      return true
    },
    (error: unknown) => {
      // Cut short, the folder is tried again when it next comes up.
      if (isCut(error)) {
        folders.delete(folder)
      } else {
        folders.set(folder, { folder, state: 'skipped', why: whyOf(error) })
      }
      changed($)
      return false
    },
  )
  return entry
}

// A folder's private git folder, made if new, with difnote's settings; and
// its first record, if it has none.
async function begin($: EngineInterface, entry: Watched): Promise<void> {
  const store = parentOf(entry.git)
  if (await $.fs.exists(`${entry.git}/HEAD`)) {
    const holds = await $.fs.read(`${store}/folder`).catch(() => '')
    if (holds.trim() !== entry.folder) {
      throw new Skip('its private git folder holds another folder')
    }
  } else {
    await $.fs.write(`${store}/folder`, `${entry.folder}\n`)
    ok(await git($, 'init', OWN, { env: envOf(entry.git, entry.folder) }), "git couldn't make a folder for it")
  }
  await $.fs.write(`${entry.git}/config`, configOf(await $.fs.read(`${entry.git}/config`), entry.folder, excludesFile))
  const own = entry.kind === 'repository' ? await $.fs.read(`${entry.folder}/.git/info/exclude`).catch(() => '') : ''
  await $.fs.write(`${entry.git}/info/exclude`, excludeOf(entry.kind, own))

  if ((await inGit($, entry, 'base')).exitCode === 0) {
    times[entry.folder] = { ...timesFor(entry.folder, await $.clock.now()), kind: entry.kind }
    await saveTimes($)
    return
  }
  looking.add(entry.folder)
  changed($)
  try {
    const { tree } = await record($, entry, true)
    ok(
      await inGit($, entry, 'refs', { stdin: `update refs/difnote/base ${tree}\nupdate refs/difnote/shown ${tree}\n` }),
      "git couldn't keep its state",
    )
    const now = await $.clock.now()
    times[entry.folder] = { ...timesFor(entry.folder, now), baseAt: now, usedAt: now, tidiedAt: now, kind: entry.kind }
    await saveTimes($)
  } finally {
    looking.delete(entry.folder)
  }
}

// Records the folder as it is now and answers the state's id, and the
// repositories git lists in it. Files up to MOST_KEPT are kept whole;
// larger ones, those named like secrets and those git can't read, by a
// placeholder with their size and time. Repositories inside it are watched
// on their own.
async function record($: EngineInterface, entry: Watched, isFirst: boolean): Promise<{ tree: string; nested: string[] }> {
  const others = ok(await inGit($, entry, 'others'), "git couldn't list its files")
  const listing = splitZ(others.stdout)
  const untracked = listing.filter(path => !path.endsWith('/'))
  if (others.isStdoutTruncated || untracked.length > MOST_FILES) {
    throw new Skip(`over ${MOST_FILES.toLocaleString('en-US')} files`)
  }
  const nested = listing.filter(path => path.endsWith('/'))
  for (const one of nested.slice(0, MOST_NESTED)) {
    follow($, `${entry.folder}/${one.slice(0, -1)}`, 'repository')
  }

  const dirty = isFirst ? [] : splitZ(ok(await inGit($, entry, 'dirty'), "git couldn't compare its files").stdout)
  // A repository's files that its .gitignore matches but it tracks all the
  // same, which the private git folder would skip.
  const tracked = entry.kind === 'repository' ? await trackedOf($, entry.folder) : []
  const paths = [...new Set([...untracked, ...dirty, ...tracked])]
  const facts = await factsOf($, entry.folder, paths)
  let add: string[] = []
  const drop: string[] = []
  const marks: Mark[] = []
  for (const path of paths) {
    const fact = facts.get(path)
    if (fact?.kind === 'dir') {
      drop.push(path)
    } else if (fact !== undefined && (isSecret(path) || fact.size > MOST_KEPT)) {
      marks.push({
        path,
        size: fact.size,
        changedAt: fact.changedAt,
        text: placeholderOf(isSecret(path) ? 'secret' : 'large', fact.size, fact.changedAt),
      })
    } else {
      add.push(path)
    }
  }

  // git stops at a file it can't read: that one takes a placeholder, and
  // the rest go again.
  for (let unreadable = 0; add.length > 0; unreadable += 1) {
    const ran = await inGit($, entry, 'add', { stdin: zOf(add), timeoutMs: isFirst ? 120_000 : 10_000 })
    if (ran.exitCode === 0) {
      break
    }
    const path = /fatal: Unable to process path (.*)$/m.exec(ran.stderr)?.[1]
    if (path === undefined || !add.includes(path) || unreadable >= MOST_UNREADABLE) {
      throw new Skip(`git couldn't record it: ${firstLine(ran.stderr)}`)
    }
    add = add.filter(one => one !== path)
    const size = facts.get(path)?.size ?? 0
    const time = facts.get(path)?.changedAt ?? 0
    marks.push({ path, size, changedAt: time, text: placeholderOf('unreadable', size, time) })
  }
  if (drop.length > 0) {
    ok(await inGit($, entry, 'drop', { stdin: zOf(drop) }), "git couldn't record it")
  }
  if (marks.length > 0) {
    await mark($, entry, marks)
  }

  return { tree: ok(await inGit($, entry, 'tree'), "git couldn't record it").stdout.trim(), nested }
}

// The files a repository tracks though its .gitignore, or the person's own
// ignore file, matches them: the private git folder would skip them.
async function trackedOf($: EngineInterface, top: string): Promise<string[]> {
  const dirs = await repoDirsOf($, top)
  if (dirs === null) {
    return []
  }
  const ran = await git($, 'tracked', top, { env: repoEnvOf(dirs, top, excludesFile) }).catch(() => null)
  return ran?.exitCode === 0 ? splitZ(ran.stdout) : []
}

// A file kept by a placeholder: its path, the size and time it was
// recorded with, and the placeholder's text.
type Mark = { path: string; size: number; changedAt: number; text: string }

// Puts the placeholders into the record, each made into a git object once.
async function mark($: EngineInterface, entry: Watched, marks: readonly Mark[]) {
  const fresh = marks.filter(one => placeholders.get(`${entry.folder}/${one.path}`)?.text !== one.text)
  if (fresh.length > 0) {
    const ran = ok(await inGit($, entry, 'blobs', { stdin: blobsOf(fresh.map(one => one.text)) }), "git couldn't record it")
    const ids = ran.stdout.trim().split('\n')
    fresh.forEach((one, i) =>
      placeholders.set(`${entry.folder}/${one.path}`, { text: one.text, id: ids[i] ?? '', size: one.size, changedAt: one.changedAt }),
    )
  }
  const lines = marks.map(one => `100644 ${placeholders.get(`${entry.folder}/${one.path}`)?.id ?? ''}\t${one.path}\0`)
  ok(await inGit($, entry, 'set', { stdin: lines.join('') }), "git couldn't record it")
}

// Each path's size, time and kind, from a listing of its folder; a path
// that isn't there has none.
async function factsOf($: EngineInterface, folder: string, paths: readonly string[]) {
  const byDir = new Map<string, string[]>()
  for (const path of paths) {
    const cut = path.lastIndexOf('/')
    const dir = cut < 0 ? '' : path.slice(0, cut)
    byDir.set(dir, [...(byDir.get(dir) ?? []), path])
  }
  const facts = new Map<string, { size: number; changedAt: number; kind: string }>()
  const dirs = [...byDir]
  for (let at = 0; at < dirs.length; at += 32) {
    await Promise.all(
      dirs.slice(at, at + 32).map(async ([dir, list]) => {
        const entries = await $.fs.list(dir === '' ? folder : `${folder}/${dir}`).catch(() => [])
        const byName = new Map(entries.map(one => [one.name, one]))
        await Promise.all(
          list.map(async path => {
            // Not in its folder's listing, as one that couldn't be read: the
            // file itself is asked, so a large or secret one never goes to git.
            const one = byName.get(path.slice(path.lastIndexOf('/') + 1)) ?? (await $.fs.stat(`${folder}/${path}`).catch(() => undefined))
            if (one !== undefined) {
              facts.set(path, { size: one.size, changedAt: one.mtimeMs, kind: one.kind })
            }
          }),
        )
      }),
    )
  }
  return facts
}

// A folder unused for 30 days is emptied: its states let go of, and its
// record. git packs what's left at the next tidying. One whose last look
// found changes not reviewed is named, for the session to say so.
async function letGo($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  for (const [folder, one] of Object.entries(times)) {
    const store = gitOf(folder)
    if (now - one.usedAt > UNUSED_MS) {
      const env = envOf(store, folder)
      await git($, 'refs', OWN, { stdin: 'delete refs/difnote/base\ndelete refs/difnote/shown\n', env }).catch(() => undefined)
      await git($, 'empty', OWN, { env }).catch(() => undefined)
      delete times[folder]
      emptied.add(folder)
      if (one.pending > 0) {
        lost = [...lost, folder]
      }
    }
  }
  await saveTimes($)
}

// Once a day per folder, git packs its records and lets go of the states
// no review needs, an hour after; and the records of emptied folders.
async function tidy($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  const due = Object.entries(times).flatMap(([folder, one]) => (now - one.tidiedAt > TIDY_MS ? [{ folder, store: gitOf(folder), one }] : []))
  for (const { folder, store, one } of due) {
    // A folder whose git folder was deleted is let go of; one git can't tidy
    // now is tidied next time.
    if (!(await $.fs.exists(`${store}/HEAD`))) {
      delete times[folder]
    } else if ((await git($, 'gc', OWN, { timeoutMs: 300_000, env: envOf(store, folder) }).catch(() => null))?.exitCode === 0) {
      one.tidiedAt = now
    }
  }
  for (const folder of emptied) {
    await git($, 'gc', OWN, { timeoutMs: 300_000, env: envOf(gitOf(folder), folder) }).catch(() => undefined)
  }
  emptied.clear()
  await saveTimes($)
}

async function saveTimes($: EngineInterface) {
  await $.store.set(FOLDERS, times).catch(() => undefined)
}

// How a command runs: what goes on its standard input, how long it may
// take, and, for a private git folder's, git's variables naming it.
type Init = { stdin?: string; timeoutMs?: number; env?: Record<string, string> }

// Where difnote's commands on its private git folders run: never inside a
// folder it watches, where git would read paths, and a ref's name, as that
// folder's files; as when the private folder itself lies in one, with
// difnote loaded from its own repository.
const OWN = '/'

type Command =
  | 'version'
  | 'excludes'
  | 'init'
  | 'tracked'
  | 'others'
  | 'dirty'
  | 'add'
  | 'drop'
  | 'set'
  | 'blobs'
  | 'tree'
  | 'refs'
  | 'base'
  | 'diff'
  | 'sizes'
  | 'ignored'
  | 'empty'
  | 'gc'

// Every git command difnote runs, each written out in full, in `folder`:
// `version` and `excludes` in the session's folder, `tracked` in the
// repository it reads, and the rest, which work on a private git folder
// that git's own variables name (envOf), in OWN. What differs from call to
// call, paths and ids, goes on standard input. The README says when and why
// each runs.
function git($: EngineInterface, command: Command, folder: string, init: Init = {}): Promise<RunResult> {
  const options = {
    cwd: folder,
    env: init.env ?? ENV,
    timeoutMs: init.timeoutMs ?? 10_000,
    ...(init.stdin === undefined ? {} : { stdin: init.stdin }),
  }
  const commands = {
    version: () => $.process.run(['git', '--version'], options),
    // The person's own ignore file: the one setting read with their own
    // settings on.
    excludes: () => $.process.run(['git', 'config', '--global', '--path', '--get', 'core.excludesFile'], { cwd: folder, timeoutMs: 5_000 }),
    init: () => $.process.run(['git', 'init', '--quiet'], options),
    tracked: () => $.process.run(['git', '--no-optional-locks', 'ls-files', '-z', '--cached', '--ignored', '--exclude-standard'], options),
    others: () => $.process.run(['git', 'ls-files', '-z', '--others', '--exclude-standard'], options),
    dirty: () => $.process.run(['git', 'diff-files', '-z', '--name-only'], options),
    add: () => $.process.run(['git', 'update-index', '-z', '--add', '--remove', '--stdin'], options),
    drop: () => $.process.run(['git', 'update-index', '-z', '--force-remove', '--stdin'], options),
    set: () => $.process.run(['git', 'update-index', '-z', '--index-info'], options),
    blobs: () => $.process.run(['git', 'fast-import', '--quiet', '--done'], options),
    tree: () => $.process.run(['git', 'write-tree'], options),
    refs: () => $.process.run(['git', 'update-ref', '--stdin'], options),
    base: () => $.process.run(['git', 'rev-parse', '--verify', '--quiet', 'refs/difnote/base'], options),
    diff: () =>
      $.process.run(
        [
          'git',
          'diff-tree',
          '-r',
          '-z',
          '--no-renames',
          '--no-ext-diff',
          '--no-textconv',
          '--patch-with-raw',
          '-U3',
          'refs/difnote/base',
          'refs/difnote/shown',
          '--',
        ],
        options,
      ),
    sizes: () => $.process.run(['git', 'cat-file', '--batch-check'], options),
    ignored: () => $.process.run(['git', 'check-ignore', '-z', '--stdin'], options),
    empty: () => $.process.run(['git', 'read-tree', '--empty'], options),
    gc: () => $.process.run(['git', 'gc', '--quiet', '--prune=1.hour.ago'], options),
  } satisfies Record<Command, () => Promise<RunResult>>
  return commands[command]()
}

// A command in a folder's private git folder, again when another git holds
// a lock there, as another session's or a tidying, for up to 3 seconds.
const LOCK_TRIES = 10
const LOCK_MS = 300

async function inGit($: EngineInterface, entry: Watched, command: Command, init: Omit<Init, 'env'> = {}): Promise<RunResult> {
  for (let tries = 0; ; tries += 1) {
    const ran = await git($, command, OWN, { ...init, env: envOf(entry.git, entry.folder) })
    if (ran.exitCode === 0 || !ran.stderr.includes('.lock') || tries >= LOCK_TRIES) {
      return ran
    }
    await $.clock.sleep(LOCK_MS)
  }
}

function ok(ran: RunResult, what: string): RunResult {
  if (ran.exitCode !== 0) {
    throw new Skip(`${what}: ${firstLine(ran.stderr)}`)
  }
  return ran
}

// Whether a call was cut short, as when Claude Code stopped the hook that
// made it: nothing is wrong with the folder.
function isCut(error: unknown): boolean {
  return !(error instanceof Skip) && (error instanceof Error ? error.message : String(error)).includes('aborted')
}

function whyOf(error: unknown): string {
  return error instanceof Skip ? error.message : `git didn't answer: ${firstLine(error instanceof Error ? error.message : String(error))}`
}

const firstLine = (text: string) => text.trim().split('\n')[0] ?? ''
const zOf = (paths: readonly string[]) => paths.map(path => `${path}\0`).join('')
const splitZ = (text: string) => text.split('\0').filter(path => path !== '')

export const register: Register = (on, options) => {
  const colors: Colors = {
    added: colorOf(options.addedColor, 'success'),
    removed: colorOf(options.removedColor, 'error'),
    note: colorOf(options.noteColor, 'suggestion'),
    quiet: colorOf(options.quietColor, 'inactive'),
    cursor: colorOf(options.cursorColor, 'claude'),
  }
  const hasIcons = options.fileIcons !== false

  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    looked = null
    lookedAt = 0
    early = new Set()
    await startWatching($).catch(() => undefined)
    await update($, watch, () => watchOf())
    await readChanges($)
    await readNotes($)
    await readViewed($)
    // A pane Claude Code kept open through a restart, shown or behind
    // another tab, looks by itself; shown, it looks at once.
    setOpen(
      $,
      (await $.ui.panes().catch(() => [])).some(one => one.id === PANE),
    )
    if (await isShown($)) {
      void refresh($).catch(() => undefined)
    }
    await $.command.register({
      name: NAME,
      description: 'Open difnote, or go back into it: review what changed since you last looked, and write notes for the prompt',
    })

    return next(e)
  })

  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    shownUpTo = null
    shownTrees = new Map()
    await readChanges($).catch(() => undefined)
    await readNotes($).catch(() => undefined)
    await readViewed($).catch(() => undefined)

    return next(e)
  })

  on('command.run', { command: NAME }, async $ => {
    await showPane($).catch(() => undefined)

    return {}
  })

  // Before a change, the folders it is in are recorded, if they never were,
  // so it shows; after it, Claude's Edit or Write record joins the list, and
  // an open pane looks again, also after a shell command that failed, which
  // may have changed files all the same.
  on('tool.call', async ($, e, next) => {
    const { paths, isShell } = namedBy(e)
    const before = paths.length === 0 ? null : await beforeChange($, paths, isShell, WAIT_MS).catch(() => null)
    const isRecorded = before?.isRecorded ?? true
    // A folder recorded only after Claude's change has it in its record:
    // Claude's own record of the change shows instead.
    if (!isRecorded && !isShell) {
      early = new Set([...early, ...paths])
    }
    const ran = await next(e)
    if (ran.deny !== undefined) {
      return ran
    }
    learnTitle(e.tool, ran.result)
    const change = ran.isError === true ? null : (changeOf(e.tool_use_id, e.tool, ran.result) ?? docOf(e.tool_use_id, e.tool, e, ran.result, titles))
    if (change !== null) {
      const hadFiles = (await filesNow($).catch(() => [])).length > 0
      await update($, changes, list => (list.some(one => one.id === change.id) ? list : kept([...list, change]))).catch(() => undefined)
      await parkWhenListed($, hadFiles).catch(() => undefined)
    }
    // The folders Claude changed: an Edit's or a Write's, and those of the
    // files Claude Code says a shell command changed. A command that only
    // names a folder, as `ls` or `cd` does, changes none.
    if (!isShell && ran.isError !== true && before !== null) {
      await touched($, before.found).catch(() => undefined)
    }
    const found = isShell ? changedBy(ran.result) : []
    if (found.length > 0) {
      // No wait for a folder new to difnote: its first record goes on in the
      // background.
      await beforeChange($, found, true, 0)
        .then(after => touched($, after.found))
        .catch(() => undefined)
    }
    if ((isShell || paths.length > 0) && (await isShown($))) {
      void refresh($).catch(() => undefined)
    }

    return ran
  })

  // The person moving the ring off the note field closes it.
  on('ui.focus', async ($, e, next) => {
    if (e.requestId === PANE && e.origin.kind === 'person' && e.element !== FIELD) {
      await closeField($).catch(() => undefined)
    }
    // A key in a pane last looked a while ago, as one back from behind
    // another, looks again.
    if (e.requestId === PANE && e.origin.kind === 'person' && !isLooking && (await $.clock.now()) - lookedAt > STALE_MS) {
      void refresh($).catch(() => undefined)
    }

    return next(e)
  })

  on('ui.close', async ($, e, next) => {
    // Esc hands the keyboard back as it asks to close; refused, the pane takes
    // it again, as /diff's dialog does, so the next Esc steps back too.
    if (e.id === PANE && e.origin.kind !== 'unload' && (await hasStep($).catch(() => false))) {
      await openPane($).catch(() => undefined)
      await stepBack($).catch(() => undefined)
      return { deny: 'difnote went back a step' }
    }
    const answered = await next(e)
    if (e.id === PANE && answered.deny === undefined) {
      setOpen($, false)
      await forget($).catch(() => undefined)
    }

    return answered
  })

  // difnote scrolls its own window: the person's scrolls move its cursor
  // and window, and the engine's window stays at the top.
  on('ui.scroll', { requestId: PANE }, async ($, e, next) => {
    if (e.origin.kind !== 'person' || layout === null) {
      return next(e)
    }
    await scrolled($, e.by, e.pointer !== undefined, e.contentRows).catch(() => undefined)
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const list = await read($, changes)
    const files = listedFiles(await read($, diffs), list)
    const rows = rowsOfFiles(files)
    const watching = await read($, watch)
    shownUpTo = list.at(-1)?.id ?? shownUpTo
    // A look of its own would be cut short by the next drawing: the pane
    // looks when it opens, after each change while shown, and on a key.
    shownTrees = looked?.trees ?? shownTrees
    const view: PaneView = {
      ui,
      Input: 'Input' in ui ? ui.Input : undefined,
      columns: e.props.bodyColumns,
      height: e.props.scroll.bodyRows,
      isFocused: e.props.isFocused,
      colors,
      hasIcons,
      files,
      rows,
      watch: watching,
      isLooking: isLooking || watching.looking.length > 0,
      now: await $.clock.now(),
      notes: await read($, notes),
      editing: await read($, editing),
      place: await read($, place),
      viewed: await read($, viewed),
    }
    layout = layoutOf(view)
    // difnote's window starts at the top of the tree; the engine's moved off
    // it (as when the element the ring was on goes) is put back.
    if (e.props.scroll.offset > 0) {
      void $.ui.scroll({ to: 'start', in: PANE }).catch(() => undefined)
    }

    return paneOf(view, layout, actionsOf($, rows))
  })
}
