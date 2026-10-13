import { describe, expect, test } from 'claude-code/testing'
import {
  CLOSER,
  CWD,
  NOW,
  closeMark,
  codeOf,
  command,
  cursorOf,
  edit,
  goTo,
  listOf,
  mount,
  moveTo,
  openFile,
  put,
  shell,
  shownOf,
  started,
  textsOf,
  write,
} from './kit'
import type { Mounted } from './kit'
import { runGit } from './fakegit'

const A = `${CWD}/a.ts`
const B = `${CWD}/b.ts`
const FIVE = 'one\ntwo\nthree\nfour\nfive\n'
const TS = '\u{e628} '

// Opens the pane, as /difnote does, and lets its look finish.
async function opened($: Parameters<typeof mount>[0], project: Awaited<ReturnType<typeof started>>): Promise<Mounted> {
  await command($)
  const ui = await mount($)
  await project.clock.settle()
  return ui
}

describe('the folders difnote watches', () => {
  test("shows a shell command's change in the session's folder, from before it", async ($, on) => {
    const project = await started($, on, { git: true, files: { [A]: FIVE } })
    await shell($, 't1', 'sed -i s/two/TWO/ a.ts', { [A]: 'one\nTWO\nthree\nfour\nfive\n' })
    const ui = await opened($, project)

    expect(await listOf(ui)).toEqual([`${TS}a.ts +1 −1`])
    await openFile(ui, A)
    await ui.press({ key: 'key-up' })
    expect(await codeOf(ui)).toEqual([{ path: A, source: '@@ -1,5 +1,5 @@\n one\n-two\n+TWO\n three\n four\n five' }])
  })

  test('says since when, and lists new and deleted files too, by name', async ($, on) => {
    const project = await started($, on, { git: true, files: { [A]: FIVE, [`${CWD}/c.ts`]: 'gone\n' } })
    await shell($, 't1', 'sed -i s/two/TWO/ a.ts', { [A]: 'one\nTWO\nthree\nfour\nfive\n' })
    await shell($, 't2', 'mv c.ts b.ts', { [B]: 'gone\n', [`${CWD}/c.ts`]: null })
    const ui = await opened($, project)

    expect((await textsOf(ui))[0]).toMatch(/^since \d\d:\d\d · 3 files \+2 −2$/)
    expect(await listOf(ui)).toEqual([`${TS}a.ts +1 −1`, `${TS}b.ts new`, `${TS}c.ts deleted`])
    await openFile(ui, B)
    expect(await codeOf(ui)).toEqual([{ path: B, source: '@@ -0,0 +1,1 @@\n+gone' }])
    await ui.press({ key: 'key-out' })
    await openFile(ui, `${CWD}/c.ts`)
    expect(await codeOf(ui)).toEqual([{ path: `${CWD}/c.ts`, source: '@@ -1,1 +0,0 @@\n-gone' }])
  })

  test('lists a file that became a folder as gone, and the files in the folder as new', { options: { fileIcons: false } }, async ($, on) => {
    const thing = `${CWD}/thing`
    const project = await started($, on, { git: true, files: { [thing]: 'a file\n' } })
    await shell($, 't1', 'rm thing && mkdir thing && touch thing/inner.ts', { [thing]: null, [`${thing}/inner.ts`]: 'inside\n' })
    const ui = await opened($, project)

    expect(await listOf(ui)).toEqual(['thing/ · 1 file', '  inner.ts new', 'thing deleted'])
  })

  test(
    'shows a file over 1 MiB, a binary file and one named like a secret without lines, with their sizes',
    { options: { fileIcons: false } },
    async ($, on) => {
      const big = `${CWD}/big.txt`
      const picture = `${CWD}/pic.bin`
      const secret = `${CWD}/.env`
      const project = await started($, on, { git: true, files: { [big]: 'x'.repeat(1_100_000), [picture]: 'a\0b', [secret]: 'A=1\n' } })
      await shell($, 't1', 'make', { [big]: 'y'.repeat(1_200_000), [picture]: 'a\0bc', [secret]: 'A=22\n' })
      const ui = await opened($, project)

      expect(await listOf(ui)).toEqual(['.env secret', 'big.txt over 1 MiB', 'pic.bin binary'])
      await openFile(ui, big)
      expect(await shownOf(ui)).toContain('Over 1 MiB, so difnote keeps no copy of it: no lines to show. 1.0 MB → 1.1 MB.')
      await ui.press({ key: 'key-out' })
      await openFile(ui, secret)
      expect(await shownOf(ui)).toContain('Named like a secret, so difnote keeps no copy of it: no lines to show. 4 B → 5 B.')
      await ui.press({ key: 'key-out' })
      await openFile(ui, picture)
      expect(await shownOf(ui)).toContain('A binary file: no lines to show. 3 B → 4 B.')
    },
  )

  test('gives the sizes of a large file in bytes when they read the same rounded', { options: { fileIcons: false } }, async ($, on) => {
    const big = `${CWD}/big.log`
    const project = await started($, on, { git: true, files: { [big]: 'x'.repeat(1_200_000) } })
    await shell($, 't1', 'echo yy >> big.log', { [big]: 'x'.repeat(1_200_002) })
    const ui = await opened($, project)

    await openFile(ui, big)
    expect(await shownOf(ui)).toContain('Over 1 MiB, so difnote keeps no copy of it: no lines to show. 1,200,000 B → 1,200,002 B.')
  })

  test("looks again after Claude's change while the pane is shown", { options: { fileIcons: false } }, async ($, on) => {
    const project = await started($, on, { git: true, files: { [A]: FIVE }, panes: [{ isShown: true }] })
    const ui = await mount($)
    await shell($, 't1', 'sed -i s/two/TWO/ a.ts', { [A]: 'one\nTWO\nthree\nfour\nfive\n' })
    await project.clock.settle()

    expect(await listOf(ui)).toEqual(['a.ts +1 −1'])
  })

  test(
    'an open pane, empty too, looks again by itself 10 seconds after its last look, for changes no hook sees',
    { options: { fileIcons: false } },
    async ($, on) => {
      const project = await started($, on, { git: true, files: { [A]: FIVE }, panes: [{ isShown: true }] })
      const ui = await mount($)
      await project.clock.settle()
      expect((await textsOf(ui))[0]).toMatch(/^No changes since \d\d:\d\d\.$/)

      put(project, A, 'one\nTWO\nthree\nfour\nfive\n')
      await project.clock.advance(9_999)
      await project.clock.settle()
      expect(await listOf(ui)).toEqual([])
      await project.clock.advance(2)
      await project.clock.settle()
      expect(await listOf(ui)).toEqual(['a.ts +1 −1'])
    },
  )

  test(
    'moving the keyboard into the pane looks again when its last look is over 2 seconds old; moving the cursor does not',
    { options: { fileIcons: false } },
    async ($, on) => {
      const project = await started($, on, { git: true, files: { [A]: FIVE, [B]: 'b\n' } })
      put(project, B, 'bb\n')
      const ui = await opened($, project)
      put(project, A, 'one\nTWO\nthree\nfour\nfive\n')
      await project.clock.advance(2_001)

      await ui.press({ key: 'key-down' })
      await project.clock.settle()
      expect(await listOf(ui)).toEqual(['b.ts +1 −1'])
      await moveTo($, 'enter')
      await project.clock.settle()
      expect(await listOf(ui)).toEqual(['a.ts +1 −1', 'b.ts +1 −1'])
    },
  )

  test('a look Claude Code cuts short keeps what the pane showed', { options: { fileIcons: false } }, async ($, on) => {
    const project = await started($, on, { git: true, files: { [A]: FIVE } })
    await shell($, 't1', 'sed -i s/two/TWO/ a.ts', { [A]: 'one\nTWO\nthree\nfour\nfive\n' })
    const ui = await opened($, project)
    await project.clock.advance(2_001)

    project.isCut = true
    await ui.press({ key: 'key-down' })
    await project.clock.settle()
    expect(await listOf(ui)).toEqual(['a.ts +1 −1'])
    expect(await textsOf(ui)).not.toContain("Not watched, so only Claude's Edit and Write show there:")
    project.isCut = false
    await shell($, 't2', 'touch b.ts', { [B]: '' })
    await ui.press({ key: 'key-reviewed' })
    await project.clock.advance(2_001)
    await ui.press({ key: 'key-down' })
    await project.clock.settle()
    expect(await listOf(ui)).toEqual(['b.ts new'])
  })

  test(
    "a session after the first finds a repository inside the session's folder, and shows its changes in the same look",
    { options: { fileIcons: false } },
    async ($, on) => {
      const lib = `${CWD}/vendor/lib`
      const project = await started($, on, { git: true, repos: [lib], files: { [`${lib}/y.ts`]: 'a\n' } })
      await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
      await project.clock.settle()
      await shell($, 't1', 'sed -i s/a/b/ vendor/lib/y.ts', { [`${lib}/y.ts`]: 'b\n' })

      expect(await listOf(await opened($, project))).toEqual(['vendor/lib/ · 1 file', '  y.ts +1 −1'])
    },
  )

  test("shows the rest of a change when git can't read a file, which shows without lines", { options: { fileIcons: false } }, async ($, on) => {
    const locked = `${CWD}/locked.txt`
    const project = await started($, on, { git: true, files: { [A]: FIVE }, unreadable: [locked] })
    await shell($, 't1', 'make', { [A]: 'one\nTWO\nthree\nfour\nfive\n', [locked]: 'secret\n' })
    const ui = await opened($, project)

    expect(await listOf(ui)).toEqual(['a.ts +1 −1', 'locked.txt new unreadable'])
  })

  test('shows the change of a file Claude wrote that the folder ignores, by its record', { options: { fileIcons: false } }, async ($, on) => {
    const project = await started($, on, { git: true })
    await write($, 't1', 'node_modules/x/i.js', 'hello\n')
    const ui = await opened($, project)

    expect(await listOf(ui)).toEqual(['node_modules/x/ · 1 file', '  i.js new'])
  })
})

describe('the folders it finds', () => {
  test('watches a git repository a shell command goes into, from before the command runs', async ($, on) => {
    const lib = '/home/demo/lib'
    const project = await started($, on, { git: true, repos: [lib], files: { [`${lib}/x.ts`]: 'a\n' } })
    await shell($, 't1', 'cd ../lib && sed -i s/a/b/ x.ts', { [`${lib}/x.ts`]: 'b\n' })
    const ui = await opened($, project)

    expect(await listOf(ui)).toEqual(['~/lib · 1 file', `${TS}x.ts +1 −1`])
  })

  test(
    'watches a folder Claude writes a file into from before the write, also for changes made there after, but not its subfolders',
    { options: { fileIcons: false } },
    async ($, on) => {
      const notes = '/home/demo/notes'
      const deep = `${notes}/old/deep.md`
      const project = await started($, on, { git: true, files: { [`${notes}/todo.md`]: 'one\n', [`${notes}/list.md`]: 'a\n', [deep]: 'x\n' } })
      await write($, 't1', `${notes}/todo.md`, 'two\n')
      await shell($, 't2', `echo b >> ${notes}/list.md && echo y > ${deep}`, { [`${notes}/list.md`]: 'a\nb\n', [deep]: 'y\n' })
      const ui = await opened($, project)

      expect(await listOf(ui)).toEqual(['~/notes · 2 files', 'list.md +1 −0', 'todo.md +1 −1'])
    },
  )

  test("watches a repository inside the session's folder on its own, its files listed once", async ($, on) => {
    const lib = `${CWD}/vendor/lib`
    const project = await started($, on, { git: true, repos: [lib], files: { [`${lib}/y.ts`]: 'a\n' } })
    await shell($, 't1', 'sed -i s/a/b/ vendor/lib/y.ts', { [`${lib}/y.ts`]: 'b\n' })
    const ui = await opened($, project)

    expect(await listOf(ui)).toEqual(['vendor/lib/ · 1 file', `  ${TS}y.ts +1 −1`])
  })

  test(
    'a later session in the same folder watches again the folders an earlier one used, while their changes wait',
    { options: { fileIcons: false } },
    async ($, on) => {
      const notes = '/home/demo/notes'
      const project = await started($, on, { git: true, files: { [`${notes}/todo.md`]: 'one\n' } })
      await write($, 't1', `${notes}/todo.md`, 'two\n')

      await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
      await project.clock.settle()
      expect(await listOf(await opened($, project))).toEqual(['~/notes · 1 file', 'todo.md +1 −1'])
    },
  )

  test('a repository comes back as a repository, also from a record that lost its kind', { options: { fileIcons: false } }, async ($, on) => {
    const lib = '/home/demo/lib'
    const app = `${lib}/dist/app.js`
    const files = { [`${lib}/.gitignore`]: 'dist/\n', [app]: 'v1\n' }
    const project = await started($, on, { git: true, repos: [lib], tracked: [app], files })
    await shell($, 't1', `cd ${lib} && ls`, {})
    // A record from before difnote kept each folder's kind.
    project.store.set('folders', Object.assign({}, project.store.get('folders'), { [lib]: { baseAt: NOW, usedAt: NOW, tidiedAt: NOW, from: [CWD] } }))

    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await project.clock.settle()
    const extra = `${lib}/dist/extra.js`
    put(project, app, 'v2\n')
    put(project, extra, 'more\n')
    project.tracked.push(extra)
    expect(await listOf(await opened($, project))).toEqual(['~/lib · 2 files', 'dist/ · 2 files', '  app.js +1 −1', '  extra.js new'])
  })

  test(
    'a folder that comes up again, with no look, is watched again by later sessions here too',
    { options: { fileIcons: false } },
    async ($, on) => {
      const notes = '/home/demo/notes'
      const project = await started($, on, { git: true, files: { [`${notes}/todo.md`]: 'one\n' } })
      await write($, 't1', `${notes}/todo.md`, 'two\n')
      // A record from before difnote kept the session folders that used it.
      project.store.set('folders', Object.assign({}, project.store.get('folders'), { [notes]: { baseAt: NOW, usedAt: NOW, tidiedAt: NOW } }))
      await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
      await project.clock.settle()
      await write($, 't2', `${notes}/todo.md`, 'three\n')

      await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
      await project.clock.settle()
      expect(await listOf(await opened($, project))).toEqual(['~/notes · 1 file', 'todo.md +1 −1'])
    },
  )

  test('a session in another folder leaves those folders out', { options: { fileIcons: false } }, async ($, on) => {
    const notes = '/home/demo/notes'
    const project = await started($, on, { git: true, files: { [`${notes}/todo.md`]: 'one\n' } })
    await write($, 't1', `${notes}/todo.md`, 'two\n')

    await $.session.start({ cwd: '/home/demo/other', surface: 'terminal', isInteractive: true })
    await project.clock.settle()
    expect(await listOf(await opened($, project))).toEqual([])
  })

  test(
    "doesn't watch your home folder or a temporary one, says so, and shows Claude's Edit and Write there",
    { options: { fileIcons: false } },
    async ($, on) => {
      const project = await started($, on, { git: true })
      await write($, 't1', '/home/demo/x.md', 'hello\n')
      await write($, 't2', '/tmp/scratch/a.txt', 'hi\n')
      const ui = await opened($, project)

      expect(await listOf(ui)).toEqual(['~ · 1 file', 'x.md new', '/tmp/scratch · 1 file', 'a.txt new'])
      expect(await shownOf(ui)).toContain(
        "Not watched, so only Claude's Edit and Write show there: /home/demo (your home folder) /tmp (a temporary folder)",
      )
    },
  )

  test(
    "doesn't watch a folder outside your home folder that isn't a git repository, and says so",
    { options: { fileIcons: false } },
    async ($, on) => {
      const project = await started($, on, { git: true, files: { '/etc/demo.conf': 'x = 1\n' } })
      await write($, 't1', '/etc/demo.conf', 'x = 2\n')
      const ui = await opened($, project)

      expect(await listOf(ui)).toEqual(['/etc · 1 file', 'demo.conf +1 −1'])
      expect(await shownOf(ui)).toContain("Not watched, so only Claude's Edit and Write show there: /etc (outside your home folder)")
    },
  )

  test("doesn't watch a folder over 50,000 files, and says so", async ($, on) => {
    const many = Object.fromEntries(Array.from({ length: 50_001 }, (_, i) => [`${CWD}/f${i}.txt`, 'x\n']))
    const project = await started($, on, { git: true, files: many })
    const ui = await opened($, project)

    expect(await shownOf(ui)).toContain(`Not watched, so only Claude's Edit and Write show there: ${CWD} (over 50,000 files)`)
  })
})

describe('changes difnote catches', () => {
  test(
    "shows Claude's change by its record when its folder's first record took longer than Claude waits",
    { options: { fileIcons: false } },
    async ($, on) => {
      const notes = '/home/demo/notes'
      const project = await started($, on, { git: true, files: { [`${notes}/todo.md`]: 'one\n' } })
      project.recordMs = 10_000
      const writing = write($, 't1', `${notes}/todo.md`, 'two\n')
      await project.clock.advance(5_001)
      await writing
      await project.clock.advance(10_000)
      project.recordMs = 0

      expect(await listOf(await opened($, project))).toEqual(['~/notes · 1 file', 'todo.md +1 −1'])
    },
  )

  test(
    "after a review, shows such a file's later changes from the folder's record again, the shell's too",
    { options: { fileIcons: false } },
    async ($, on) => {
      const todo = '/home/demo/notes/todo.md'
      const project = await started($, on, { git: true, files: { [todo]: 'one\n' } })
      project.recordMs = 10_000
      const writing = write($, 't1', todo, 'two\n')
      await project.clock.advance(5_001)
      await writing
      await project.clock.advance(10_000)
      project.recordMs = 0
      const ui = await opened($, project)
      await ui.press({ key: 'key-reviewed' })

      await shell($, 't2', `echo x >> ${todo}`, { [todo]: 'two\nx\n' })
      await write($, 't3', todo, 'two\nx\ny\n')
      await project.clock.advance(2_001)
      await ui.press({ key: 'key-down' })
      await project.clock.settle()
      expect(await listOf(ui)).toEqual(['~/notes · 1 file', 'todo.md +2 −0'])
    },
  )

  test("shows Claude's change of a file a repository inside the folder ignores, by its record", { options: { fileIcons: false } }, async ($, on) => {
    const lib = `${CWD}/vendor/lib`
    const project = await started($, on, { git: true, repos: [lib], files: { [`${lib}/.gitignore`]: 'out.js\n', [`${lib}/y.ts`]: 'a\n' } })
    await write($, 't1', `${lib}/out.js`, 'built\n')

    expect(await listOf(await opened($, project))).toEqual(['vendor/lib/ · 1 file', '  out.js new'])
  })

  test(
    'shows a change to a file a repository tracks though its .gitignore matches it, also one it tracks later',
    { options: { fileIcons: false } },
    async ($, on) => {
      const app = `${CWD}/dist/app.js`
      const extra = `${CWD}/dist/extra.js`
      const project = await started($, on, { git: true, repos: [CWD], tracked: [app], files: { [`${CWD}/.gitignore`]: 'dist/\n', [app]: 'v1\n' } })
      await shell($, 't1', 'npm run build', { [app]: 'v2\n', [extra]: 'more\n' })
      project.tracked.push(extra)

      expect(await listOf(await opened($, project))).toEqual(['dist/ · 2 files', '  app.js +1 −1', '  extra.js new'])
    },
  )

  test('starts a folder unused for 30 days over: what changed before shows no more', async ($, on) => {
    const project = await started($, on, { git: true, files: { [A]: FIVE } })
    await shell($, 't1', 'sed -i s/two/TWO/ a.ts', { [A]: 'one\nTWO\nthree\nfour\nfive\n' })
    // Last used 31 days before the session that starts now.
    project.store.set('folders', { [CWD]: { baseAt: 0, usedAt: NOW - 31 * 24 * 60 * 60 * 1000, tidiedAt: 0 } })

    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await project.clock.settle()
    expect((await textsOf(await opened($, project)))[0]).toMatch(/^No changes since (\d+ \w+ )?\d\d:\d\d\.$/)
  })
})

describe('a review', () => {
  test('r marks everything shown reviewed', async ($, on) => {
    const project = await started($, on, { git: true, files: { [A]: FIVE } })
    await shell($, 't1', 'sed -i s/two/TWO/ a.ts', { [A]: 'one\nTWO\nthree\nfour\nfive\n' })
    const ui = await opened($, project)

    await ui.press({ key: 'key-reviewed' })
    await project.clock.settle()
    expect((await textsOf(ui))[0]).toMatch(/^No changes since \d\d:\d\d\.$/)
  })

  test("r leaves a folder's changes listed when git couldn't mark them reviewed", { options: { fileIcons: false } }, async ($, on) => {
    const project = await started($, on, { git: true, files: { [A]: FIVE } })
    await shell($, 't1', 'sed -i s/two/TWO/ a.ts', { [A]: 'one\nTWO\nthree\nfour\nfive\n' })
    const ui = await opened($, project)

    project.isLocked = true
    const pressing = ui.press({ key: 'key-reviewed' })
    await project.clock.advance(5_000)
    await pressing
    expect(await listOf(ui)).toEqual(['a.ts +1 −1'])
  })

  test('r during a look: the look, from before the review ended, is made again', { options: { fileIcons: false } }, async ($, on) => {
    const project = await started($, on, { git: true, files: { [A]: FIVE } })
    await shell($, 't1', 'sed -i s/two/TWO/ a.ts', { [A]: 'one\nTWO\nthree\nfour\nfive\n' })
    const ui = await opened($, project)
    // A change no hook sees, which only the next look finds.
    put(project, B, '')
    project.diffMs = 1_000
    await project.clock.advance(2_001)
    await ui.press({ key: 'key-down' })

    await ui.press({ key: 'key-reviewed' })
    project.diffMs = 0
    await project.clock.advance(1_000)
    await project.clock.settle()
    expect(await listOf(ui)).toEqual(['b.ts new'])
  })

  test('after a restart, takes up from the review that ended before it', async ($, on) => {
    const project = await started($, on, { git: true, files: { [A]: FIVE } })
    await shell($, 't1', 'sed -i s/two/TWO/ a.ts', { [A]: 'one\nTWO\nthree\nfour\nfive\n' })
    const ui = await opened($, project)
    await ui.press({ key: 'key-reviewed' })
    await project.clock.settle()
    await ui.unmount()
    await shell($, 't2', 'touch b.ts', { [B]: '' })

    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await project.clock.settle()
    expect(await listOf(await opened($, project))).toEqual([`${TS}b.ts new`])
  })
})

describe('unsent notes', () => {
  test('stay through /clear', async ($, on) => {
    const project = await started($, on, { git: true, files: { [A]: FIVE } })
    await edit($, 't1', 'a.ts', 'two', 'TWO')
    const ui = await opened($, project)
    await goTo(ui, `file:${A}`)
    await ui.press({ key: 'key-note' })
    await ui.input({ key: 'note-field', text: 'Why this file?' })

    await $.classic.SessionStart({ source: 'clear' })
    expect(await listOf(ui)).toEqual([`${TS}a.ts +1 −1 ✎1`])
    await ui.press({ key: 'send' })
    expect(project.draft.text).toBe('Notes on the changes:\n\na.ts\nWhy this file?')
  })

  test("stay through a restart, and keep to the session's folder: one in another folder has its own", async ($, on) => {
    const note = { target: `file:${A}`, path: A, anchor: 'a.ts', quote: [], text: 'Why this file?' }
    const other = [{ ...note, text: 'Not here' }]
    const project = await started($, on, { git: true, files: { [A]: FIVE }, stored: { notes: { [CWD]: [note], '/home/demo/other': other } } })
    await shell($, 't1', 'sed -i s/two/TWO/ a.ts', { [A]: 'one\nTWO\nthree\nfour\nfive\n' })
    const ui = await opened($, project)

    expect(await listOf(ui)).toEqual([`${TS}a.ts +1 −1 ✎1`])
    await ui.press({ key: 'send' })
    expect(project.draft.text).toBe('Notes on the changes:\n\na.ts\nWhy this file?')
    expect(project.store.get('notes')).toEqual({ '/home/demo/other': other })
  })

  test('show when nothing is changed any more, and s still sends them', async ($, on) => {
    const project = await started($, on, { git: true, files: { [A]: FIVE } })
    await shell($, 't1', 'sed -i s/two/TWO/ a.ts', { [A]: 'one\nTWO\nthree\nfour\nfive\n' })
    const ui = await opened($, project)
    await goTo(ui, `file:${A}`)
    await ui.press({ key: 'key-note' })
    await ui.input({ key: 'note-field', text: 'Why this file?' })

    await shell($, 't2', 'git checkout a.ts', { [A]: FIVE })
    await project.clock.settle()
    expect(await shownOf(ui)).toContain('Notes on lines changed since: ✎ a.ts · Why this file?')
    await ui.press({ key: 'send' })
    expect(project.draft.text).toBe('Notes on the changes:\n\na.ts (since changed)\nWhy this file?')
  })
})

describe('what difnote gives git', () => {
  test('no copy of a file named like a secret, or of one over 1 MiB', async ($, on) => {
    const project = await started($, on, { git: true, files: { [`${CWD}/.env`]: 'TOKEN=abc\n', [`${CWD}/big.txt`]: 'x'.repeat(1_100_000) } })
    await opened($, project)

    const given = project.ran.map(one => one.stdin).join('\n')
    expect(given).not.toContain('TOKEN=abc')
    expect(given).not.toContain('x'.repeat(100))
    expect(project.ran.filter(one => one.argv.includes('--add')).map(one => one.stdin)).not.toContainEqual(expect.stringContaining('.env'))
  })

  test("no copy of a file named like a secret when its folder can't be listed", async ($, on) => {
    const project = await started($, on, { git: true, files: { [`${CWD}/.env`]: 'TOKEN=abc\n' }, unlisted: [CWD] })
    await opened($, project)

    expect(project.ran.filter(one => one.argv.includes('--add')).map(one => one.stdin)).not.toContainEqual(expect.stringContaining('.env'))
  })

  test('only commands written out in full: paths go on standard input', async ($, on) => {
    const project = await started($, on, { git: true, files: { [A]: FIVE } })
    await shell($, 't1', 'sed -i s/two/TWO/ a.ts', { [A]: 'one\nTWO\nthree\nfour\nfive\n' })
    await opened($, project)

    expect(project.ran.flatMap(one => one.argv).filter(part => part.includes('/home/') || part.includes('a.ts'))).toEqual([])
  })

  test("git's own variables naming the private git folder, for each of its commands", async ($, on) => {
    const project = await started($, on, { git: true, files: { [A]: FIVE } })
    await shell($, 't1', 'sed -i s/two/TWO/ a.ts', { [A]: 'one\nTWO\nthree\nfour\nfive\n' })
    await opened($, project)

    const own = project.ran.filter(one => one.env.GIT_DIR?.endsWith('/git') === true)
    const named = own.map(({ env }) => ({
      dir: env.GIT_DIR ?? '',
      index: env.GIT_INDEX_FILE,
      tree: env.GIT_WORK_TREE,
      objects: env.GIT_OBJECT_DIRECTORY,
    }))
    expect(named.length).toBeGreaterThan(5)
    // Never from inside a folder difnote watches, as its own git folder may be.
    expect([...new Set(own.map(one => one.cwd))]).toEqual(['/'])
    expect(
      named.filter(one => !one.dir.endsWith('/git') || one.index !== `${one.dir}/index` || one.objects !== `${one.dir}/objects` || one.tree !== CWD),
    ).toEqual([])
    expect(
      project.ran.filter(one => one.env.GIT_CONFIG_PARAMETERS !== '' || one.env.GIT_CONFIG_GLOBAL !== '/dev/null').map(one => one.argv.join(' ')),
    ).toEqual(['git config --global --path --get core.excludesFile'])
  })

  test("git's own variables naming your repository, when it lists what the repository tracks", async ($, on) => {
    const project = await started($, on, { git: true, repos: [CWD], files: { [A]: FIVE } })
    await opened($, project)

    const tracked = project.ran.filter(one => one.argv.includes('--cached'))
    expect(tracked.map(({ cwd, env }) => ({ cwd, dir: env.GIT_DIR, tree: env.GIT_WORK_TREE, index: env.GIT_INDEX_FILE }))[0]).toEqual({
      cwd: CWD,
      dir: `${CWD}/.git`,
      tree: CWD,
      index: `${CWD}/.git/index`,
    })
  })
})

const DAY = 24 * 60 * 60 * 1000

// A new session in `cwd`, its first records taken.
async function restarted($: Parameters<typeof mount>[0], project: Awaited<ReturnType<typeof started>>, cwd = CWD) {
  await $.session.start({ cwd, surface: 'terminal', isInteractive: true })
  await project.clock.settle()
}

// Closes the pane, as Esc does with nothing to step back from, and takes
// its drawing down. The test needs the CLOSER plugin.
async function closed($: Parameters<typeof mount>[0], ui: Mounted) {
  await ui.unmount()
  await closeMark($)
}

// The git commands run since `from`, without git and its own options.
function ranSince(project: Awaited<ReturnType<typeof started>>, from: number): string[] {
  return [...new Set(project.ran.slice(from).map(one => one.argv.slice(1).join(' ')))]
}

describe('looks by itself', () => {
  test('runs only git that reads where nothing changed', { options: { fileIcons: false } }, async ($, on) => {
    const lib = `${CWD}/vendor/lib`
    const project = await started($, on, { git: true, repos: [lib], files: { [A]: FIVE, [`${lib}/y.ts`]: 'a\n' } })
    await opened($, project)
    const from = project.ran.length

    await project.clock.advance(10_001)
    await project.clock.settle()
    expect(ranSince(project, from)).toEqual(['ls-files -z --others --exclude-standard', 'diff-files -z --name-only'])
  })

  test('records only the folder that changed, and shows its change', { options: { fileIcons: false } }, async ($, on) => {
    const lib = `${CWD}/vendor/lib`
    const project = await started($, on, { git: true, repos: [lib], files: { [A]: FIVE, [`${lib}/y.ts`]: 'a\n' } })
    const ui = await opened($, project)
    const from = project.ran.length

    put(project, `${lib}/y.ts`, 'b\n')
    await project.clock.advance(10_001)
    await project.clock.settle()
    expect(
      project.ran
        .slice(from)
        .filter(one => one.argv.includes('--add'))
        .map(one => one.env.GIT_WORK_TREE),
    ).toEqual([lib])
    expect(await listOf(ui)).toEqual(['vendor/lib/ · 1 file', '  y.ts +1 −1'])
  })

  test('finds a change to a file kept by a placeholder', { options: { fileIcons: false } }, async ($, on) => {
    const big = `${CWD}/big.txt`
    const project = await started($, on, { git: true, files: { [big]: 'x'.repeat(1_100_000) } })
    const ui = await opened($, project)

    put(project, big, 'x'.repeat(1_100_001))
    await project.clock.advance(10_001)
    await project.clock.settle()
    expect(await listOf(ui)).toEqual(['big.txt over 1 MiB'])
  })

  test('finds a review made in another session in the folder', { options: { fileIcons: false } }, async ($, on) => {
    const project = await started($, on, { git: true, files: { [A]: FIVE } })
    await shell($, 't1', 'sed -i s/two/TWO/ a.ts', { [A]: 'one\nTWO\nthree\nfour\nfive\n' })
    const ui = await opened($, project)
    expect(await listOf(ui)).toEqual(['a.ts +1 −1'])

    const own = project.ran.find(one => one.env.GIT_WORK_TREE === CWD && one.env.GIT_DIR?.endsWith('/git') === true)
    const gitDir = own?.env.GIT_DIR ?? ''
    const shown = (project.written.get(`${gitDir}/refs/difnote/shown`) ?? '').trim()
    runGit(project, ['git', 'update-ref', '--stdin'], '/', `update refs/difnote/base ${shown}\n`, own?.env)
    await project.clock.advance(10_001)
    await project.clock.settle()
    expect((await textsOf(ui))[0]).toMatch(/^No changes since \d\d:\d\d\.$/)
  })

  test('finds a change another session in the folder recorded first', { options: { fileIcons: false } }, async ($, on) => {
    const project = await started($, on, { git: true, files: { [A]: FIVE } })
    const ui = await opened($, project)
    const own = project.ran.find(one => one.env.GIT_WORK_TREE === CWD && one.env.GIT_DIR?.endsWith('/git') === true)
    const env = own?.env ?? {}

    // The other session records the change into the same private git folder.
    put(project, A, 'one\nTWO\nthree\nfour\nfive\n')
    runGit(project, ['git', 'update-index', '-z', '--add', '--remove', '--stdin'], '/', 'a.ts\0', env)
    const tree = runGit(project, ['git', 'write-tree'], '/', '', env).stdout.trim()
    runGit(project, ['git', 'update-ref', '--stdin'], '/', `update refs/difnote/shown ${tree}\n`, env)
    await project.clock.advance(10_001)
    await project.clock.settle()
    expect(await listOf(ui)).toEqual(['a.ts +1 −1'])
  })

  test('after a slow look, waits 20 times as long as it took', { options: { fileIcons: false } }, async ($, on) => {
    const project = await started($, on, { git: true, files: { [A]: FIVE } })
    project.diffMs = 1_000
    await command($)
    const ui = await mount($)
    await project.clock.advance(1_000)
    await project.clock.settle()

    put(project, A, 'one\nTWO\nthree\nfour\nfive\n')
    await project.clock.advance(19_999)
    await project.clock.settle()
    expect(await listOf(ui)).toEqual([])
    await project.clock.advance(1_001)
    await project.clock.settle()
    await project.clock.advance(1_000)
    await project.clock.settle()
    expect(await listOf(ui)).toEqual(['a.ts +1 −1'])
  })

  test(
    "leaves a folder whose look took over 3 seconds twice to the looks Claude's changes and keys make, and says so",
    { options: { fileIcons: false } },
    async ($, on) => {
      const project = await started($, on, { git: true, files: { [A]: FIVE } })
      project.recordMs = 3_001
      put(project, A, 'one\nTWO\nthree\nfour\nfive\n')
      await command($)
      const ui = await mount($)
      await project.clock.advance(3_001)
      await project.clock.settle()
      const touching = shell($, 't1', 'touch b.ts', { [B]: 'b\n' })
      await project.clock.advance(3_001)
      await touching
      await project.clock.settle()
      expect(await shownOf(ui)).toContain(`Slow to look at, so looked at only after Claude's changes or a key: ${CWD}`)

      project.recordMs = 0
      put(project, `${CWD}/c.ts`, 'c\n')
      await project.clock.advance(200_000)
      await project.clock.settle()
      expect(await listOf(ui)).toEqual(['a.ts +1 −1', 'b.ts new'])
      await shell($, 't2', 'touch d.ts', { [`${CWD}/d.ts`]: 'd\n' })
      await project.clock.settle()
      expect(await listOf(ui)).toEqual(['a.ts +1 −1', 'b.ts new', 'c.ts new', 'd.ts new'])

      // That look was quick: the folder is looked at by itself again.
      expect(await textsOf(ui)).not.toContain("Slow to look at, so looked at only after Claude's changes or a key:")
      put(project, `${CWD}/e.ts`, 'e\n')
      await project.clock.advance(10_001)
      await project.clock.settle()
      expect(await listOf(ui)).toContain('e.ts new')
    },
  )

  test('holds its look while a note is being written, and looks once the note is saved', { options: { fileIcons: false } }, async ($, on) => {
    const project = await started($, on, { git: true, files: { [A]: FIVE } })
    await shell($, 't1', 'sed -i s/two/TWO/ a.ts', { [A]: 'one\nTWO\nthree\nfour\nfive\n' })
    const ui = await opened($, project)
    await goTo(ui, `file:${A}`)
    await ui.press({ key: 'key-note' })

    put(project, B, 'b\n')
    await project.clock.advance(10_001)
    await project.clock.settle()
    expect(await listOf(ui)).toEqual(['a.ts +1 −1'])
    await ui.input({ key: 'note-field', text: 'Why?' })
    await project.clock.settle()
    expect(await listOf(ui)).toEqual(['a.ts +1 −1 ✎1', 'b.ts new'])
  })

  test('in a pane kept open behind another tab through a restart, once it is in front', { options: { fileIcons: false } }, async ($, on) => {
    const project = await started($, on, { git: true, files: { [A]: FIVE }, panes: [{ isShown: false }] })
    const ui = await mount($)
    put(project, A, 'one\nTWO\nthree\nfour\nfive\n')

    await project.clock.advance(10_001)
    await project.clock.settle()
    expect(await listOf(ui)).toEqual([])
    project.pane.isShown = true
    await project.clock.advance(10_001)
    await project.clock.settle()
    expect(await listOf(ui)).toEqual(['a.ts +1 −1'])
  })

  test('none in a closed pane', { plugins: [CLOSER] }, async ($, on) => {
    const project = await started($, on, { git: true, files: { [A]: FIVE } })
    await closed($, await opened($, project))
    const from = project.ran.length

    await project.clock.advance(60_000)
    await project.clock.settle()
    expect(project.ran.length - from).toBe(0)
  })

  test('none while the pane is behind another tab; the next once it is in front again', { options: { fileIcons: false } }, async ($, on) => {
    const project = await started($, on, { git: true, files: { [A]: FIVE } })
    const ui = await opened($, project)
    project.pane.isShown = false
    const from = project.ran.length
    put(project, A, 'one\nTWO\nthree\nfour\nfive\n')

    await project.clock.advance(10_001)
    await project.clock.settle()
    expect(project.ran.length - from).toBe(0)
    project.pane.isShown = true
    await project.clock.advance(10_001)
    await project.clock.settle()
    expect(await listOf(ui)).toEqual(['a.ts +1 −1'])
  })
})

describe('the folders later sessions watch again', () => {
  test(
    'not a repository Claude only went into, once a look finds nothing in it to review',
    { options: { fileIcons: false }, plugins: [CLOSER] },
    async ($, on) => {
      const lib = '/home/demo/lib'
      const project = await started($, on, { git: true, repos: [lib], files: { [`${lib}/x.ts`]: 'a\n' } })
      await shell($, 't1', `cd ${lib} && ls`, {})
      await closed($, await opened($, project))

      await restarted($, project)
      put(project, `${lib}/x.ts`, 'b\n')
      expect(await listOf(await opened($, project))).toEqual([])
    },
  )

  test('not a repository a shell command only read in, even before any look', { options: { fileIcons: false } }, async ($, on) => {
    const lib = '/home/demo/lib'
    const project = await started($, on, { git: true, repos: [lib], files: { [`${lib}/x.ts`]: 'a\n' } })
    await shell($, 't1', `git -C ${lib} log`, {})

    await restarted($, project)
    put(project, `${lib}/x.ts`, 'b\n')
    expect(await listOf(await opened($, project))).toEqual([])
  })

  test('a repository a shell command changed, as Claude Code reports it', { options: { fileIcons: false } }, async ($, on) => {
    const lib = '/home/demo/lib'
    const project = await started($, on, { git: true, repos: [lib], files: { [`${lib}/x.ts`]: 'a\n' } })
    await shell($, 't1', `sed -i s/a/b/ ${lib}/x.ts`, { [`${lib}/x.ts`]: 'b\n' }, [`${lib}/x.ts`])

    await restarted($, project)
    expect(await listOf(await opened($, project))).toEqual(['~/lib · 1 file', 'x.ts +1 −1'])
  })

  test(
    "as a folder of Claude's files, one that is no longer a repository: so not outside your home folder",
    { options: { fileIcons: false } },
    async ($, on) => {
      const app = '/srv/app'
      const project = await started($, on, { git: true, files: { [`${app}/a.txt`]: 'x\n' } })
      project.store.set('folders', { [app]: { baseAt: NOW, usedAt: NOW, tidiedAt: NOW, from: [CWD] } })

      await restarted($, project)
      expect(await shownOf(await opened($, project))).toContain(
        `Not watched, so only Claude's Edit and Write show there: ${app} (outside your home folder)`,
      )
    },
  )

  test(
    'a repository a shell command changed though Claude Code reports nothing, once a look here finds the change',
    { options: { fileIcons: false }, plugins: [CLOSER] },
    async ($, on) => {
      const lib = '/home/demo/lib'
      const project = await started($, on, { git: true, repos: [lib], files: { [`${lib}/x.ts`]: 'a\n' } })
      await shell($, 't1', `cd ${lib} && sed -i s/a/b/ x.ts`, { [`${lib}/x.ts`]: 'b\n' })
      await closed($, await opened($, project))

      await restarted($, project)
      expect(await listOf(await opened($, project))).toEqual(['~/lib · 1 file', 'x.ts +1 −1'])
    },
  )

  test('not a folder reviewed here', { options: { fileIcons: false }, plugins: [CLOSER] }, async ($, on) => {
    const notes = '/home/demo/notes'
    const project = await started($, on, { git: true, files: { [`${notes}/todo.md`]: 'one\n' } })
    await write($, 't1', `${notes}/todo.md`, 'two\n')
    const ui = await opened($, project)
    await ui.press({ key: 'key-reviewed' })
    await project.clock.settle()
    await closed($, ui)

    await restarted($, project)
    put(project, `${notes}/todo.md`, 'three\n')
    expect(await listOf(await opened($, project))).toEqual([])
  })

  test(
    'count no look as use: one Claude last changed 30 days ago is emptied, and the session says so',
    { options: { fileIcons: false }, plugins: [CLOSER] },
    async ($, on) => {
      const notes = '/home/demo/notes'
      const project = await started($, on, { git: true, files: { [`${notes}/todo.md`]: 'one\n' } })
      await write($, 't1', `${notes}/todo.md`, 'two\n')
      await closed($, await opened($, project))
      await project.clock.advance(20 * DAY)
      await restarted($, project)
      const ui = await opened($, project)
      expect(await listOf(ui)).toEqual(['~/notes · 1 file', 'todo.md +1 −1'])
      await closed($, ui)

      await project.clock.advance(11 * DAY)
      await restarted($, project)
      expect(project.toasts).toEqual([`Emptied after 30 days unused, with changes you hadn't reviewed: ${notes}`])
      expect(await shownOf(await opened($, project))).toContain(`Emptied after 30 days unused, with changes you hadn't reviewed: ${notes}`)
    },
  )

  test('with changes no look saw yet, emptied after 30 days unused, says so too', { options: { fileIcons: false } }, async ($, on) => {
    const notes = '/home/demo/notes'
    const project = await started($, on, { git: true, files: { [`${notes}/todo.md`]: 'one\n' } })
    await write($, 't1', `${notes}/todo.md`, 'two\n')

    await project.clock.advance(31 * DAY)
    await restarted($, project)
    expect(project.toasts).toEqual([`Emptied after 30 days unused, with changes you hadn't reviewed: ${notes}`])
  })

  test('x during a look: the look is made again without the folder', { options: { fileIcons: false } }, async ($, on) => {
    const notes = '/home/demo/notes'
    const project = await started($, on, { git: true, files: { [`${notes}/todo.md`]: 'one\n' } })
    await write($, 't1', `${notes}/todo.md`, 'two\n')
    await restarted($, project)
    const ui = await opened($, project)

    project.diffMs = 1_000
    await project.clock.advance(2_001)
    await goTo(ui, `folder:${notes}`)
    await ui.press({ key: 'key-drop' })
    project.diffMs = 0
    await project.clock.advance(1_000)
    await project.clock.settle()
    expect(await listOf(ui)).toEqual([])
  })

  test(
    'are named in the pane, and x stops watching one from here, its changes left for a session in it',
    { options: { fileIcons: false }, plugins: [CLOSER] },
    async ($, on) => {
      const notes = '/home/demo/notes'
      const project = await started($, on, { git: true, files: { [`${notes}/todo.md`]: 'one\n' } })
      await write($, 't1', `${notes}/todo.md`, 'two\n')

      await restarted($, project)
      const ui = await opened($, project)
      expect(await shownOf(ui)).toMatch(new RegExp(`From earlier sessions here, until you review them: ${notes} · 1 file · last used \\d\\d:\\d\\d`))
      await goTo(ui, `folder:${notes}`)
      await ui.press({ key: 'key-drop' })
      await project.clock.settle()
      expect(await listOf(ui)).toEqual([])
      await closed($, ui)

      await restarted($, project)
      const later = await opened($, project)
      expect(await listOf(later)).toEqual([])
      await closed($, later)
      await restarted($, project, notes)
      expect(await listOf(await opened($, project))).toEqual(['todo.md +1 −1'])
    },
  )
})

describe('viewed marks', () => {
  test(
    'v marks a file viewed: its row quiet with a check, counted at the top, and the cursor on to the next file not viewed',
    { options: { fileIcons: false } },
    async ($, on) => {
      const project = await started($, on, { git: true, files: { [A]: FIVE, [B]: 'b\n' } })
      await shell($, 't1', 'make', { [A]: 'one\nTWO\nthree\nfour\nfive\n', [B]: 'bb\n' })
      const ui = await opened($, project)
      await goTo(ui, `file:${A}`)

      await ui.press({ key: 'key-viewed' })
      expect(await listOf(ui)).toEqual(['✓ a.ts +1 −1', 'b.ts +1 −1'])
      expect((await textsOf(ui))[0]).toMatch(/^since \d\d:\d\d · 2 files · 1 viewed \+2 −2$/)
      expect(await cursorOf(ui)).toBe(`file:${B}`)
    },
  )

  test('from inside the open file, v marks it and closes it; v on its row again unmarks it', { options: { fileIcons: false } }, async ($, on) => {
    const project = await started($, on, { git: true, files: { [A]: FIVE } })
    await shell($, 't1', 'sed -i s/two/TWO/ a.ts', { [A]: 'one\nTWO\nthree\nfour\nfive\n' })
    const ui = await opened($, project)
    await openFile(ui, A)

    await ui.press({ key: 'key-viewed' })
    expect(await codeOf(ui)).toEqual([])
    expect(await listOf(ui)).toEqual(['✓ a.ts +1 −1'])
    await ui.press({ key: 'key-viewed' })
    expect(await listOf(ui)).toEqual(['a.ts +1 −1'])
  })

  test(
    'a viewed file is unmarked once it changes again; the mark stays through a restart while it does not',
    { options: { fileIcons: false }, plugins: [CLOSER] },
    async ($, on) => {
      const project = await started($, on, { git: true, files: { [A]: FIVE, [B]: 'b\n' } })
      await shell($, 't1', 'make', { [A]: 'one\nTWO\nthree\nfour\nfive\n', [B]: 'bb\n' })
      const ui = await opened($, project)
      await goTo(ui, `file:${A}`)
      await ui.press({ key: 'key-viewed' })
      await goTo(ui, `file:${B}`)
      await ui.press({ key: 'key-viewed' })
      await closed($, ui)

      await restarted($, project)
      await shell($, 't2', 'echo more >> b.ts', { [B]: 'bb\nmore\n' })
      expect(await listOf(await opened($, project))).toEqual(['✓ a.ts +1 −1', 'b.ts +2 −1'])
    },
  )

  test('r clears them with the review', { options: { fileIcons: false } }, async ($, on) => {
    const project = await started($, on, { git: true, files: { [A]: FIVE } })
    await shell($, 't1', 'sed -i s/two/TWO/ a.ts', { [A]: 'one\nTWO\nthree\nfour\nfive\n' })
    const ui = await opened($, project)
    await goTo(ui, `file:${A}`)
    await ui.press({ key: 'key-viewed' })

    await ui.press({ key: 'key-reviewed' })
    await project.clock.settle()
    expect(project.store.get('viewed')).toEqual({})
  })
})

describe('r', () => {
  test(
    'marks reviewed what the pane showed when it asked, not what it found while you answered',
    { options: { fileIcons: false } },
    async ($, on) => {
      const project = await started($, on, { git: true, files: { [A]: FIVE } })
      await shell($, 't1', 'sed -i s/two/TWO/ a.ts', { [A]: 'one\nTWO\nthree\nfour\nfive\n' })
      const ui = await opened($, project)

      project.whileAsked = async () => {
        await shell($, 't2', 'touch b.ts', { [B]: 'b\n' })
        await project.clock.settle()
        expect(await listOf(ui)).toEqual(['a.ts +1 −1', 'b.ts new'])
      }
      await ui.press({ key: 'key-reviewed' })
      await project.clock.settle()
      expect(await listOf(ui)).toEqual(['b.ts new'])
    },
  )

  test('asks first; Cancel leaves everything listed', { options: { fileIcons: false } }, async ($, on) => {
    const project = await started($, on, { git: true, files: { [A]: FIVE } })
    await shell($, 't1', 'sed -i s/two/TWO/ a.ts', { [A]: 'one\nTWO\nthree\nfour\nfive\n' })
    const ui = await opened($, project)

    project.answer = 'Cancel'
    await ui.press({ key: 'key-reviewed' })
    await project.clock.settle()
    expect(project.asked).toEqual(['Mark the 1 file shown reviewed?'])
    expect(await listOf(ui)).toEqual(['a.ts +1 −1'])
  })
})
