import { describe, expect, test } from 'claude-code/testing'
import { changeOf } from '../hooks/review'
import {
  CLOSER,
  CWD,
  DOC_TITLE,
  buttonsOf,
  closeMark,
  codeOf,
  command,
  docTool,
  edit,
  fieldUnder,
  mount,
  moveTo,
  send,
  started,
  textsOf,
  write,
} from './kit'
import type { Mounted } from './kit'

const A = `${CWD}/a.ts`
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
  test('lists the files Claude changed since the start, the one changed last first, with what each adds and removes', async ($, on) => {
    await started($, on, { files: { [A]: FIVE } })
    await edit($, 't1', 'a.ts', 'two', 'TWO')
    await write($, 't2', 'b.ts', 'hello\n')
    const ui = await mount($)

    expect((await textsOf(ui))[0]).toBe('since your last review · 2 files +2 −1')
    expect(await buttonsOf(ui, 'file:')).toEqual([`${TS}b.ts new`, `${TS}a.ts +1 −1`])
  })

  test("lists a subagent's change too", async ($, on) => {
    await started($, on, { files: { [A]: FIVE } })
    await edit($, 't1', 'a.ts', 'two', 'TWO', 'agent-1')
    const ui = await mount($)

    expect(await buttonsOf(ui, 'file:')).toEqual([`${TS}a.ts +1 −1`])
  })

  test("without git, says it sees only Claude's Edit and Write, and that there is nothing", async ($, on) => {
    await started($, on, { files: { [A]: FIVE } })
    const ui = await mount($)

    expect(await textsOf(ui)).toEqual(['No changes from Claude since your last review.', "Without git, difnote sees only Claude's Edit and Write."])
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

    expect(await buttonsOf(ui, 'file:')).toEqual(['a.ts +1 −1'])
  })

  test('writes a path outside the session folder in full', async ($, on) => {
    await started($, on)
    await write($, 't1', '/etc/demo.conf', 'x = 1\n')
    const ui = await mount($)

    expect(await buttonsOf(ui, 'file:')).toEqual([`${CONF}/etc/demo.conf new`])
  })
})

describe('a file', () => {
  test("Enter opens a file: each hunk under its header, as Claude Code's highlighted diff of that file, then the next file", async ($, on) => {
    await started($, on, { files: { [A]: FIVE } })
    await write($, 't1', 'b.ts', 'hello\n')
    await edit($, 't2', 'a.ts', 'two', 'TWO')
    const ui = await mount($)

    await ui.press({ key: FILE })
    expect((await ui.find({ key: FILE }))?.text).toBe(`${TS}a.ts +1 −1 · 1/2`)
    expect(await textsOf(ui)).toContain('line 2 · +1 −1')
    expect(await codeOf(ui)).toEqual([{ path: A, source: TWO_HUNK }])
    expect((await ui.find({ key: 'next' }))?.text).toBe('next: b.ts')
  })

  test('shows several changes to a file as one diff, from before the first to after the latest', async ($, on) => {
    await started($, on, { files: { [A]: FIVE } })
    await edit($, 't1', 'a.ts', 'two', 'TWO')
    await edit($, 't2', 'a.ts', 'TWO', 'Two')
    await edit($, 't3', 'a.ts', 'five', 'five\nsix')
    const ui = await mount($)

    await ui.press({ key: FILE })
    expect(await codeOf(ui)).toEqual([{ path: A, source: '@@ -1,5 +1,6 @@\n one\n-two\n+Two\n three\n four\n five\n+six' }])
  })

  test('opens a file with the cursor on its first hunk; h goes back to the list, the cursor on the file it left', async ($, on) => {
    await started($, on, { files: { [A]: FIVE } })
    await edit($, 't1', 'a.ts', 'two', 'TWO')
    const ui = await mount($)

    await ui.press({ key: FILE })
    await ui.press({ key: 'key-note' })
    expect(await fieldUnder(ui)).toBe(HUNK)
    await ui.press({ key: 'back' })
    expect(await buttonsOf(ui, 'file:')).toEqual([`${TS}a.ts +1 −1`])
    await ui.press({ key: 'key-note' })
    expect(await fieldUnder(ui)).toBe(FILE)
  })

  test('draws no hunk past 60,000 characters of code, and says how many it left out', async ($, on) => {
    await started($, on)
    await write($, 't1', 'big.ts', `${'x'.repeat(61_000)}\n`)
    const ui = await mount($)

    await ui.press({ key: `file:${CWD}/big.ts` })
    expect(await codeOf(ui)).toEqual([])
    expect(await textsOf(ui)).toContain('+1 more hunk, too large to draw')
  })

  test('Enter on a hunk header puts a cursor column beside its code, which keeps its colors, the cursor on the first changed line; again, takes it away', async ($, on) => {
    await started($, on, { files: { [A]: FIVE } })
    await edit($, 't1', 'a.ts', 'two', 'TWO')
    const ui = await mount($)
    await ui.press({ key: FILE })

    await ui.press({ key: HUNK })
    expect(await buttonsOf(ui, 'line:')).toEqual(['›', '›'])
    expect(await codeOf(ui)).toEqual([{ path: A, source: TWO_HUNK }])
    await ui.press({ key: 'key-note' })
    expect(await fieldUnder(ui)).toBe(REMOVED)
    await ui.press({ key: HUNK })
    expect(await buttonsOf(ui, 'line:')).toEqual([])
  })

  test("the cursor column reaches a hunk's first 300 lines", async ($, on) => {
    await started($, on)
    await write($, 't1', 'long.ts', Array.from({ length: 310 }, (_, i) => `line ${i + 1}`).join('\n'))
    const ui = await mount($)
    await ui.press({ key: `file:${CWD}/long.ts` })

    await ui.press({ key: `hunk:${CWD}/long.ts:0:@+line 1` })
    expect((await buttonsOf(ui, 'line:')).length).toBe(300)
  })
})

describe('notes', () => {
  test('c writes a note on the line the cursor is on; it shows right under the line, its mark changed, and saving it empty removes it', async ($, on) => {
    await started($, on, { files: { [A]: FIVE } })
    await edit($, 't1', 'a.ts', 'two', 'TWO')
    const ui = await mount($)
    await ui.press({ key: FILE })
    await ui.press({ key: HUNK })

    await moveTo($, ADDED)
    await note(ui, 'Name this')
    expect(await codeOf(ui)).toEqual([
      { path: A, source: '@@ -1,2 +1,2 @@\n one\n-two\n+TWO' },
      { path: A, source: '@@ -3,3 +3,3 @@\n three\n four\n five' },
    ])
    expect(await textsOf(ui)).toContain('    ✎ Name this')
    expect(await buttonsOf(ui, 'line:')).toEqual(['›', '✎'])

    await ui.press({ key: ADDED })
    await ui.input({ key: 'note-field', text: '  ' })
    expect((await textsOf(ui)).filter(text => text.includes('✎') || text.startsWith('│'))).toEqual([])
  })

  test('j and k walk the files in the list, stopping at the ends, and in a file its title and hunks', async ($, on) => {
    await started($, on, { files: { [A]: FIVE } })
    await edit($, 't1', 'a.ts', 'two', 'TWO')
    await write($, 't2', 'b.ts', 'hello\n')
    const ui = await mount($)

    for (const key of ['key-next', 'key-next', 'key-next']) {
      await ui.press({ key })
    }
    await ui.press({ key: 'key-note' })
    expect(await fieldUnder(ui)).toBe(FILE)
    await ui.press({ key: 'key-previous' })
    await ui.press({ key: 'key-note' })
    expect(await fieldUnder(ui)).toBe(`file:${CWD}/b.ts`)

    await ui.press({ key: FILE })
    await ui.press({ key: 'key-previous' })
    await ui.press({ key: 'key-note' })
    expect(await fieldUnder(ui)).toBe(FILE)
  })

  test('s puts the notes into the prompt box after its draft, each anchored and quoted, in the order of the rows', async ($, on) => {
    const project = await started($, on, { files: { [A]: FIVE } })
    await edit($, 't1', 'a.ts', 'two', 'TWO')
    const ui = await mount($)
    await moveTo($, FILE)
    await note(ui, 'Why this file?')
    await ui.press({ key: FILE })
    await moveTo($, HUNK)
    await note(ui, 'Smaller, please')
    await ui.press({ key: HUNK })
    await moveTo($, ADDED)
    await note(ui, 'Name this')
    await moveTo($, REMOVED)
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
    await ui.press({ key: FILE })

    await moveTo($, `hunk:${A}:0:@-one`)
    await note(ui, 'Why uppercase?')
    await ui.press({ key: 'send' })
    expect(project.draft.text).toBe('Notes on the changes:\n\na.ts:1-2\n> -one\n> -two\n> +ONE\n> …\nWhy uppercase?')
  })

  test('a note on a line Claude changed since says so, in the list and in the prompt, and comes last', async ($, on) => {
    const project = await started($, on, { files: { [A]: FIVE } })
    await edit($, 't1', 'a.ts', 'two', 'TWO')
    const ui = await mount($)
    await moveTo($, FILE)
    await note(ui, 'Why this file?')
    await ui.press({ key: FILE })
    await ui.press({ key: HUNK })
    await moveTo($, ADDED)
    await note(ui, 'Name this')
    await ui.press({ key: 'back' })
    await ui.press({ key: 'back' })

    await edit($, 't2', 'a.ts', 'TWO', 'Two')
    expect(await textsOf(ui)).toContain('  ✎ a.ts:2 · Name this')
    await ui.press({ key: 'send' })
    expect(project.draft.text).toBe('Notes on the changes:\n\na.ts\nWhy this file?\n\na.ts:2 (since changed)\n> TWO\nName this')
  })

  test('a note stays on its line when Claude adds lines above it, and the prompt gives the line its new number', async ($, on) => {
    const project = await started($, on, { files: { [A]: FIVE } })
    await edit($, 't1', 'a.ts', 'two', 'TWO')
    const ui = await mount($)
    await ui.press({ key: FILE })
    await ui.press({ key: HUNK })
    await moveTo($, ADDED)
    await note(ui, 'Name this')

    await edit($, 't2', 'a.ts', 'one', 'zero\none')
    await ui.press({ key: 'send' })
    expect(project.draft.text).toBe('Notes on the changes:\n\na.ts:3\n> TWO\nName this')
  })

  test('s numbers each note where its line is in the file now, as a formatter or the person left it', async ($, on) => {
    const project = await started($, on, { files: { [A]: FIVE } })
    await edit($, 't1', 'a.ts', 'two', 'TWO')
    const ui = await mount($)
    await ui.press({ key: FILE })
    await moveTo($, HUNK)
    await note(ui, 'Smaller, please')
    await ui.press({ key: HUNK })
    await moveTo($, ADDED)
    await note(ui, 'Name this')
    await moveTo($, REMOVED)
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
    await ui.press({ key: FILE })
    await ui.press({ key: HUNK })
    await moveTo($, ADDED)
    await note(ui, 'Name this')

    project.files.set(A, '// header\none\nTwo\nthree\nfour\nfive\n')
    await ui.press({ key: 'send' })
    expect(project.draft.text).toBe('Notes on the changes:\n\na.ts:3 (since changed)\n> TWO\nName this')
  })

  test('s keeps the number a note had, and marks it, when none of its hunk is left in the file', async ($, on) => {
    const project = await started($, on, { files: { [A]: FIVE } })
    await edit($, 't1', 'a.ts', 'two', 'TWO')
    const ui = await mount($)
    await ui.press({ key: FILE })
    await moveTo($, HUNK)
    await note(ui, 'Smaller, please')

    project.files.set(A, 'all new\n')
    await ui.press({ key: 'send' })
    expect(project.draft.text).toBe('Notes on the changes:\n\na.ts:2 (since changed)\n> -two\n> +TWO\nSmaller, please')
  })

  test('s numbers a note on a line the file has many times by the nearest copy of its own hunk', async ($, on) => {
    const project = await started($, on, { files: { [A]: 'x\n}\ny\nz\n' } })
    await edit($, 't1', 'a.ts', 'y\n', 'y\n}\n')
    const ui = await mount($)
    await ui.press({ key: FILE })
    await ui.press({ key: `hunk:${A}:0:@+}` })
    await moveTo($, `line:${A}:0:+}`)
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
    await ui.press({ key: FILE })
    await moveTo($, `hunk:${A}:0:@-four`)
    await note(ui, 'Smaller, please')
    await ui.press({ key: `hunk:${A}:0:@-four` })
    await moveTo($, `line:${A}:0:-four`)
    await note(ui, 'Keep the old one?')
    await moveTo($, `line:${A}:0:+more`)
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
    await moveTo($, FILE)
    await ui.press({ key: 'key-note' })
    await moveTo($, 'key-next')

    expect(await fieldUnder(ui)).toBeUndefined()
  })

  test(
    'Esc steps back, taking the keyboard again each time: a note field closes with the note as it was, picking stops, the file goes back to the list, then the pane closes',
    { plugins: [CLOSER] },
    async ($, on) => {
      const project = await started($, on, { files: { [A]: FIVE } })
      await edit($, 't1', 'a.ts', 'two', 'TWO')
      const ui = await mount($)
      await ui.press({ key: FILE })
      await ui.press({ key: HUNK })
      await moveTo($, ADDED)
      await note(ui, 'Name this')
      await ui.press({ key: 'key-note' })

      await closeMark($)
      expect(await fieldUnder(ui)).toBeUndefined()
      expect(await textsOf(ui)).toContain('    ✎ Name this')
      await closeMark($)
      expect(await buttonsOf(ui, 'line:')).toEqual([])
      await closeMark($)
      expect(await buttonsOf(ui, 'file:')).toEqual([`${TS}a.ts +1 −1 ✎1`])
      expect(project.opened).toEqual([{ focus: true }, { focus: true }, { focus: true }])
      expect(project.closed).toEqual([])
      await closeMark($)
      expect(project.closed).toEqual(['difnote'])
    },
  )

  test('under a dialog the prompt box takes nothing: the notes stay, and a toast says so', async ($, on) => {
    const project = await started($, on, { files: { [A]: FIVE } })
    await edit($, 't1', 'a.ts', 'two', 'TWO')
    const ui = await mount($)
    await moveTo($, FILE)
    await note(ui, 'Why this file?')
    project.dialog.isOpen = true

    await ui.press({ key: 'send' })
    expect(project.draft.text).toBe('')
    expect(project.toasts).toEqual(["The prompt box can't take the notes right now; they are kept."])
    expect(await buttonsOf(ui, 'file:')).toEqual([`${TS}a.ts +1 −1 ✎1`])
  })
})

describe('the review', () => {
  test('ends when you send Claude your own prompt after the pane showed it: what Claude changes next starts the next one', async ($, on) => {
    const project = await started($, on, { files: { [A]: FIVE } })
    await edit($, 't1', 'a.ts', 'two', 'TWO')
    await (await mount($)).unmount()

    await send($, 'Thanks, go on')
    await write($, 't2', 'b.ts', 'hello\n')
    expect(await buttonsOf(await mount($), 'file:')).toEqual([`${TS}b.ts new`])
    expect(project.store.get('baselines')).toEqual({ 'session-1': 't1' })
  })

  test('stays open through a slash command, while notes wait for the prompt box, and while the pane never showed it', async ($, on) => {
    await started($, on, { files: { [A]: FIVE } })
    await edit($, 't1', 'a.ts', 'two', 'TWO')
    await send($, 'Not looked at yet')
    const ui = await mount($)
    await send($, '/compact')
    await moveTo($, FILE)
    await note(ui, 'Why this file?')
    await send($, 'Go on')

    expect(await buttonsOf(ui, 'file:')).toEqual([`${TS}a.ts +1 −1 ✎1`])
  })

  test('a prompt that something beneath refused, so Claude never got it, leaves the review open', async ($, on) => {
    await started($, on, { files: { [A]: FIVE }, refused: ['Blocked'] })
    await edit($, 't1', 'a.ts', 'two', 'TWO')
    const ui = await mount($)

    await send($, 'Blocked')
    expect(await buttonsOf(ui, 'file:')).toEqual([`${TS}a.ts +1 −1`])
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

    expect(await buttonsOf(await mount($), 'file:')).toEqual([`${TS}b.ts new`])
  })

  test('after /branch, takes up where the review ended in the conversation it branched from', async ($, on) => {
    await started($, on, { messages: twoChanges, stored: { baselines: { 'parent-session': 't1' } } })

    expect(await buttonsOf(await mount($), 'file:')).toEqual([`${TS}b.ts new`])
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

      expect(await buttonsOf(ui, 'file:')).toEqual([`${DOC_TITLE} Google Doc · 2 edits`])
      await ui.press({ key: `file:${LINK}` })
      expect(await textsOf(ui)).toContain(
        'In Google Docs: 1 edit as suggestions, 1 edit made directly. Review it there, where suggestions wait for you and version history keeps the rest:',
      )
      expect(await textsOf(ui)).toContain(LINK)
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

      expect(await buttonsOf(await mount($), 'file:')).toEqual([`${DOC_TITLE} Google Doc · 2 edits`])
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

      expect(await buttonsOf(await mount($), 'file:')).toEqual(['doc-1 Google Doc · 1 edit', 'Plan Google Doc · 1 edit'])
    },
  )

  test("a note on a doc goes into the prompt with the doc's title and link", async ($, on) => {
    const project = await started($, on)
    await docTool($, 't1', 'get_document', { document: 'doc-1' })
    await docTool($, 't2', 'edit_document', { document: 'doc-1', ops: [] })
    const ui = await mount($)
    await moveTo($, `file:${LINK}`)
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

      expect(await buttonsOf(ui, 'file:')).toEqual([`${DOC_TITLE} Google Doc · 1 edit`])
      await ui.press({ key: `file:${LINK}` })
      expect(await textsOf(ui)).toContain(
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
    expect(await buttonsOf(await mount($), 'file:')).toEqual([`${TS}b.ts new`])
  })
})

describe('/difnote', () => {
  test('opens the pane with the keyboard, and closes it when it is the one shown', async ($, on) => {
    const project = await started($, on, { panes: [{ isShown: true }] })
    await command($)
    expect(project.closed).toEqual(['difnote'])
    expect(project.opened).toEqual([])
  })

  test('closes the pane outright with a file open', async ($, on) => {
    const project = await started($, on, { files: { [A]: FIVE }, panes: [{ isShown: true }] })
    await edit($, 't1', 'a.ts', 'two', 'TWO')
    const ui = await mount($)
    await ui.press({ key: FILE })

    await command($)
    expect(project.closed).toEqual(['difnote'])
  })

  test('brings the pane to the front when another is shown over it', async ($, on) => {
    const project = await started($, on, { panes: [{ isShown: false }] })
    await command($)
    expect(project.opened).toEqual([{ focus: true }])
  })
})
