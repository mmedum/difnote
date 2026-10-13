// One hunk of a unified diff, as Claude Code's Edit and Write results
// record theirs: where it starts and how many lines it spans on each side,
// and its lines, each led by ' ', '-' or '+'.
export type Hunk = {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

// One of Claude's changes to a file, as its Edit or Write result records
// it: the call's id, the file's path, the file before the change and after
// it (null where Claude Code kept no copy, as for a file too large), whether
// the change created the file, and its own hunks. For an edit of a Google
// Doc, its link as the path, no text, and how it was edited (`doc`).
export type Change = {
  id: string
  path: string
  before: string | null
  after: string | null
  isCreate: boolean
  hunks: Hunk[]
  doc: DocEdit | null
}

// How Claude edited a Google Doc: as suggestions, directly, as comments, by
// creating it, or by accepting or rejecting suggestions; and its title,
// where known.
export type DocEdit = { how: 'suggest' | 'direct' | 'comment' | 'create' | 'review'; title: string | null }

// A note the person wrote: what it is on (a row's key), its anchor and the
// code it quotes as the prompt will carry them, its file, and its words.
export type Note = {
  target: string
  path: string
  anchor: string
  quote: string[]
  text: string
}

// A changed file as the pane lists it: its path, and as written for the
// person; whether it is new or gone; its hunks and how many lines they add
// and remove; why it has no lines, if so; and when it last changed, for the
// list's order (0 where unknown, as for a file that is gone). A Google Doc
// Claude edited is listed too, by its link, with how each edit was made
// (`doc`), and reviewed in Google Docs.
export type FileDiff = {
  path: string
  shown: string
  isCreate: boolean
  isDelete: boolean
  hunks: Hunk[]
  added: number
  removed: number
  bare: Bare | null
  changedAt: number
  doc: DocEdit['how'][] | null
}

// A file drawn without lines: binary, larger than difnote keeps, named like
// a secret, or one git couldn't read, of which difnote keeps no copy; or one
// whose lines didn't fit in what git can hand difnote at once. Its size in
// bytes before and after, null on a side where it didn't exist or isn't
// known.
export type Bare = { why: 'binary' | 'large' | 'secret' | 'unreadable' | 'cut'; before: number | null; after: number | null }

// What difnote watches: whether git runs here (without it, only Claude's
// Edit and Write show); when the oldest state the pane compares against was
// recorded, null before any; the folders being recorded for the first time;
// the folders it doesn't watch, with why; the folders it looks at only
// after Claude's changes or a key, as looking at them is slow; the folders
// outside the session's that earlier sessions here left changes in, with
// when one last used them; the folders emptied at the session's start
// that still held changes not reviewed; the folders the list groups files
// under, the session's first; and the home folder, written ~ in them.
export type Watch = {
  hasGit: boolean
  since: number | null
  looking: string[]
  skipped: { folder: string; why: string }[]
  slow: string[]
  carried: { folder: string; usedAt: number }[]
  lost: string[]
  roots: string[]
  home: string | null
}

// Where the person is in the pane's list: the file open under its row
// (null for none), the row the cursor is on, by its key, the first row the
// window shows as asked, whether lines other than the cursor's are cut to
// one row, and the folders whose files are folded away.
export type Place = { open: string | null; cursor: string | null; top: number; isCompact: boolean; closed: string[] }

declare module 'claude-code' {
  interface PluginState {
    difnote: {
      // The changed files in the folders difnote watches, as last looked at.
      diffs: FileDiff[]
      // What difnote watches.
      watch: Watch
      // Claude's Edit and Write changes since the person last reviewed,
      // oldest first: what shows for files outside the folders watched.
      changes: Change[]
      // The person's notes, in the order written; kept in the store too,
      // until they go into the prompt box.
      notes: Note[]
      // The row whose note field is open; null while none is.
      editing: string | null
      // Where the person is in the list: the file open under its row, the
      // row the cursor is on, the window's first row, whether lines are cut,
      // and the folders closed.
      place: Place
      // The files the person marked viewed, by path, each with the
      // fingerprint of its change when marked: a file is viewed while its
      // change is still that one.
      viewed: Record<string, string>
    }
  }
}
