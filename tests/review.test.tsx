import { describe, expect, test } from 'claude-code/testing'
import { changeOf, filesOf, fingerprintOf } from '../hooks/review'
import {
  CLOSER,
  CWD,
  DOC_TITLE,
  closeMark,
  codeOf,
  command,
  cursorOf,
  docTool,
  edit,
  fieldUnder,
  goTo,
  listOf,
  mount,
  moveTo,
  openFile,
  send,
  shownOf,
  started,
  textsOf,
  padsOf,
  wrapsOf,
  write,
} from './kit'
import type { Mounted } from './kit'

const A = `${CWD}/a.ts`
const B = `${CWD}/b.ts`
const FIVE = 'one\ntwo\nthree\nfour\nfive\n'

// The keys of a.ts's rows after Claude changed "two" to "TWO": a changed
// line's by its side, which of the lines with that text it is, and the text.
const FILE = `file:${A}`
const HUNK = `hunk:${A}:0:@-two`
const REMOVED = `line:${A}:0:-two`
const ADDED = `line:${A}:0:+TWO`

// The file icons, by default before each file: TypeScript's, and a .conf
// file's.
const TS = '\u{e628} '
const CONF = '\u{e615} '

// a.ts after Claude changed "two" to "TWO", as Claude Code's highlighter
// gets the hunk.
const TWO_HUNK = '@@ -1,5 +1,5 @@\n one\n-two\n+TWO\n three\n four\n five'

// Writes a note on the row the cursor is on, with c and the note field.
async function note(ui: Mounted, text: string) {
  await ui.press({ key: 'key-note' })
  await ui.input({ key: 'note-field', text })
}

describe('the list', () => {
  test('lists the files Claude changed since the start by name, with what each adds and removes', async ($, on) => {
    await started($, on, { files: { [A]: FIVE } })
    await write($, 't1', 'b.ts', 'hello\n')
    await edit($, 't2', 'a.ts', 'two', 'TWO')
    const ui = await mount($)

    expect((await textsOf(ui))[0]).toBe('since your last review · 2 files +2 −1')
    expect(await listOf(ui)).toEqual([`${TS}a.ts +1 −1`, `${TS}b.ts new`])
  })

  test("lists a subagent's change too", async ($, on) => {
    await started($, on, { files: { [A]: FIVE } })
    await edit($, 't1', 'a.ts', 'two', 'TWO', 'agent-1')
    const ui = await mount($)

    expect(await listOf(ui)).toEqual([`${TS}a.ts +1 −1`])
  })

  test("without git, says it sees only Claude's Edit and Write, and that there is nothing", async ($, on) => {
    await started($, on, { files: { [A]: FIVE } })
    const ui = await mount($)

    expect((await textsOf(ui)).slice(0, 2)).toEqual([
      'No changes from Claude since your last review.',
      " Without git, difnote sees only Claude's Edit and Write.",
    ])
  })

  test('leaves out a change held for review, which left the file as it was, and any other tool', () => {
    const held = { filePath: A, oldString: 'two', newString: 'TWO', originalFile: FIVE, structuredPatch: [], replaceAll: false, staged: true }

    expect(changeOf('t1', 'Edit', held)).toBeNull()
    expect(changeOf('t2', 'Read', { filePath: A, content: FIVE })).toBeNull()
  })

  test("takes the file after an Edit from Claude Code's own hunks, which can differ from the replacement", () => {
    const record = {
      filePath: A,
      oldString: 'two',
      newString: '',
      originalFile: 'one\ntwo\nthree\n',
      structuredPatch: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 2, lines: [' one', '-two', ' three'] }],
      replaceAll: false,
    }

    expect(changeOf('t1', 'Edit', record)?.after).toBe('one\nthree\n')
  })

  test('draws no file icons with the File icons option off', { options: { fileIcons: false } }, async ($, on) => {
    await started($, on, { files: { [A]: FIVE } })
    await edit($, 't1', 'a.ts', 'two', 'TWO')
    const ui = await mount($)

    expect(await listOf(ui)).toEqual(['a.ts +1 −1'])
  })

  test('lists files under a heading of their folder, folders first and by path, and one outside the session folder under its own', async ($, on) => {
    await started($, on)
    await write($, 't1', 'src/z.ts', 'z\n')
    await write($, 't2', 'a.ts', 'a\n')
    await write($, 't3', 'lib/b.ts', 'b\n')
    await write($, 't4', '/etc/demo.conf', 'x = 1\n')
    const ui = await mount($)

    expect(await listOf(ui)).toEqual([
      '~/app · 3 files',
      'lib/ · 1 file',
      `  ${TS}b.ts new`,
      'src/ · 1 file',
      `  ${TS}z.ts new`,
      `${TS}a.ts new`,
      '/etc · 1 file',
      `${CONF}demo.conf new`,
    ])
  })

  test("Enter on a folder's heading folds its files away, and again unfolds them, the cursor on the heading", async ($, on) => {
    await started($, on)
    await write($, 't1', 'src/z.ts', 'z\n')
    await write($, 't2', 'a.ts', 'a\n')
    const ui = await mount($)
    await goTo(ui, `dir:${CWD}|src`)

    await ui.press({ key: 'enter' })
    expect(await listOf(ui)).toEqual(['▸ src/ · 1 file', `${TS}a.ts new`])
    expect(await cursorOf(ui)).toBe(`dir:${CWD}|src`)
    await ui.press({ key: 'enter' })
    expect(await listOf(ui)).toEqual(['src/ · 1 file', `  ${TS}z.ts new`, `${TS}a.ts new`])
  })

  test('h on a file goes to its folder heading, and again folds it; l unfolds it', async ($, on) => {
    await started($, on)
    await write($, 't1', 'src/z.ts', 'z\n')
    const ui = await mount($)
    await goTo(ui, `file:${CWD}/src/z.ts`)

    await ui.press({ key: 'key-out' })
    expect(await cursorOf(ui)).toBe(`dir:${CWD}|src`)
    await ui.press({ key: 'key-out' })
    expect(await listOf(ui)).toEqual(['▸ src/ · 1 file'])
    await ui.press({ key: 'key-in' })
    expect(await listOf(ui)).toEqual(['src/ · 1 file', `  ${TS}z.ts new`])
  })
})

describe('a file opened in place', () => {
  test("Enter opens a file under its row: each hunk under its header, as Claude Code's highlighted diff, the cursor on its first changed line", async ($, on) => {
    await started($, on, { files: { [A]: FIVE } })
    await write($, 't1', 'b.ts', 'hello\n')
    await edit($, 't2', 'a.ts', 'two', 'TWO')
    const ui = await mount($)

    await openFile(ui, A)
    expect(await listOf(ui)).toEqual([`▾ ${TS}a.ts +1 −1 · 1/2`, `${TS}b.ts new`])
    expect(await shownOf(ui)).toContain('line 2 · +1 −1')
    expect(await cursorOf(ui)).toBe(REMOVED)
    await ui.press({ key: 'key-up' })
    expect(await cursorOf(ui)).toBe(HUNK)
    expect(await codeOf(ui)).toEqual([{ path: A, source: TWO_HUNK }])
  })

  test("the cursor's line is a piece of code of its own, beside the cursor's bar", async ($, on) => {
    await started($, on, { files: { [A]: FIVE } })
    await edit($, 't1', 'a.ts', 'two', 'TWO')
    const ui = await mount($)

    await openFile(ui, A)
    await goTo(ui, ADDED)
    expect(await codeOf(ui)).toEqual([
      { path: A, source: '@@ -1,2 +1,1 @@\n one\n-two' },
      { path: A, source: '@@ -2,0 +2,1 @@\n+TWO' },
      { path: A, source: '@@ -3,3 +3,3 @@\n three\n four\n five' },
    ])
  })

  test('pieces of a hunk crossing line 10 line up with its two-digit gutter', async ($, on) => {
    await started($, on, { files: { [A]: 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\nl11\nl12\n' } })
    await edit($, 't1', 'a.ts', 'l7', 'L7')
    const ui = await mount($)

    await openFile(ui, A)
    await goTo(ui, `line:${A}:0:+L7`)
    expect(await codeOf(ui)).toEqual([
      { path: A, source: '@@ -4,4 +4,3 @@\n l4\n l5\n l6\n-l7' },
      { path: A, source: '@@ -7,0 +7,1 @@\n+L7' },
      { path: A, source: '@@ -8,3 +8,3 @@\n l8\n l9\n l10' },
    ])
    expect(await padsOf(ui)).toEqual([1, 1, 0])
  })

  test('a hunk ending on line 9 keeps a one-digit gutter, as Claude Code draws it', async ($, on) => {
    await started($, on, { files: { [A]: 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\n' } })
    await edit($, 't1', 'a.ts', 'l7', 'L7')
    const ui = await mount($)

    await openFile(ui, A)
    await goTo(ui, `line:${A}:0:+L7`)
    expect(await padsOf(ui)).toEqual([0, 0, 0])
  })

  test('shows several changes to a file as one diff, from before the first to after the latest', async ($, on) => {
    await started($, on, { files: { [A]: FIVE } })
    await edit($, 't1', 'a.ts', 'two', 'TWO')
    await edit($, 't2', 'a.ts', 'TWO', 'Two')
    await edit($, 't3', 'a.ts', 'five', 'five\nsix')
    const ui = await mount($)

    await openFile(ui, A)
    await ui.press({ key: 'key-up' })
    expect(await codeOf(ui)).toEqual([{ path: A, source: '@@ -1,5 +1,6 @@\n one\n-two\n+Two\n three\n four\n five\n+six' }])
  })

  test('h from inside the open file closes it, the cursor back on its row, and Enter on its row closes it too', async ($, on) => {
    await started($, on, { files: { [A]: FIVE } })
    await write($, 't1', 'b.ts', 'hello\n')
    await edit($, 't2', 'a.ts', 'two', 'TWO')
    const ui = await mount($)

    await openFile(ui, A)
    await ui.press({ key: 'key-out' })
    expect(await cursorOf(ui)).toBe(FILE)
    expect(await codeOf(ui)).toEqual([])
    await ui.press({ key: 'enter' })
    await goTo(ui, FILE)
    await ui.press({ key: 'enter' })
    expect(await codeOf(ui)).toEqual([])
    expect(await cursorOf(ui)).toBe(FILE)
  })

  test('closing a file, from any place in the list, puts the cursor on the file it came from', async ($, on) => {
    await started($, on)
    await write($, 't1', 'a.ts', 'a\n')
    await write($, 't2', 'b.ts', 'b\n')
    await write($, 't3', 'c.ts', 'c\n')
    const ui = await mount($)

    for (const name of ['a.ts', 'b.ts', 'c.ts']) {
      await openFile(ui, `${CWD}/${name}`)
      await ui.press({ key: 'key-out' })
      expect(await cursorOf(ui)).toBe(`file:${CWD}/${name}`)
    }
  })

  test('opening a file closes the one open, and n opens the next, the last staying open', async ($, on) => {
    await started($, on)
    await write($, 't1', 'a.ts', 'a\n')
    await write($, 't2', 'b.ts', 'b\n')
    const ui = await mount($)

    await openFile(ui, A)
    await openFile(ui, B)
    expect((await codeOf(ui)).map(code => code.path)).toEqual([B])
    await openFile(ui, A)
    await ui.press({ key: 'key-next' })
    expect((await codeOf(ui)).map(code => code.path)).toEqual([B])
    expect(await ui.find({ key: 'key-next' })).toBeUndefined()
  })

  test("when Claude changes the cursor's line, the cursor goes to the open file's row", async ($, on) => {
    await started($, on, { files: { [A]: FIVE, [B]: FIVE } })
    await edit($, 't1', 'a.ts', 'two', 'TWO')
    await edit($, 't2', 'b.ts', 'two', 'TWO')
    const ui = await mount($)
    await openFile(ui, B)
    await goTo(ui, `line:${B}:0:+TWO`)

    await edit($, 't3', 'b.ts', 'TWO', 'Two')
    expect(await cursorOf(ui)).toBe(`file:${B}`)
  })

  test("lines wrap, and w cuts every line to one row but the cursor's", async ($, on) => {
    await started($, on, { files: { [A]: FIVE } })
    await edit($, 't1', 'a.ts', 'two', 'TWO')
    const ui = await mount($)
    await openFile(ui, A)

    expect(await wrapsOf(ui)).toEqual(['wrap', 'wrap', 'wrap'])
    await ui.press({ key: 'key-wrap' })
    expect(await wrapsOf(ui)).toEqual(['truncate-end', 'wrap', 'truncate-end'])
  })

  test('cuts a line past twelve rows, marking the cut', async ($, on) => {
    await started($, on)
    await write($, 't1', 'big.ts', `${'x'.repeat(2_000)}\n`)
    const ui = await mount($)

    await openFile(ui, `${CWD}/big.ts`)
    const [code] = await codeOf(ui)
    expect(String(code?.source).endsWith('…')).toBe(true)
    expect(String(code?.source).length).toBeLessThan(800)
  })

  test('keeps the summary above and the keys below a long file, the cursor in view, and its row on top once scrolled past', async ($, on) => {
    await started($, on)
    await write($, 't1', 'long.ts', Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n'))
    const ui = await mount($, 60, 14)
    await openFile(ui, `${CWD}/long.ts`)

    for (let i = 0; i < 40; i += 1) {
      await ui.press({ key: 'key-down' })
    }
    expect((await textsOf(ui))[0]).toBe('since your last review · 1 file +60 −0')
    expect(await cursorOf(ui)).toBe(`line:${CWD}/long.ts:0:+line 41`)
    expect((await codeOf(ui)).map(code => String(code.source))).toContain('@@ -0,0 +41,1 @@\n+line 41')
    expect(await ui.find({ key: 'sticky:file:/home/demo/app/long.ts' })).toBeDefined()
    expect(await ui.find({ key: 'enter' })).toBeDefined()
  })
})

describe('notes', () => {
  test('c writes a note on the line the cursor is on; it shows right under the line, and saving it empty removes it', async ($, on) => {
    await started($, on, { files: { [A]: FIVE } })
    await edit($, 't1', 'a.ts', 'two', 'TWO')
    const ui = await mount($)
    await openFile(ui, A)

    await goTo(ui, ADDED)
    await note(ui, 'Name this')
    await goTo(ui, HUNK)
    expect(await codeOf(ui)).toEqual([
      { path: A, source: '@@ -1,2 +1,2 @@\n one\n-two\n+TWO' },
      { path: A, source: '@@ -3,3 +3,3 @@\n three\n four\n five' },
    ])
    // The code is cut after the line, and the note drawn between.
    expect(await shownOf(ui)).toContain('✎ Name this')

    await goTo(ui, ADDED)
    await ui.press({ key: 'enter' })
    await ui.input({ key: 'note-field', text: '  ' })
    expect(await shownOf(ui)).not.toContain('✎ Name this')
  })

  test('j and k walk the files, and in the open file its hunk headers and changed lines, holding at the ends', async ($, on) => {
    await started($, on, { files: { [A]: FIVE } })
    await edit($, 't1', 'a.ts', 'two', 'TWO')
    await write($, 't2', 'b.ts', 'hello\n')
    const ui = await mount($)
    await openFile(ui, A)
    await goTo(ui, FILE)

    const walked: (string | undefined)[] = []
    for (let i = 0; i < 5; i += 1) {
      walked.push(await cursorOf(ui))
      await ui.press({ key: 'key-down' })
    }
    expect(walked).toEqual([FILE, HUNK, REMOVED, ADDED, `file:${B}`])
    expect(await cursorOf(ui)).toBe(`file:${B}`)
    await ui.press({ key: 'key-up' })
    expect(await cursorOf(ui)).toBe(ADDED)
  })

  test('s puts the notes into the prompt box after its draft, each anchored and quoted, in the order of the rows', async ($, on) => {
    const project = await started($, on, { files: { [A]: FIVE } })
    await edit($, 't1', 'a.ts', 'two', 'TWO')
    const ui = await mount($)
    await goTo(ui, FILE)
    await note(ui, 'Why this file?')
    await openFile(ui, A)
    await goTo(ui, HUNK)
    await note(ui, 'Smaller, please')
    await goTo(ui, ADDED)
    await note(ui, 'Name this')
    await goTo(ui, REMOVED)
    await note(ui, 'Keep the old one?')
    project.draft.text = 'Before you go on:'

    await ui.press({ key: 'send' })
    expect(project.draft.text).toBe(
      [
        'Before you go on:',
        'Notes on the changes:',
        'a.ts\nWhy this file?',
        'a.ts:2\n> -two\n> +TWO\nSmaller, please',
        'a.ts:2 (removed)\n> two\nKeep the old one?',
        'a.ts:2\n> TWO\nName this',
      ].join('\n\n'),
    )
    expect(await ui.find({ key: 'send' })).toBeUndefined()
  })

  test('a note on a hunk quotes its first three changed lines and an ellipsis; into an empty box the notes go alone', async ($, on) => {
    const project = await started($, on, { files: { [A]: FIVE } })
    await write($, 't1', 'a.ts', 'ONE\nTWO\nthree\nfour\nfive\n')
    const ui = await mount($)
    await openFile(ui, A)

    await goTo(ui, `hunk:${A}:0:@-one`)
    await note(ui, 'Why uppercase?')
    await ui.press({ key: 'send' })
    expect(project.draft.text).toBe('Notes on the changes:\n\na.ts:1-2\n> -one\n> -two\n> +ONE\n> …\nWhy uppercase?')
  })

  test('a note on a line Claude changed since says so, in the list and in the prompt, and comes last', async ($, on) => {
    const project = await started($, on, { files: { [A]: FIVE } })
    await edit($, 't1', 'a.ts', 'two', 'TWO')
    const ui = await mount($)
    await goTo(ui, FILE)
    await note(ui, 'Why this file?')
    await openFile(ui, A)
    await goTo(ui, ADDED)
    await note(ui, 'Name this')
    await ui.press({ key: 'key-out' })

    await edit($, 't2', 'a.ts', 'TWO', 'Two')
    expect(await shownOf(ui)).toContain('Notes on lines changed since: ✎ a.ts:2 · Name this')
    await ui.press({ key: 'send' })
    expect(project.draft.text).toBe('Notes on the changes:\n\na.ts\nWhy this file?\n\na.ts:2 (since changed)\n> TWO\nName this')
  })

  test('a note stays on its line when Claude adds lines above it, and the prompt gives the line its new number', async ($, on) => {
    const project = await started($, on, { files: { [A]: FIVE } })
    await edit($, 't1', 'a.ts', 'two', 'TWO')
    const ui = await mount($)
    await openFile(ui, A)
    await goTo(ui, ADDED)
    await note(ui, 'Name this')

    await edit($, 't2', 'a.ts', 'one', 'zero\none')
    await ui.press({ key: 'send' })
    expect(project.draft.text).toBe('Notes on the changes:\n\na.ts:3\n> TWO\nName this')
  })

  test('s numbers each note where its line is in the file now, as a formatter or the person left it', async ($, on) => {
    const project = await started($, on, { files: { [A]: FIVE } })
    await edit($, 't1', 'a.ts', 'two', 'TWO')
    const ui = await mount($)
    await openFile(ui, A)
    await goTo(ui, HUNK)
    await note(ui, 'Smaller, please')
    await goTo(ui, ADDED)
    await note(ui, 'Name this')
    await goTo(ui, REMOVED)
    await note(ui, 'Keep the old one?')

    project.files.set(A, `// header\n\n${project.files.get(A) ?? ''}`)
    await ui.press({ key: 'send' })
    expect(project.draft.text).toBe(
      [
        'Notes on the changes:',
        'a.ts:4\n> -two\n> +TWO\nSmaller, please',
        'a.ts:4 (removed)\n> two\nKeep the old one?',
        'a.ts:4\n> TWO\nName this',
      ].join('\n\n'),
    )
  })

  test('s marks a note on a line the file no longer has, numbered by the lines left around it', async ($, on) => {
    const project = await started($, on, { files: { [A]: FIVE } })
    await edit($, 't1', 'a.ts', 'two', 'TWO')
    const ui = await mount($)
    await openFile(ui, A)
    await goTo(ui, ADDED)
    await note(ui, 'Name this')

    project.files.set(A, '// header\none\nTwo\nthree\nfour\nfive\n')
    await ui.press({ key: 'send' })
    expect(project.draft.text).toBe('Notes on the changes:\n\na.ts:3 (since changed)\n> TWO\nName this')
  })

  test('s keeps the number a note had, and marks it, when none of its hunk is left in the file', async ($, on) => {
    const project = await started($, on, { files: { [A]: FIVE } })
    await edit($, 't1', 'a.ts', 'two', 'TWO')
    const ui = await mount($)
    await openFile(ui, A)
    await goTo(ui, HUNK)
    await note(ui, 'Smaller, please')

    project.files.set(A, 'all new\n')
    await ui.press({ key: 'send' })
    expect(project.draft.text).toBe('Notes on the changes:\n\na.ts:2 (since changed)\n> -two\n> +TWO\nSmaller, please')
  })

  test('s numbers a note on a line the file has many times by the nearest copy of its own hunk', async ($, on) => {
    const project = await started($, on, { files: { [A]: 'x\n}\ny\nz\n' } })
    await edit($, 't1', 'a.ts', 'y\n', 'y\n}\n')
    const ui = await mount($)
    await openFile(ui, A)
    await goTo(ui, `line:${A}:0:+}`)
    await note(ui, 'Close it here?')

    const after = project.files.get(A) ?? ''
    project.files.set(A, `h\n\n${after}${after}`)
    await ui.press({ key: 'send' })
    expect(project.draft.text).toBe('Notes on the changes:\n\na.ts:6\n> }\nClose it here?')
  })

  test('s moves notes with the lines left of a hunk someone changed after Claude: a line by its text, a hunk or a removed line by the nearest', async ($, on) => {
    const project = await started($, on, { files: { [A]: FIVE } })
    await edit($, 't1', 'a.ts', 'four', 'FOUR\nmore')
    const ui = await mount($)
    await openFile(ui, A)
    await goTo(ui, `hunk:${A}:0:@-four`)
    await note(ui, 'Smaller, please')
    await goTo(ui, `line:${A}:0:-four`)
    await note(ui, 'Keep the old one?')
    await goTo(ui, `line:${A}:0:+more`)
    await note(ui, 'Good')

    project.files.set(A, '// header\none\n// added\ntwo\nthree\nFour\nmore\nfive\n')
    await ui.press({ key: 'send' })
    expect(project.draft.text).toBe(
      [
        'Notes on the changes:',
        'a.ts:5-6\n> -four\n> +FOUR\n> +more\nSmaller, please',
        'a.ts:6 (removed)\n> four\nKeep the old one?',
        'a.ts:7\n> more\nGood',
      ].join('\n\n'),
    )
  })

  test('moving off the note field closes it', async ($, on) => {
    await started($, on, { files: { [A]: FIVE } })
    await edit($, 't1', 'a.ts', 'two', 'TWO')
    const ui = await mount($)
    await goTo(ui, FILE)
    await ui.press({ key: 'key-note' })
    await moveTo($, 'enter')

    expect(await fieldUnder(ui)).toBeUndefined()
  })

  test(
    'Esc steps back, taking the keyboard again each time: a note field closes with the note as it was, the open file closes, then the pane closes',
    { plugins: [CLOSER] },
    async ($, on) => {
      const project = await started($, on, { files: { [A]: FIVE } })
      await edit($, 't1', 'a.ts', 'two', 'TWO')
      const ui = await mount($)
      await openFile(ui, A)
      await goTo(ui, ADDED)
      await note(ui, 'Name this')
      await ui.press({ key: 'key-note' })

      await closeMark($)
      expect(await fieldUnder(ui)).toBeUndefined()
      expect(await shownOf(ui)).toContain('✎ Name this')
      await closeMark($)
      expect(await codeOf(ui)).toEqual([])
      expect(await cursorOf(ui)).toBe(FILE)
      expect(await listOf(ui)).toEqual([`${TS}a.ts +1 −1 ✎1`])
      expect(project.opened).toEqual([{ focus: true }, { focus: true }])
      expect(project.closed).toEqual([])
      await closeMark($)
      expect(project.closed).toEqual(['difnote'])
    },
  )

  test('under a dialog the prompt box takes nothing: the notes stay, and a toast says so', async ($, on) => {
    const project = await started($, on, { files: { [A]: FIVE } })
    await edit($, 't1', 'a.ts', 'two', 'TWO')
    const ui = await mount($)
    await goTo(ui, FILE)
    await note(ui, 'Why this file?')
    project.dialog.isOpen = true

    await ui.press({ key: 'send' })
    expect(project.draft.text).toBe('')
    expect(project.toasts).toEqual(["The prompt box can't take the notes right now; they are kept."])
    expect(await listOf(ui)).toEqual([`${TS}a.ts +1 −1 ✎1`])
  })
})

describe('the review', () => {
  test('sending your notes clears nothing: the files stay listed until you mark them reviewed', async ($, on) => {
    const project = await started($, on, { files: { [A]: FIVE } })
    await edit($, 't1', 'a.ts', 'two', 'TWO')
    const ui = await mount($)
    await goTo(ui, FILE)
    await note(ui, 'Why this file?')
    await ui.press({ key: 'send' })

    await send($, `${project.draft.text}\nAnd go on.`)
    await write($, 't2', 'b.ts', 'hello\n')
    expect(await listOf(ui)).toEqual([`${TS}a.ts +1 −1`, `${TS}b.ts new`])
    expect(project.store.get('baselines')).toBeUndefined()
  })

  test('r ends the review: what Claude changes next starts the next one, and where it ended is kept for a restart', async ($, on) => {
    const project = await started($, on, { files: { [A]: FIVE } })
    await edit($, 't1', 'a.ts', 'two', 'TWO')
    const ui = await mount($)

    await ui.press({ key: 'key-reviewed' })
    await write($, 't2', 'b.ts', 'hello\n')
    expect(await listOf(ui)).toEqual([`${TS}b.ts new`])
    expect(project.store.get('baselines')).toEqual({ 'session-1': 't1' })
  })

  test('stays open through your own prompts and slash commands', async ($, on) => {
    await started($, on, { files: { [A]: FIVE } })
    await edit($, 't1', 'a.ts', 'two', 'TWO')
    const ui = await mount($)

    await send($, 'Go on')
    await send($, '/compact')
    expect(await listOf(ui)).toEqual([`${TS}a.ts +1 −1`])
  })

  const editRecord = {
    filePath: A,
    oldString: 'two',
    newString: 'TWO',
    originalFile: FIVE,
    structuredPatch: [],
    userModified: false,
    replaceAll: false,
  }
  const writeRecord = { type: 'create', filePath: `${CWD}/b.ts`, content: 'hello\n', structuredPatch: [], originalFile: null }
  const twoChanges = [
    {
      role: 'assistant' as const,
      text: '',
      toolUses: [
        { tool_use_id: 't1', tool: 'Edit', input: {}, result: editRecord },
        { tool_use_id: 't2', tool: 'Write', input: {}, result: writeRecord },
      ],
    },
  ]

  test('after a restart, takes up where the last review ended', async ($, on) => {
    await started($, on, { messages: twoChanges, stored: { baselines: { 'session-1': 't1' } } })

    expect(await listOf(await mount($))).toEqual([`${TS}b.ts new`])
  })

  test('after a restart, takes up the files marked viewed, kept for the session folder', async ($, on) => {
    const change = changeOf('t2', 'Write', writeRecord)
    const [file] = filesOf(change === null ? [] : [change], CWD)
    const marks = { [CWD]: { [B]: file === undefined ? '' : fingerprintOf(file) } }
    await started($, on, { messages: twoChanges, stored: { baselines: { 'session-1': 't1' }, viewed: marks } })

    expect(await listOf(await mount($))).toEqual([`✓ b.ts new`])
  })

  test('after /branch, takes up where the review ended in the conversation it branched from', async ($, on) => {
    await started($, on, { messages: twoChanges, stored: { baselines: { 'parent-session': 't1' } } })

    expect(await listOf(await mount($))).toEqual([`${TS}b.ts new`])
  })
})

describe('Google Docs', () => {
  const LINK = 'https://docs.google.com/document/d/doc-1/edit'

  test(
    'lists a doc Claude edited, by the title it read, and says how it was edited and where to review it',
    { options: { fileIcons: false } },
    async ($, on) => {
      await started($, on)
      await docTool($, 't1', 'get_document', { document: 'doc-1' })
      await docTool($, 't2', 'edit_document', { document: 'doc-1', ops: [] })
      await docTool($, 't3', 'edit_document', { document: `${LINK}?tab=t.0`, mode: 'direct', ops: [] })
      const ui = await mount($)

      expect(await listOf(ui)).toEqual(['Google Docs · 1 file', `${DOC_TITLE} Google Doc · 2 edits`])
      await openFile(ui, LINK)
      expect(await shownOf(ui)).toContain(
        'In Google Docs: 1 edit as suggestions, 1 edit made directly. Review it there, where suggestions wait for you and version history keeps the rest:',
      )
      expect(await shownOf(ui)).toContain(LINK)
    },
  )

  test(
    'names a doc by the title Claude read after editing it, and knows it by any of its links',
    { options: { fileIcons: false } },
    async ($, on) => {
      await started($, on)
      await docTool($, 't1', 'edit_document', { document: 'https://docs.google.com/document/u/0/d/doc-1/edit', ops: [] })
      await docTool($, 't2', 'edit_document', { document: 'doc-1', ops: [] })
      await docTool($, 't3', 'get_document', { document: 'doc-1' })

      expect(await listOf(await mount($))).toEqual(['Google Docs · 1 file', `${DOC_TITLE} Google Doc · 2 edits`])
    },
  )

  test(
    "leaves out a dry run and an edit the server refused, and names a doc it didn't read by its id",
    { options: { fileIcons: false } },
    async ($, on) => {
      await started($, on)
      await docTool($, 't1', 'edit_document', { document: 'doc-1', dry_run: true, ops: [] })
      await docTool($, 't2', 'edit_document', { document: 'missing', ops: [] })
      await docTool($, 't3', 'create_document', { title: 'Plan' })
      await docTool($, 't4', 'edit_document', { document: 'doc-1', mode: 'comment', ops: [] })

      expect(await listOf(await mount($))).toEqual(['Google Docs · 2 files', 'Plan Google Doc · 1 edit', 'doc-1 Google Doc · 1 edit'])
    },
  )

  test("a note on a doc goes into the prompt with the doc's title and link", async ($, on) => {
    const project = await started($, on)
    await docTool($, 't1', 'get_document', { document: 'doc-1' })
    await docTool($, 't2', 'edit_document', { document: 'doc-1', ops: [] })
    const ui = await mount($)
    await goTo(ui, `file:${LINK}`)
    await note(ui, 'Keep the old heading')

    await ui.press({ key: 'send' })
    expect(project.draft.text).toBe(`Notes on the changes:\n\n${DOC_TITLE} (${LINK})\nKeep the old heading`)
  })

  test(
    'takes up the docs edited since the last review after a restart, each edit in the mode the server answered',
    { options: { fileIcons: false } },
    async ($, on) => {
      const uses = [
        {
          tool_use_id: 't1',
          tool: 'mcp__google-docs__get_document',
          input: { document: 'doc-1' },
          result: [{ type: 'text', text: `${DOC_TITLE}\n${LINK}\nrevision r1` }],
        },
        { tool_use_id: 't2', tool: 'mcp__google-docs__edit_document', input: { document: 'doc-1' }, result: '{"mode":"direct","ops_applied":1}' },
      ]
      await started($, on, { messages: [{ role: 'assistant', text: '', toolUses: uses }] })
      const ui = await mount($)

      expect(await listOf(ui)).toEqual(['Google Docs · 1 file', `${DOC_TITLE} Google Doc · 1 edit`])
      await openFile(ui, LINK)
      expect(await shownOf(ui)).toContain(
        'In Google Docs: 1 edit made directly. Review it there, where suggestions wait for you and version history keeps the rest:',
      )
    },
  )
})

describe('/resume', () => {
  test("takes up the resumed conversation's changes", async ($, on) => {
    const project = await started($, on)
    const writeRecord = { type: 'create', filePath: `${CWD}/b.ts`, content: 'hello\n', structuredPatch: [], originalFile: null }
    project.messages = [{ role: 'assistant', text: '', toolUses: [{ tool_use_id: 't9', tool: 'Write', input: {}, result: writeRecord }] }]

    await $.classic.SessionStart({ source: 'resume' })
    expect(await listOf(await mount($))).toEqual([`${TS}b.ts new`])
  })
})

describe('/difnote', () => {
  test('gives the pane shown the keyboard back rather than closing it, the open file and cursor kept', async ($, on) => {
    const project = await started($, on, { files: { [A]: FIVE }, panes: [{ isShown: true }] })
    await edit($, 't1', 'a.ts', 'two', 'TWO')
    const ui = await mount($)
    await openFile(ui, A)
    await goTo(ui, ADDED)

    await command($)
    expect(project.closed).toEqual([])
    expect(project.opened).toEqual([{ focus: true }])
    // The cursor on a changed line: the file is still open.
    expect(await cursorOf(ui)).toBe(ADDED)
  })

  test('brings the pane to the front when another is shown over it', async ($, on) => {
    const project = await started($, on, { panes: [{ isShown: false }] })
    await command($)
    expect(project.opened).toEqual([{ focus: true }])
  })
})
