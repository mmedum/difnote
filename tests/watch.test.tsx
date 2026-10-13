import { describe, expect, test } from 'claude-code/testing'
import { CWD, buttonsOf, codeOf, command, edit, mount, moveTo, send, shell, started, textsOf, write } from './kit'
import type { Mounted } from './kit'

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

    expect(await buttonsOf(ui, 'file:')).toEqual([`${TS}a.ts +1 −1`])
    await ui.press({ key: `file:${A}` })
    expect(await codeOf(ui)).toEqual([{ path: A, source: '@@ -1,5 +1,5 @@\n one\n-two\n+TWO\n three\n four\n five' }])
  })

  test('says since when, and lists new and deleted files too, the one changed last first', async ($, on) => {
    const project = await started($, on, { git: true, files: { [A]: FIVE, [`${CWD}/c.ts`]: 'gone\n' } })
    await shell($, 't1', 'sed -i s/two/TWO/ a.ts', { [A]: 'one\nTWO\nthree\nfour\nfive\n' })
    await shell($, 't2', 'mv c.ts b.ts', { [B]: 'gone\n', [`${CWD}/c.ts`]: null })
    const ui = await opened($, project)

    expect((await textsOf(ui))[0]).toMatch(/^since \d\d:\d\d · 3 files \+2 −2$/)
    expect(await buttonsOf(ui, 'file:')).toEqual([`${TS}b.ts new`, `${TS}a.ts +1 −1`, `${TS}c.ts deleted`])
    await ui.press({ key: `file:${B}` })
    expect(await codeOf(ui)).toEqual([{ path: B, source: '@@ -0,0 +1,1 @@\n+gone' }])
    await ui.press({ key: 'back' })
    await ui.press({ key: `file:${CWD}/c.ts` })
    expect(await codeOf(ui)).toEqual([{ path: `${CWD}/c.ts`, source: '@@ -1,1 +0,0 @@\n-gone' }])
  })

  test('lists a file that became a folder as gone, and the files in the folder as new', { options: { fileIcons: false } }, async ($, on) => {
    const thing = `${CWD}/thing`
    const project = await started($, on, { git: true, files: { [thing]: 'a file\n' } })
    await shell($, 't1', 'rm thing && mkdir thing && touch thing/inner.ts', { [thing]: null, [`${thing}/inner.ts`]: 'inside\n' })
    const ui = await opened($, project)

    expect(await buttonsOf(ui, 'file:')).toEqual(['thing/inner.ts new', 'thing deleted'])
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

      expect(await buttonsOf(ui, 'file:')).toEqual(['.env secret', 'pic.bin binary', 'big.txt over 1 MiB'])
      await ui.press({ key: `file:${big}` })
      expect(await textsOf(ui)).toContain('Over 1 MiB, so difnote keeps no copy of it: no lines to show. 1.0 MB → 1.1 MB.')
      await ui.press({ key: 'back' })
      await ui.press({ key: `file:${secret}` })
      expect(await textsOf(ui)).toContain('Named like a secret, so difnote keeps no copy of it: no lines to show. 4 B → 5 B.')
      await ui.press({ key: 'back' })
      await ui.press({ key: `file:${picture}` })
      expect(await textsOf(ui)).toContain('A binary file: no lines to show. 3 B → 4 B.')
    },
  )

  test('gives the sizes of a large file in bytes when they read the same rounded', { options: { fileIcons: false } }, async ($, on) => {
    const big = `${CWD}/big.log`
    const project = await started($, on, { git: true, files: { [big]: 'x'.repeat(1_200_000) } })
    await shell($, 't1', 'echo yy >> big.log', { [big]: 'x'.repeat(1_200_002) })
    const ui = await opened($, project)

    await ui.press({ key: `file:${big}` })
    expect(await textsOf(ui)).toContain('Over 1 MiB, so difnote keeps no copy of it: no lines to show. 1,200,000 B → 1,200,002 B.')
  })

  test("looks again after Claude's change while the pane is shown", { options: { fileIcons: false } }, async ($, on) => {
    const project = await started($, on, { git: true, files: { [A]: FIVE }, panes: [{ isShown: true }] })
    const ui = await mount($)
    await shell($, 't1', 'sed -i s/two/TWO/ a.ts', { [A]: 'one\nTWO\nthree\nfour\nfive\n' })
    await project.clock.settle()

    expect(await buttonsOf(ui, 'file:')).toEqual(['a.ts +1 −1'])
  })

  test('a key pressed in the pane looks again when its last look is over 2 seconds old', { options: { fileIcons: false } }, async ($, on) => {
    const project = await started($, on, { git: true, files: { [A]: FIVE } })
    const ui = await opened($, project)
    await shell($, 't1', 'sed -i s/two/TWO/ a.ts', { [A]: 'one\nTWO\nthree\nfour\nfive\n' })
    await project.clock.advance(2_001)

    await moveTo($, 'key-next')
    await project.clock.settle()
    expect(await buttonsOf(ui, 'file:')).toEqual(['a.ts +1 −1'])
  })

  test('a look Claude Code cuts short keeps what the pane showed', { options: { fileIcons: false } }, async ($, on) => {
    const project = await started($, on, { git: true, files: { [A]: FIVE } })
    await shell($, 't1', 'sed -i s/two/TWO/ a.ts', { [A]: 'one\nTWO\nthree\nfour\nfive\n' })
    const ui = await opened($, project)
    await project.clock.advance(2_001)

    project.isCut = true
    await moveTo($, 'key-next')
    await project.clock.settle()
    expect(await buttonsOf(ui, 'file:')).toEqual(['a.ts +1 −1'])
    expect(await textsOf(ui)).not.toContain("Not watched, so only Claude's Edit and Write show there:")
    project.isCut = false
    await shell($, 't2', 'touch b.ts', { [B]: '' })
    await ui.press({ key: 'key-reviewed' })
    await project.clock.advance(2_001)
    await moveTo($, 'key-next')
    await project.clock.settle()
    expect(await buttonsOf(ui, 'file:')).toEqual(['b.ts new'])
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

      expect(await buttonsOf(await opened($, project), 'file:')).toEqual(['vendor/lib/y.ts +1 −1'])
    },
  )

  test("shows the rest of a change when git can't read a file, which shows without lines", { options: { fileIcons: false } }, async ($, on) => {
    const locked = `${CWD}/locked.txt`
    const project = await started($, on, { git: true, files: { [A]: FIVE }, unreadable: [locked] })
    await shell($, 't1', 'make', { [A]: 'one\nTWO\nthree\nfour\nfive\n', [locked]: 'secret\n' })
    const ui = await opened($, project)

    expect(await buttonsOf(ui, 'file:')).toEqual(['locked.txt new unreadable', 'a.ts +1 −1'])
  })

  test('shows the change of a file Claude wrote that the folder ignores, by its record', { options: { fileIcons: false } }, async ($, on) => {
    const project = await started($, on, { git: true })
    await write($, 't1', 'node_modules/x/i.js', 'hello\n')
    const ui = await opened($, project)

    expect(await buttonsOf(ui, 'file:')).toEqual(['node_modules/x/i.js new'])
  })
})

describe('the folders it finds', () => {
  test('watches a git repository a shell command goes into, from before the command runs', async ($, on) => {
    const lib = '/home/demo/lib'
    const project = await started($, on, { git: true, repos: [lib], files: { [`${lib}/x.ts`]: 'a\n' } })
    await shell($, 't1', 'cd ../lib && sed -i s/a/b/ x.ts', { [`${lib}/x.ts`]: 'b\n' })
    const ui = await opened($, project)

    expect(await buttonsOf(ui, 'file:')).toEqual([`${TS}${lib}/x.ts +1 −1`])
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

      expect(await buttonsOf(ui, 'file:')).toEqual([`${notes}/list.md +1 −0`, `${notes}/todo.md +1 −1`])
    },
  )

  test("watches a repository inside the session's folder on its own, its files listed once", async ($, on) => {
    const lib = `${CWD}/vendor/lib`
    const project = await started($, on, { git: true, repos: [lib], files: { [`${lib}/y.ts`]: 'a\n' } })
    await shell($, 't1', 'sed -i s/a/b/ vendor/lib/y.ts', { [`${lib}/y.ts`]: 'b\n' })
    const ui = await opened($, project)

    expect(await buttonsOf(ui, 'file:')).toEqual([`${TS}vendor/lib/y.ts +1 −1`])
  })

  test(
    "doesn't watch your home folder or a temporary one, says so, and shows Claude's Edit and Write there",
    { options: { fileIcons: false } },
    async ($, on) => {
      const project = await started($, on, { git: true })
      await write($, 't1', '/home/demo/x.md', 'hello\n')
      await write($, 't2', '/tmp/scratch/a.txt', 'hi\n')
      const ui = await opened($, project)

      expect(await buttonsOf(ui, 'file:')).toEqual(['/tmp/scratch/a.txt new', '/home/demo/x.md new'])
      expect((await textsOf(ui)).slice(-3)).toEqual([
        "Not watched, so only Claude's Edit and Write show there:",
        '  /home/demo (your home folder)',
        '  /tmp (a temporary folder)',
      ])
    },
  )

  test(
    "doesn't watch a folder outside your home folder that isn't a git repository, and says so",
    { options: { fileIcons: false } },
    async ($, on) => {
      const project = await started($, on, { git: true, files: { '/etc/demo.conf': 'x = 1\n' } })
      await write($, 't1', '/etc/demo.conf', 'x = 2\n')
      const ui = await opened($, project)

      expect(await buttonsOf(ui, 'file:')).toEqual(['/etc/demo.conf +1 −1'])
      expect((await textsOf(ui)).slice(-2)).toEqual(["Not watched, so only Claude's Edit and Write show there:", '  /etc (outside your home folder)'])
    },
  )

  test("doesn't watch a folder over 50,000 files, and says so", async ($, on) => {
    const many = Object.fromEntries(Array.from({ length: 50_001 }, (_, i) => [`${CWD}/f${i}.txt`, 'x\n']))
    const project = await started($, on, { git: true, files: many })
    const ui = await opened($, project)

    expect((await textsOf(ui)).slice(-2)).toEqual(["Not watched, so only Claude's Edit and Write show there:", `  ${CWD} (over 50,000 files)`])
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

      expect(await buttonsOf(await opened($, project), 'file:')).toEqual([`${notes}/todo.md +1 −1`])
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
      await moveTo($, 'key-next')
      await project.clock.settle()
      expect(await buttonsOf(ui, 'file:')).toEqual([`${todo} +2 −0`])
    },
  )

  test("shows Claude's change of a file a repository inside the folder ignores, by its record", { options: { fileIcons: false } }, async ($, on) => {
    const lib = `${CWD}/vendor/lib`
    const project = await started($, on, { git: true, repos: [lib], files: { [`${lib}/.gitignore`]: 'out.js\n', [`${lib}/y.ts`]: 'a\n' } })
    await write($, 't1', `${lib}/out.js`, 'built\n')

    expect(await buttonsOf(await opened($, project), 'file:')).toEqual(['vendor/lib/out.js new'])
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

      expect(await buttonsOf(await opened($, project), 'file:')).toEqual(['dist/extra.js new', 'dist/app.js +1 −1'])
    },
  )

  test('starts a folder unused for 30 days over: what changed before shows no more', async ($, on) => {
    const project = await started($, on, { git: true, files: { [A]: FIVE } })
    await shell($, 't1', 'sed -i s/two/TWO/ a.ts', { [A]: 'one\nTWO\nthree\nfour\nfive\n' })
    await project.clock.advance(31 * 24 * 60 * 60 * 1000)

    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await project.clock.settle()
    expect(await textsOf(await opened($, project))).toEqual([expect.stringMatching(/^No changes since (\d+ \w+ )?\d\d:\d\d\.$/)])
  })
})

describe('a review', () => {
  test('ends with your prompt: what changes after shows next, also what changed while you looked', async ($, on) => {
    const project = await started($, on, { git: true, files: { [A]: FIVE } })
    await shell($, 't1', 'sed -i s/two/TWO/ a.ts', { [A]: 'one\nTWO\nthree\nfour\nfive\n' })
    await (await opened($, project)).unmount()
    await shell($, 't2', 'touch b.ts', { [B]: '' })

    await send($, 'Thanks, go on')
    expect(await buttonsOf(await opened($, project), 'file:')).toEqual([`${TS}b.ts new`])
  })

  test('r marks everything shown reviewed', async ($, on) => {
    const project = await started($, on, { git: true, files: { [A]: FIVE } })
    await shell($, 't1', 'sed -i s/two/TWO/ a.ts', { [A]: 'one\nTWO\nthree\nfour\nfive\n' })
    const ui = await opened($, project)

    await ui.press({ key: 'key-reviewed' })
    await project.clock.settle()
    expect(await textsOf(ui)).toEqual([expect.stringMatching(/^No changes since \d\d:\d\d\.$/)])
  })

  test("r leaves a folder's changes listed when git couldn't mark them reviewed", { options: { fileIcons: false } }, async ($, on) => {
    const project = await started($, on, { git: true, files: { [A]: FIVE } })
    await shell($, 't1', 'sed -i s/two/TWO/ a.ts', { [A]: 'one\nTWO\nthree\nfour\nfive\n' })
    const ui = await opened($, project)

    project.isLocked = true
    const pressing = ui.press({ key: 'key-reviewed' })
    await project.clock.advance(5_000)
    await pressing
    expect(await buttonsOf(ui, 'file:')).toEqual(['a.ts +1 −1'])
  })

  test('r during a look: the look, from before the review ended, is made again', { options: { fileIcons: false } }, async ($, on) => {
    const project = await started($, on, { git: true, files: { [A]: FIVE } })
    await shell($, 't1', 'sed -i s/two/TWO/ a.ts', { [A]: 'one\nTWO\nthree\nfour\nfive\n' })
    const ui = await opened($, project)
    await shell($, 't2', 'touch b.ts', { [B]: '' })
    project.diffMs = 1_000
    await project.clock.advance(2_001)
    await moveTo($, 'key-next')

    await ui.press({ key: 'key-reviewed' })
    project.diffMs = 0
    await project.clock.advance(1_000)
    await project.clock.settle()
    expect(await buttonsOf(ui, 'file:')).toEqual(['b.ts new'])
  })

  test('after a restart, takes up from the review that ended before it', async ($, on) => {
    const project = await started($, on, { git: true, files: { [A]: FIVE } })
    await shell($, 't1', 'sed -i s/two/TWO/ a.ts', { [A]: 'one\nTWO\nthree\nfour\nfive\n' })
    await (await opened($, project)).unmount()
    await send($, 'Thanks')
    await shell($, 't2', 'touch b.ts', { [B]: '' })

    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await project.clock.settle()
    expect(await buttonsOf(await opened($, project), 'file:')).toEqual([`${TS}b.ts new`])
  })
})

describe('unsent notes', () => {
  test('stay through /clear', async ($, on) => {
    const project = await started($, on, { git: true, files: { [A]: FIVE } })
    await edit($, 't1', 'a.ts', 'two', 'TWO')
    const ui = await opened($, project)
    await moveTo($, `file:${A}`)
    await ui.press({ key: 'key-note' })
    await ui.input({ key: 'note-field', text: 'Why this file?' })

    await $.classic.SessionStart({ source: 'clear' })
    expect(await buttonsOf(ui, 'file:')).toEqual([`${TS}a.ts +1 −1 ✎1`])
    await ui.press({ key: 'send' })
    expect(project.draft.text).toBe('Notes on the changes:\n\na.ts\nWhy this file?')
  })

  test("stay through a restart, and keep to the session's folder: one in another folder has its own", async ($, on) => {
    const note = { target: `file:${A}`, path: A, anchor: 'a.ts', quote: [], text: 'Why this file?' }
    const other = [{ ...note, text: 'Not here' }]
    const project = await started($, on, { git: true, files: { [A]: FIVE }, stored: { notes: { [CWD]: [note], '/home/demo/other': other } } })
    await shell($, 't1', 'sed -i s/two/TWO/ a.ts', { [A]: 'one\nTWO\nthree\nfour\nfive\n' })
    const ui = await opened($, project)

    expect(await buttonsOf(ui, 'file:')).toEqual([`${TS}a.ts +1 −1 ✎1`])
    await ui.press({ key: 'send' })
    expect(project.draft.text).toBe('Notes on the changes:\n\na.ts\nWhy this file?')
    expect(project.store.get('notes')).toEqual({ '/home/demo/other': other })
  })

  test('show when nothing is changed any more, and s still sends them', async ($, on) => {
    const project = await started($, on, { git: true, files: { [A]: FIVE } })
    await shell($, 't1', 'sed -i s/two/TWO/ a.ts', { [A]: 'one\nTWO\nthree\nfour\nfive\n' })
    const ui = await opened($, project)
    await moveTo($, `file:${A}`)
    await ui.press({ key: 'key-note' })
    await ui.input({ key: 'note-field', text: 'Why this file?' })

    await shell($, 't2', 'git checkout a.ts', { [A]: FIVE })
    await project.clock.advance(2_001)
    await moveTo($, 'key-next')
    await project.clock.settle()
    expect(await textsOf(ui)).toContain('  ✎ a.ts · Why this file?')
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

    const own = project.ran.filter(one => one.argv.includes('--git-dir=.') || one.argv.includes('init'))
    const named = own.map(({ env }) => ({
      dir: env.GIT_DIR ?? '',
      index: env.GIT_INDEX_FILE,
      tree: env.GIT_WORK_TREE,
      objects: env.GIT_OBJECT_DIRECTORY,
    }))
    expect(named.length).toBeGreaterThan(5)
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
