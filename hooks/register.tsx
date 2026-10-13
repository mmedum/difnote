// difnote lists what changed in the folders Claude works in since you last
// reviewed, one diff per file, lets you write a note on a line, a hunk or a
// file, and puts the notes into the prompt box for you to edit and send.

import type { EngineInterface, Register } from 'claude-code'
import { atom, read, update } from 'claude-code'
import type { Change, FileDiff, Note, Watch } from '../types'
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
import { FIELD, paneOf, walkOf } from './pane'
import type { Colors } from './pane'
import { anchorOf, changeOf, docOf, filesOf, isRecord, promptOf, rowsOf, titleOf } from './review'
import type { Row } from './review'

const NAME = 'difnote'
const PANE = 'difnote'

const diffs = atom({ plugin: 'difnote', key: 'diffs' } as const, [])
const watch = atom({ plugin: 'difnote', key: 'watch' } as const, { hasGit: false, since: null, looking: [], skipped: [] })
const changes = atom({ plugin: 'difnote', key: 'changes' } as const, [])
const notes = atom({ plugin: 'difnote', key: 'notes' } as const, [])
const editing = atom({ plugin: 'difnote', key: 'editing' } as const, null)
const file = atom({ plugin: 'difnote', key: 'file' } as const, null)

// The room the pane asks for: columns docked beside the transcript, rows
// seated above the prompt.
const DOCK_COLUMNS = 100
const INLINE_ROWS = 30
const picking = atom({ plugin: 'difnote', key: 'picking' } as const, null)

// Where each session's last review of Claude's Edit and Write records ended:
// the id of the newest change it covered, by session id, for the sessions
// reviewed last.
const BASELINES = 'baselines'
const KEPT_BASELINES = 100

// The notes not yet in the prompt box, kept through /clear and restarts,
// by the folder of the session they were written in: a session in another
// folder has its own.
const NOTES = 'notes'

// How long Claude's change waits for difnote to record a folder it hasn't
// recorded before; and how old a look may be when a key is pressed in the
// pane, as one back from behind another, before it looks again.
const WAIT_MS = 5_000
const STALE_MS = 2_000

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
// How many reviews ended this session, so a look under way when one ends
// knows its result is out of date.
let reviews = 0
let walk: string[] = []
let ring: string | null = null

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
// way runs after it.
async function refresh($: EngineInterface) {
  if (isLooking) {
    isAgain = true
    return
  }
  isLooking = true
  const from = reviews
  let now: Looked
  let ignoring: ReadonlySet<string>
  try {
    const paths = (await read($, changes)).map(change => change.path)
    ;[now, ignoring] = await Promise.all([look($), ignoredOf($, paths)])
  } finally {
    isLooking = false
  }
  // A review that ended during the look made it out of date, states the
  // pane never showed: it is dropped, and the look made again.
  if (reviews !== from) {
    isAgain = false
    await refresh($)
    return
  }
  looked = now
  ignored = ignoring
  lookedAt = await $.clock.now()
  await update($, diffs, () => filesOfLook(now))
  await update($, watch, () => watchOf())
  if (isAgain) {
    isAgain = false
    await refresh($)
  }
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
// Claude's records up to the newest shown. What changed since stays.
async function markReviewed($: EngineInterface) {
  const upTo = shownUpTo
  const trees = shownTrees
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
  if (await isShown($)) {
    void refresh($).catch(() => undefined)
  }
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
  await update($, editing, () => null)
  await $.ui.focus({ requestId: PANE, key: row.key }).catch(() => undefined)
}

// The person's own prompt to Claude after the pane showed the changes ends
// that review, unless notes are still waiting to go into the prompt box.
async function promptSent($: EngineInterface) {
  if ((await read($, notes)).length === 0) {
    await markReviewed($)
  }
}

// /difnote closes the pane when it is the one shown, else opens it with
// the keyboard and looks again.
async function togglePane($: EngineInterface) {
  const pane = (await $.ui.panes().catch(() => [])).find(one => one.id === PANE)
  if (pane?.isShown === true && pane.isPlaced) {
    // Forgotten first, so the close isn't taken for a step back.
    await forget($)
    await $.ui.close({ id: PANE })
  } else {
    await openPane($)
    void refresh($).catch(() => undefined)
  }
}

async function openField($: EngineInterface, row: Row) {
  await update($, editing, () => row.key)
  await $.ui.focus({ requestId: PANE, key: FIELD }).catch(() => undefined)
}

// Opens the pane with the keyboard. Esc steps back (see stepBack). Docked,
// the pane asks for room for code; a width the person set the dock to wins.
async function openPane($: EngineInterface) {
  await $.ui.open({ id: PANE, title: 'difnote', focus: true, closeOnEscape: true, columns: DOCK_COLUMNS, rows: INLINE_ROWS })
}

// Esc, the close mark or another plugin's close while the pane is open (its
// own /difnote closes it outright): one step back, the way
// /diff's dialog goes. A note field closes, leaving the note as it was;
// picking a line stops; a file goes back to the list. Only from the list
// does the pane close.
async function stepBack($: EngineInterface) {
  const field = await read($, editing)
  if (field !== null) {
    await update($, editing, () => null)
    await ringTo($, field)
    return
  }
  await goBack($)
}

// Whether there is a step to take back before the pane closes.
async function hasStep($: EngineInterface): Promise<boolean> {
  return (await read($, editing)) !== null || (await read($, picking)) !== null || (await read($, file)) !== null
}

// Closed, the pane forgets the file it had open, the hunk being picked from
// and an open note field: opened again, it starts on the list.
async function forget($: EngineInterface) {
  await update($, editing, () => null)
  await update($, picking, () => null)
  await update($, file, () => null)
  ring = null
}

// Moves the focus ring onto an element of the pane, as the person's arrows
// would; the pane keeps the ring where it was put when it redraws.
async function ringTo($: EngineInterface, key: string) {
  ring = key
  await $.ui.focus({ requestId: PANE, key }).catch(() => undefined)
}

// Opens a file, the ring on its first hunk.
async function openFile($: EngineInterface, path: string) {
  await update($, editing, () => null)
  await update($, picking, () => null)
  await update($, file, () => path)
  const first = rowsOf(await filesNow($)).find(row => row.file.path === path && row.kind === 'hunk')
  await ringTo($, first?.key ?? `file:${path}`)
}

// h: out of picking a line, else back to the list, the ring on the file it
// came from.
async function goBack($: EngineInterface) {
  await update($, editing, () => null)
  const hunk = await read($, picking)
  if (hunk !== null) {
    await update($, picking, () => null)
    await ringTo($, hunk)
    return
  }
  const was = await read($, file)
  await update($, file, () => null)
  if (was !== null) {
    await ringTo($, `file:${was}`)
  }
}

// Enter on a hunk header: its lines one to a row, to pick one, the ring on
// its first changed line; again, back to the highlighted code.
async function togglePicking($: EngineInterface, hunk: string) {
  await update($, editing, () => null)
  const was = await read($, picking)
  await update($, picking, () => (was === hunk ? null : hunk))
  const own = rowsOf(await filesNow($))
  const at = own.findIndex(row => row.key === hunk)
  const first = was === hunk ? undefined : own.slice(at + 1).find(row => row.kind === 'line' || row.kind === 'hunk')
  await ringTo($, first?.kind === 'line' ? first.key : hunk)
}

// j and k: the next or previous row the keys walk, from the one the ring is
// on; from none, the first or the last.
async function moveRing($: EngineInterface, step: number) {
  if (walk.length === 0) {
    return
  }
  const at = ring === null ? -1 : walk.indexOf(ring)
  const to = at < 0 ? (step > 0 ? 0 : walk.length - 1) : Math.min(walk.length - 1, Math.max(0, at + step))
  await ringTo($, walk[to] ?? walk[0] ?? '')
}

// c: a note on the row the ring is on: a file, a hunk or a changed line.
async function noteHere($: EngineInterface) {
  const row = rowsOf(await filesNow($)).find(one => one.key === ring)
  if (row !== undefined) {
    await openField($, row)
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

// When each folder's reviewed state was recorded, when a session last used
// it and when its git folder was last tidied, by folder: kept in the store,
// so a folder unused for long can be emptied.
type Times = { baseAt: number; usedAt: number; tidiedAt: number }
const FOLDERS = 'folders'

function isTimes(value: unknown): value is Times {
  return isRecord(value) && typeof value.baseAt === 'number' && typeof value.usedAt === 'number' && typeof value.tidiedAt === 'number'
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
// The placeholders recorded, by path: their text and git's id for it.
const placeholders = new Map<string, { text: string; id: string }>()
const looking = new Set<string>()
let times: Record<string, Times> = {}
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
  const own = [...active].flatMap(folder => {
    const one = folders.get(folder)
    return one === undefined ? [] : [one]
  })
  const since = own.flatMap(one => {
    const time = one.state === 'watched' && one.hasBase ? times[one.folder] : undefined
    return time === undefined ? [] : [time.baseAt]
  })
  const skipped = own.flatMap(one => (one.state === 'skipped' ? [{ folder: one.folder, why: one.why }] : []))
  return { hasGit, since: since.length === 0 ? null : Math.min(...since), looking: [...looking], skipped: [...skipped, ...failed] }
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
  failed = []
  hasGit = await git($, 'version', cwd).then(
    ran => ran.exitCode === 0,
    () => false,
  )
  if (!hasGit) {
    return
  }
  const stored = await $.store.get(FOLDERS).catch(() => undefined)
  times = Object.fromEntries(Object.entries(isRecord(stored) ? stored : {}).filter((entry): entry is [string, Times] => isTimes(entry[1])))
  const asked = await git($, 'excludes', cwd).catch(() => null)
  excludesFile = asked?.exitCode === 0 && asked.stdout.trim() !== '' ? asked.stdout.trim() : null
  // Folders unused for long are emptied first, before any can be watched
  // again; the rest of the tidying goes on in the background.
  await letGo($).catch(() => undefined)
  const top = await topOf($, cwd)
  const own = follow($, top ?? cwd, top === null ? 'folder' : 'repository')
  // Tidying waits for the session's folder's first record, so their git
  // calls don't hold each other's locks.
  void (own.state === 'watched' ? own.ready : Promise.resolve(false)).then(() => tidy($)).catch(() => undefined)
}

// Before Claude changes the files at `paths`: the folders they are in,
// watched from now on, each recorded first if it has no record yet, waiting
// up to `waitMs`. A shell command's paths count only in a git repository or
// a folder already watched; an Edit's or a Write's, in any folder.
async function beforeChange($: EngineInterface, paths: readonly string[], isShell: boolean, waitMs: number): Promise<boolean> {
  if (!hasGit) {
    return true
  }
  const found = await Promise.all(paths.map(path => folderFor($, path, isShell).catch(() => null)))
  const waits = found.flatMap(one => (one?.state === 'watched' && !one.hasBase ? [one.ready] : []))
  if (waits.length > 0 && waitMs > 0) {
    await Promise.race([Promise.all(waits), $.clock.sleep(waitMs)])
  }
  return found.every(one => one?.state !== 'watched' || one.hasBase)
}

// Whether a file is in a folder difnote has a record of: there, the
// records show its changes, whoever made them.
function isWatched(path: string): boolean {
  return [...folders.values()].some(
    one => one.state === 'watched' && one.hasBase && (one.kind === 'files' ? parentOf(path) === one.folder : isInside(path, one.folder)),
  )
}

// Records each folder this session works in as it is now, and compares it
// with its reviewed state.
async function look($: EngineInterface): Promise<Looked> {
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
    results.push(...(await Promise.all(watched.map(entry => lookAt($, entry)))))
  }
  // A folder a look was cut short in, as when Claude Code stopped the call
  // that started it, keeps what the last look found.
  const was = looked
  const now = await $.clock.now()
  const found: Looked = { trees: new Map(), files: new Map(), failed: [] }
  for (const result of results) {
    if (result !== null && 'tree' in result) {
      found.trees.set(result.folder, result.tree)
      found.files.set(result.folder, result.files)
      times[result.folder] = { ...(times[result.folder] ?? { baseAt: now, tidiedAt: now }), usedAt: now }
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
  await saveTimes($)
  failed = found.failed

  return found
}

// The files a look found, the one changed last first.
function filesOfLook(found: Looked): FileDiff[] {
  return [...found.files.values()].flat().toSorted((x, y) => y.changedAt - x.changedAt)
}

type Seen = { folder: string; tree: string; files: FileDiff[] } | { folder: string; why: string; isCut: boolean }

async function lookAt($: EngineInterface, entry: Watched): Promise<Seen | null> {
  if (!(await entry.ready)) {
    return null
  }
  try {
    const tree = await record($, entry, false)
    ok(await inGit($, entry, 'refs', { stdin: `update refs/difnote/shown ${tree}\n` }), "git couldn't keep its state")
    const diff = ok(await inGit($, entry, 'diff'), "git couldn't compare it")
    const entries = entriesOf(diff.stdout, diff.isStdoutTruncated)
    const wanted = sizesWanted(entries)
    const sizes =
      wanted.length === 0 ? new Map<string, number>() : sizesOf((await inGit($, entry, 'sizes', { stdin: `${wanted.join('\n')}\n` })).stdout)
    const files = await Promise.all(entries.map(async one => fileOf(one, entry.folder, cwd, sizes, await changedAt($, entry.folder, one))))
    return { folder: entry.folder, tree, files }
  } catch (error) {
    return { folder: entry.folder, why: whyOf(error), isCut: isCut(error) }
  }
}

async function changedAt($: EngineInterface, folder: string, entry: Entry): Promise<number> {
  if (entry.status === 'D') {
    return 0
  }
  const stat = await $.fs.stat(`${folder}/${entry.path}`).catch(() => null)
  return stat?.mtimeMs ?? 0
}

// Marks each folder's state as the pane showed it reviewed: the next look
// compares with it.
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
    times[folder] = { ...(times[folder] ?? { usedAt: now, tidiedAt: now }), baseAt: now }
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
    ok(await git($, 'init', store, { env: envOf(entry.git, entry.folder) }), "git couldn't make a folder for it")
  }
  await $.fs.write(`${entry.git}/config`, configOf(await $.fs.read(`${entry.git}/config`), entry.folder, excludesFile))
  const own = entry.kind === 'repository' ? await $.fs.read(`${entry.folder}/.git/info/exclude`).catch(() => '') : ''
  await $.fs.write(`${entry.git}/info/exclude`, excludeOf(entry.kind, own))

  if ((await inGit($, entry, 'base')).exitCode === 0) {
    return
  }
  looking.add(entry.folder)
  changed($)
  try {
    const tree = await record($, entry, true)
    ok(
      await inGit($, entry, 'refs', { stdin: `update refs/difnote/base ${tree}\nupdate refs/difnote/shown ${tree}\n` }),
      "git couldn't keep its state",
    )
    const now = await $.clock.now()
    times[entry.folder] = { baseAt: now, usedAt: now, tidiedAt: now }
    await saveTimes($)
  } finally {
    looking.delete(entry.folder)
  }
}

// Records the folder as it is now and answers the state's id. Files up to
// MOST_KEPT are kept whole; larger ones, those named like secrets and those
// git can't read, by a placeholder with their size and time. Repositories
// inside it are watched on their own.
async function record($: EngineInterface, entry: Watched, isFirst: boolean): Promise<string> {
  const others = ok(await inGit($, entry, 'others'), "git couldn't list its files")
  const listing = splitZ(others.stdout)
  const untracked = listing.filter(path => !path.endsWith('/'))
  if (others.isStdoutTruncated || untracked.length > MOST_FILES) {
    throw new Skip(`over ${MOST_FILES.toLocaleString('en-US')} files`)
  }
  for (const nested of listing.filter(path => path.endsWith('/')).slice(0, MOST_NESTED)) {
    follow($, `${entry.folder}/${nested.slice(0, -1)}`, 'repository')
  }

  const dirty = isFirst ? [] : splitZ(ok(await inGit($, entry, 'dirty'), "git couldn't compare its files").stdout)
  // A repository's files that its .gitignore matches but it tracks all the
  // same, which the private git folder would skip.
  const tracked = entry.kind === 'repository' ? await trackedOf($, entry.folder) : []
  const paths = [...new Set([...untracked, ...dirty, ...tracked])]
  const facts = await factsOf($, entry.folder, paths)
  let add: string[] = []
  const drop: string[] = []
  const marks: { path: string; text: string }[] = []
  for (const path of paths) {
    const fact = facts.get(path)
    if (fact?.kind === 'dir') {
      drop.push(path)
    } else if (fact !== undefined && (isSecret(path) || fact.size > MOST_KEPT)) {
      marks.push({ path, text: placeholderOf(isSecret(path) ? 'secret' : 'large', fact.size, fact.changedAt) })
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
    marks.push({ path, text: placeholderOf('unreadable', facts.get(path)?.size ?? 0, facts.get(path)?.changedAt ?? 0) })
  }
  if (drop.length > 0) {
    ok(await inGit($, entry, 'drop', { stdin: zOf(drop) }), "git couldn't record it")
  }
  if (marks.length > 0) {
    await mark($, entry, marks)
  }

  return ok(await inGit($, entry, 'tree'), "git couldn't record it").stdout.trim()
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

// Puts the placeholders into the record, each made into a git object once.
async function mark($: EngineInterface, entry: Watched, marks: readonly { path: string; text: string }[]) {
  const fresh = marks.filter(one => placeholders.get(`${entry.folder}/${one.path}`)?.text !== one.text)
  if (fresh.length > 0) {
    const ran = ok(await inGit($, entry, 'blobs', { stdin: blobsOf(fresh.map(one => one.text)) }), "git couldn't record it")
    const ids = ran.stdout.trim().split('\n')
    fresh.forEach((one, i) => placeholders.set(`${entry.folder}/${one.path}`, { text: one.text, id: ids[i] ?? '' }))
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
// record. git packs what's left at the next tidying.
async function letGo($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  for (const [folder, one] of Object.entries(times)) {
    const store = gitOf(folder)
    if (now - one.usedAt > UNUSED_MS) {
      const env = envOf(store, folder)
      await git($, 'refs', store, { stdin: 'delete refs/difnote/base\ndelete refs/difnote/shown\n', env }).catch(() => undefined)
      await git($, 'empty', store, { env }).catch(() => undefined)
      delete times[folder]
      emptied.add(folder)
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
    } else if ((await git($, 'gc', store, { timeoutMs: 300_000, env: envOf(store, folder) }).catch(() => null))?.exitCode === 0) {
      one.tidiedAt = now
    }
  }
  for (const folder of emptied) {
    await git($, 'gc', gitOf(folder), { timeoutMs: 300_000, env: envOf(gitOf(folder), folder) }).catch(() => undefined)
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

// Every git command difnote runs, each written out in full. They run in a
// private git folder (`--git-dir=.`), but `version` and `excludes`, which
// run in the session's folder, `top`, in the folder asked about, and
// `init`, in the folder that will hold the private one. What differs from
// call to call, paths and ids, goes on standard input. The README says when
// and why each runs.
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
    others: () => $.process.run(['git', '--git-dir=.', 'ls-files', '-z', '--others', '--exclude-standard'], options),
    dirty: () => $.process.run(['git', '--git-dir=.', 'diff-files', '-z', '--name-only'], options),
    add: () => $.process.run(['git', '--git-dir=.', 'update-index', '-z', '--add', '--remove', '--stdin'], options),
    drop: () => $.process.run(['git', '--git-dir=.', 'update-index', '-z', '--force-remove', '--stdin'], options),
    set: () => $.process.run(['git', '--git-dir=.', 'update-index', '-z', '--index-info'], options),
    blobs: () => $.process.run(['git', '--git-dir=.', 'fast-import', '--quiet', '--done'], options),
    tree: () => $.process.run(['git', '--git-dir=.', 'write-tree'], options),
    refs: () => $.process.run(['git', '--git-dir=.', 'update-ref', '--stdin'], options),
    base: () => $.process.run(['git', '--git-dir=.', 'rev-parse', '--verify', '--quiet', 'refs/difnote/base'], options),
    diff: () =>
      $.process.run(
        [
          'git',
          '--git-dir=.',
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
        ],
        options,
      ),
    sizes: () => $.process.run(['git', '--git-dir=.', 'cat-file', '--batch-check'], options),
    ignored: () => $.process.run(['git', '--git-dir=.', 'check-ignore', '-z', '--stdin'], options),
    empty: () => $.process.run(['git', '--git-dir=.', 'read-tree', '--empty'], options),
    gc: () => $.process.run(['git', '--git-dir=.', 'gc', '--quiet', '--prune=1.hour.ago'], options),
  } satisfies Record<Command, () => Promise<RunResult>>
  return commands[command]()
}

// A command in a folder's private git folder, again when another git holds
// a lock there, as another session's or a tidying, for up to 3 seconds.
const LOCK_TRIES = 10
const LOCK_MS = 300

async function inGit($: EngineInterface, entry: Watched, command: Command, init: Omit<Init, 'env'> = {}): Promise<RunResult> {
  for (let tries = 0; ; tries += 1) {
    const ran = await git($, command, entry.git, { ...init, env: envOf(entry.git, entry.folder) })
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
    // A pane Claude Code shows again after a restart looks at once.
    if (await isShown($)) {
      void refresh($).catch(() => undefined)
    }
    await $.command.register({
      name: NAME,
      description: 'Open or close difnote: review what changed since you last looked, and write notes for the prompt',
    })

    return next(e)
  })

  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    shownUpTo = null
    shownTrees = new Map()
    await readChanges($).catch(() => undefined)
    await readNotes($).catch(() => undefined)

    return next(e)
  })

  on('command.run', { command: NAME }, async $ => {
    await togglePane($).catch(() => undefined)

    return {}
  })

  // Before a change, the folders it is in are recorded, if they never were,
  // so it shows; after it, Claude's Edit or Write record joins the list, and
  // an open pane looks again, also after a shell command that failed, which
  // may have changed files all the same.
  on('tool.call', async ($, e, next) => {
    const { paths, isShell } = namedBy(e)
    const isRecorded = paths.length === 0 || (await beforeChange($, paths, isShell, WAIT_MS).catch(() => true))
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
      await update($, changes, list => (list.some(one => one.id === change.id) ? list : kept([...list, change]))).catch(() => undefined)
    }
    const found = isShell ? changedBy(ran.result) : []
    if (found.length > 0) {
      void beforeChange($, found, true, 0).catch(() => undefined)
    }
    if ((isShell || paths.length > 0) && (await isShown($))) {
      void refresh($).catch(() => undefined)
    }

    return ran
  })

  // A prompt the person sends Claude may end the review (see promptSent).
  on('prompt.submit', async ($, e, next) => {
    const entered = await next(e)
    if (entered.drop === undefined && e.origin.kind === 'composer' && !e.text.trimStart().startsWith('/')) {
      await promptSent($).catch(() => undefined)
    }

    return entered
  })

  // The ring is followed, for c, j and k; moving it off the note field, to
  // another row, closes the field.
  on('ui.focus', async ($, e, next) => {
    if (e.requestId === PANE && e.element !== undefined && e.element !== FIELD && !e.element.startsWith('key-') && e.element !== 'send') {
      ring = e.element
    }
    if (e.requestId === PANE && e.origin.kind === 'person' && e.element !== FIELD) {
      await update($, editing, () => null).catch(() => undefined)
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
      await forget($).catch(() => undefined)
    }

    return answered
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const list = await read($, changes)
    const files = listedFiles(await read($, diffs), list)
    const rows = rowsOf(files)
    const open = await read($, file)
    const shown = files.some(one => one.path === open) ? open : null
    const hunk = await read($, picking)
    const watching = await read($, watch)
    walk = walkOf({ files, rows, file: shown, picking: hunk })
    shownUpTo = list.at(-1)?.id ?? shownUpTo
    // A look of its own would be cut short by the next drawing: the pane
    // looks when it opens, after each change while shown, and on a key.
    shownTrees = looked?.trees ?? shownTrees

    return paneOf({
      ui,
      Input: 'Input' in ui ? ui.Input : undefined,
      columns: e.props.bodyColumns,
      colors,
      hasIcons,
      files,
      rows,
      watch: watching,
      isLooking: isLooking || watching.looking.length > 0,
      now: await $.clock.now(),
      file: shown,
      picking: hunk,
      notes: await read($, notes),
      editing: await read($, editing),
      open: path => void openFile($, path).catch(() => undefined),
      back: () => void goBack($).catch(() => undefined),
      pick: key => void togglePicking($, key).catch(() => undefined),
      write: row => void openField($, row).catch(() => undefined),
      save: (row, text) => void saveNote($, row, text).catch(() => undefined),
      move: step => void moveRing($, step).catch(() => undefined),
      note: () => void noteHere($).catch(() => undefined),
      send: () => void sendNotes($, rows).catch(() => undefined),
      reviewed: () => void markReviewed($).catch(() => undefined),
    })
  })
}
