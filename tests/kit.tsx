// What the test files share: Claude Code's side beneath difnote, a
// project whose files Claude's Edit and Write change, git when a test asks
// for it, and the pane.

import type { On, SessionMessage } from 'claude-code'
import { mock } from 'claude-code/testing'
import type { Engine, MockClock, Plugin } from 'claude-code/testing'
import type { Disk } from './fakegit'
import { runGit } from './fakegit'

export const CWD = '/home/demo/app'
export const SESSION = 'session-1'
const NOW = 3_600_000

export type Project = Disk & {
  // The clock, which moves only when a test moves it; `settle` lets what
  // difnote started in the background finish.
  clock: MockClock
  // Whether Claude Code cuts git's calls short, as it does those of a hook
  // it stopped; how long, on the clock, git takes to record files; and how
  // long its difference of two states takes to come back once worked out.
  isCut: boolean
  // Whether another git holds the lock on what a review moves.
  isLocked: boolean
  recordMs: number
  diffMs: number
  // What the prompt box holds, what fills put there, and the toasts shown.
  draft: { text: string }
  toasts: string[]
  // Whether a dialog holds the keys, so the prompt box takes nothing.
  dialog: { isOpen: boolean }
  store: Map<string, unknown>
  // What Claude Code stored of the conversation, as $.session.messages reads it.
  messages: SessionMessage[]
  opened: { focus: boolean }[]
  closed: string[]
}

export type StartOptions = {
  files?: Record<string, string>
  // Whether git runs; without it, difnote sees only Claude's Edit and Write.
  git?: boolean
  // The person's git repositories, by their top folder, the files they
  // track, files git can't read, and folders that can't be listed.
  repos?: string[]
  tracked?: string[]
  unreadable?: string[]
  unlisted?: string[]
  // What Claude Code stored of the conversation, for a session that resumes.
  messages?: SessionMessage[]
  stored?: Record<string, unknown>
  // Claude Code's record of the pane, as $.ui.panes lists it.
  panes?: { isShown: boolean }[]
  // Prompts a hook beneath refuses, so Claude never gets them.
  refused?: string[]
}

// Beneath difnote: a session in CWD with `files`, Claude's Edit and
// Write changing them, the store, the prompt box, the focus ring and the
// pane's open and close. Starts the session.
export async function started($: Engine, on: On, options: StartOptions = {}): Promise<Project> {
  const project: Project = {
    files: new Map(Object.entries(options.files ?? {})),
    times: new Map(),
    written: new Map(),
    repos: options.repos ?? [],
    unreadable: new Set(options.unreadable ?? []),
    tracked: options.tracked ?? [],
    ran: [],
    clock: mock.clock(on, { now: NOW }),
    isCut: false,
    isLocked: false,
    recordMs: 0,
    diffMs: 0,
    draft: { text: '' },
    toasts: [],
    dialog: { isOpen: false },
    store: new Map(Object.entries(options.stored ?? {})),
    messages: options.messages ?? [],
    opened: [],
    closed: [],
  }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: SESSION }))
  on('session.messages', () => ({ value: project.messages }))
  on('fs.read', (_$, e) => {
    const text = project.files.get(e.path) ?? project.written.get(e.path)
    if (text === undefined) {
      throw new Error(`no such file: ${e.path}`)
    }
    return { value: text }
  })
  on('fs.write', (_$, e) => {
    project.written.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.exists', (_$, e) => ({ value: project.files.has(e.path) || project.written.has(e.path) || isFolder(project, e.path) }))
  on('fs.stat', (_$, e) => {
    const text = project.files.get(e.path) ?? project.written.get(e.path)
    if (text !== undefined) {
      return { value: { kind: 'file' as const, size: text.length, mtimeMs: project.times.get(e.path) ?? 1, isLink: false } }
    }
    if (isFolder(project, e.path)) {
      return { value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false } }
    }
    throw new Error(`ENOENT: no such file or directory, stat '${e.path}'`)
  })
  on('fs.list', (_$, e) => {
    if ((options.unlisted ?? []).includes(e.path)) {
      throw new Error(`EACCES: permission denied, scandir '${e.path}'`)
    }
    const entries = new Map<string, { name: string; kind: 'file' | 'dir'; size: number; mtimeMs: number; isLink: boolean }>()
    for (const [path, text] of [...project.files, ...project.written]) {
      if (path.startsWith(`${e.path}/`)) {
        const [name = '', ...rest] = path.slice(e.path.length + 1).split('/')
        entries.set(
          name,
          rest.length > 0
            ? { name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false }
            : { name, kind: 'file', size: text.length, mtimeMs: project.times.get(path) ?? 1, isLink: false },
        )
      }
    }
    return { value: [...entries.values()] }
  })
  if (options.git === true) {
    on('process.run', async (_$, e) => {
      if (project.isCut) {
        return { deny: 'aborted' }
      }
      if (project.isLocked && (e.init?.stdin ?? '').startsWith('update refs/difnote/base')) {
        return {
          value: {
            exitCode: 128,
            stdout: '',
            stderr: "fatal: cannot lock ref 'refs/difnote/base': Unable to create 'refs/difnote/base.lock': File exists.\n",
            isStdoutTruncated: false,
            isStderrTruncated: false,
          },
        }
      }
      if (project.recordMs > 0 && e.argv.includes('--add')) {
        await project.clock.sleep(project.recordMs)
      }
      const ran = runGit(project, e.argv, e.init?.cwd ?? CWD, e.init?.stdin ?? '', e.init?.env ?? {})
      if (project.diffMs > 0 && e.argv.includes('--patch-with-raw')) {
        await project.clock.sleep(project.diffMs)
      }
      return { value: ran }
    })
  }
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('classic.SessionStart', () => ({}))
  on('store.get', (_$, e) => ({ value: project.store.get(e.key) }))
  on('store.set', (_$, e) => {
    project.store.set(e.key, e.value)
    return { value: undefined }
  })
  on('ui.focus', () => ({}))
  on('ui.toast', (_$, e) => {
    project.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', (_$, e) => {
    project.opened.push({ focus: e.focus === true })
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_$, e) => {
    project.closed.push(e.id)
    return { value: undefined }
  })
  on('ui.panes', () => ({
    value: (options.panes ?? []).map(({ isShown }) => ({ id: 'difnote', title: 'difnote', isShown, isFocused: false, isPlaced: true })),
  }))
  on('prompt.read', () => ({ value: { text: project.draft.text, cursor: project.draft.text.length } }))
  on('prompt.fill', (_$, e) => {
    if (project.dialog.isOpen) {
      return { isFilled: false, refusal: 'dialog' as const }
    }
    project.draft.text = e.mode === 'append' ? `${project.draft.text}${e.text}` : e.text
    return { isFilled: true }
  })
  on('prompt.submit', (_$, e) => ((options.refused ?? []).includes(e.text) ? { drop: 'not now' } : { text: e.text }))
  // Each tool's input is read as text: CI type-checks without the types of
  // the built-in tools, which only an interactive session writes.
  on('tool.call', { tool: 'Edit' }, (_$, e) => {
    const [path, from, to] = [textOf(e.file_path), textOf(e.old_string), textOf(e.new_string)]
    const before = project.files.get(path) ?? ''
    const after = e.replace_all === true ? before.split(from).join(to) : before.replace(from, () => to)
    put(project, path, after)
    return {
      result: {
        filePath: path,
        oldString: from,
        newString: to,
        originalFile: before,
        structuredPatch: [],
        userModified: false,
        replaceAll: e.replace_all === true,
      },
    }
  })
  on('tool.call', { tool: 'Write' }, (_$, e) => {
    const [path, content] = [textOf(e.file_path), textOf(e.content)]
    const before = project.files.get(path)
    put(project, path, content)
    return {
      result: {
        type: before === undefined ? ('create' as const) : ('update' as const),
        filePath: path,
        content,
        structuredPatch: [],
        originalFile: before ?? null,
      },
    }
  })
  // A Google Docs server: reading a doc answers its title and link; an edit
  // answers its mode, and a doc it can't find is refused in brackets.
  on('tool.call', { tool: 'mcp__google-docs__get_document' }, (_$, e) => ({
    result: [{ type: 'text', text: `${DOC_TITLE}\nhttps://docs.google.com/document/d/${textOf(e.document)}/edit?usp=drivesdk\nrevision r1` }],
  }))
  on('tool.call', { tool: 'mcp__google-docs__edit_document' }, (_$, e) => ({
    result:
      e.document === 'missing'
        ? '[not found] no document missing'
        : JSON.stringify({ mode: e.mode ?? 'suggest', ops_applied: 1, dry_run: e.dry_run === true }),
  }))
  on('tool.call', { tool: 'mcp__google-docs__create_document' }, (_$, e) => ({
    result: `created ${textOf(e.title)}\nhttps://docs.google.com/document/d/new-doc/edit`,
  }))
  // A shell command changes the files a test gave it (see shell), and, in a
  // git repository, says which as Claude Code does.
  on('tool.call', { tool: 'Bash' }, (_$, e) => {
    const effect = commands.get(textOf(e.command))
    for (const [path, text] of Object.entries(effect?.files ?? {})) {
      put(project, path, text)
    }
    const changedFiles = effect?.reported ?? []
    return {
      result: {
        stdout: '',
        stderr: '',
        interrupted: false,
        ...(changedFiles.length === 0 ? {} : { bashEditDiff: { files: [], moreFiles: 0, changedFiles } }),
      },
    }
  })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  // The session's folder's first record, which difnote takes in the
  // background.
  await project.clock.settle()

  return project
}

// What each shell command a test runs does: the files it writes (null
// deletes one), and the ones Claude Code reports it changed.
type Effect = { files: Record<string, string | null>; reported: string[] }
const commands = new Map<string, Effect>()

// A file as a shell command, a formatter or the person leaves it: its text
// (null for gone), and when it changed, after every change before it.
export function put(project: Disk, path: string, text: string | null) {
  if (text === null) {
    project.files.delete(path)
    project.times.delete(path)
    return
  }
  project.files.set(path, text)
  project.times.set(path, Math.max(1_000, ...project.times.values()) + 1)
}

const textOf = (value: unknown) => (typeof value === 'string' ? value : '')

// The title the kit's Google Docs server gives every doc.
export const DOC_TITLE = 'Board memo'

// Claude's call of a Google Docs tool, by the end of its name.
export function docTool($: Engine, id: string, name: string, input: Record<string, unknown>) {
  // The engine's types know the MCP tools of the session that wrote them,
  // which CI's has none of; the call itself takes any MCP tool's name.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const call = { tool: `mcp__google-docs__${name}`, tool_use_id: id, ...input } as unknown as Parameters<Engine['tool']['call']>[0]
  return $.tool.call(call)
}

// Claude's shell command, which writes `files`; Claude Code reports
// `reported` changed, as it does in a git repository.
export function shell($: Engine, id: string, line: string, files: Record<string, string | null>, reported: string[] = []) {
  commands.set(line, { files, reported })
  return $.tool.call({ tool: 'Bash', tool_use_id: id, command: line })
}

// Whether a path is a folder: the session's or one above it, the temporary
// folder, a git repository or its .git, or one that holds a file.
function isFolder(project: Disk, path: string): boolean {
  return (
    `${CWD}/`.startsWith(`${path}/`) ||
    project.repos.some(repo => path === `${repo}/.git`) ||
    path === '/tmp' ||
    project.repos.includes(path) ||
    [...project.files.keys(), ...project.written.keys()].some(one => one.startsWith(`${path}/`))
  )
}

// A call made in a subagent's loop. The kit's $ carries agentId as the query
// loop does, though the types of a call's input leave it out.
function inAgent<T extends object>(input: T, agentId: string | undefined): T {
  return agentId === undefined ? input : { ...input, agentId }
}

// Claude's Edit of a file in CWD, from its main conversation or a subagent's.
export function edit($: Engine, id: string, file: string, from: string, to: string, agentId?: string) {
  return $.tool.call(inAgent({ tool: 'Edit' as const, tool_use_id: id, file_path: `${CWD}/${file}`, old_string: from, new_string: to }, agentId))
}

// Claude's Write of a file in CWD, or of one elsewhere by its full path.
export function write($: Engine, id: string, file: string, content: string) {
  return $.tool.call({ tool: 'Write', tool_use_id: id, file_path: file.startsWith('/') ? file : `${CWD}/${file}`, content })
}

// The person's own prompt, sent from the prompt box.
export function send($: Engine, text: string) {
  return $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
}

// Closes the pane as its close mark does, through difnote' ui.close
// hook: another plugin's $.ui.close, run by its command.
export const CLOSER: Plugin = {
  name: 'closer',
  register: on => {
    on('command.run', { command: 'close-review' }, async $ => {
      // A close difnote refuses, to step back, rejects here.
      await $.ui.close({ id: 'difnote' }).catch(() => undefined)
      return {}
    })
  },
}

export function closeMark($: Engine) {
  return $.command.run({ command: 'close-review', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
}

// The person moves Claude Code's focus ring onto an element of the pane.
export function moveTo($: Engine, element: string) {
  return $.ui.focus({ component: 'Pane', requestId: 'difnote', element, origin: { kind: 'person' } })
}

// The person's command: open or close the pane.
export function command($: Engine) {
  return $.command.run({ command: 'difnote', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
}

// The pane as a terminal docks it, `columns` wide.
export function mount($: Engine, columns = 60) {
  return $.ui.mount({
    plugin: 'difnote',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'difnote',
    props: { title: 'difnote', isFocused: true, bodyColumns: columns, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  })
}

export type Mounted = Awaited<ReturnType<typeof mount>>

// Every text the pane draws, in order.
export async function textsOf(ui: Mounted): Promise<string[]> {
  return (await ui.findAll({ type: 'Text' })).map(text => text.text ?? '')
}

// The texts of the Buttons whose keys start with `prefix`, in order: the
// list's files with `file:`, a picked hunk's lines with `line:`.
export async function buttonsOf(ui: Mounted, prefix: string): Promise<string[]> {
  const buttons = await ui.findAll({ type: 'Button' })
  return buttons.filter(button => button.key?.startsWith(prefix) === true).map(button => button.text ?? '')
}

// The hunks drawn as highlighted code: each one's file and source.
// Whether the note field is open, and under which row.
export async function fieldUnder(ui: Mounted): Promise<string | undefined> {
  const boxes = await ui.findAll({ type: 'Box' })
  return boxes.find(box => box.key?.startsWith('field:') === true)?.key?.slice('field:'.length)
}

export async function codeOf(ui: Mounted): Promise<{ path: unknown; source: unknown }[]> {
  return (await ui.findAll({ type: 'Code' })).map(code => ({ path: code.props.path, source: code.props.source }))
}
