// A git in the test's memory: the commands hooks/register.tsx runs, as git
// answers them, over the person's files as the kit holds them. Enough of
// git for difnote's private git folders, no more: ignore rules are `name/`,
// `/*/` and `*.ext` lines, and the diff is hooks/diff.ts's, in git's format.

import { hunksOf, linesOf } from '../hooks/diff'
import type { Hunk } from '../types'

export type Disk = {
  // The person's files, by absolute path, and when each last changed.
  files: Map<string, string>
  times: Map<string, number>
  // The files difnote wrote, its private git folders' own.
  written: Map<string, string>
  // The person's git repositories, by their top folder.
  repos: string[]
  // Files git can't read, and files the person's repositories track.
  unreadable: Set<string>
  tracked: string[]
  // Each command git ran: where, with what on standard input, and git's
  // variables it was given.
  ran: { argv: readonly string[]; cwd: string; stdin: string; env: Record<string, string> }[]
}

type Store = {
  index: Map<string, { text: string; isPlaceholder: boolean }>
  trees: Map<string, Map<string, string>>
  refs: Map<string, string>
  objects: Map<string, string>
}
type Ran = { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: boolean; isStderrTruncated: boolean }

const stores = new Map<string, Store>()

const done = (stdout = ''): Ran => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
const failed = (exitCode: number, stderr: string): Ran => ({ exitCode, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false })

// One command, run in `cwd` with `stdin`, as git would.
export function runGit(disk: Disk, argv: readonly string[], cwd: string, stdin: string, env: Record<string, string> = {}): Ran {
  disk.ran.push({ argv, cwd, stdin, env })
  const command = argv.slice(1).join(' ')
  if (command === '--version') {
    return done('git version 2.55.0\n')
  }
  if (command === 'config --global --path --get core.excludesFile') {
    return failed(1, '')
  }
  // difnote's own commands name their private git folder in GIT_DIR.
  const gitDir = env.GIT_DIR ?? ''
  if (command === 'init --quiet') {
    stores.set(gitDir, { index: new Map(), trees: new Map(), refs: new Map(), objects: new Map() })
    disk.written.set(`${gitDir}/HEAD`, 'ref: refs/heads/main\n')
    disk.written.set(`${gitDir}/config`, '[core]\n\trepositoryformatversion = 0\n\tbare = false\n')
    return done()
  }
  // The files a repository tracks though its .gitignore matches them.
  if (command === '--no-optional-locks ls-files -z --cached --ignored --exclude-standard') {
    const isIgnored = ignoring(disk, '', cwd)
    const found = disk.tracked.filter(path => path.startsWith(`${cwd}/`)).map(path => path.slice(cwd.length + 1))
    return done(
      found
        .filter(isIgnored)
        .map(path => `${path}\0`)
        .join(''),
    )
  }

  const store = stores.get(gitDir)
  const config = disk.written.get(`${gitDir}/config`) ?? ''
  const tree = /worktree = "((?:[^"\\]|\\.)*)"/.exec(config)?.[1]?.replaceAll(/\\(.)/g, '$1')
  if (store === undefined || tree === undefined) {
    return failed(128, `fatal: not a git repository: ${gitDir}\n`)
  }
  // Run from inside its work tree, git reads paths, and a ref's name, as
  // that folder's files.
  if (cwd === tree || cwd.startsWith(`${tree}/`)) {
    return failed(128, `fatal: ambiguous argument: run from ${cwd}, inside the work tree\n`)
  }
  const isIgnored = ignoring(disk, gitDir, tree)
  const inside = [...disk.files.keys()].filter(path => path.startsWith(`${tree}/`)).map(path => path.slice(tree.length + 1))
  const nested = disk.repos.filter(repo => repo.startsWith(`${tree}/`)).map(repo => repo.slice(tree.length + 1))
  const inNested = (path: string) => nested.some(repo => path.startsWith(`${repo}/`))
  const paths = stdin.split('\0').filter(path => path !== '')

  switch (command) {
    case 'ls-files -z --others --exclude-standard':
      return done(
        [
          ...nested.filter(repo => !isIgnored(`${repo}/`)).map(repo => `${repo}/`),
          ...inside.filter(path => !store.index.has(path) && !inNested(path) && !isIgnored(path)),
        ]
          .toSorted()
          .map(path => `${path}\0`)
          .join(''),
      )
    case 'diff-files -z --name-only':
      return done(
        [...store.index]
          .filter(([path, one]) => one.isPlaceholder || disk.files.get(`${tree}/${path}`) !== one.text)
          .map(([path]) => `${path}\0`)
          .join(''),
      )
    case 'update-index -z --add --remove --stdin': {
      const index = new Map(store.index)
      for (const path of paths) {
        const full = `${tree}/${path}`
        if (disk.unreadable.has(full)) {
          return failed(128, `error: open("${path}"): Permission denied\nfatal: Unable to process path ${path}\n`)
        }
        if ([...disk.files.keys()].some(one => one.startsWith(`${full}/`))) {
          return failed(128, `error: ${path}: is a directory - add files inside instead\nfatal: Unable to process path ${path}\n`)
        }
        const text = disk.files.get(full)
        if (text === undefined) {
          index.delete(path)
        } else {
          index.set(path, { text, isPlaceholder: false })
        }
      }
      store.index = index
      return done()
    }
    case 'update-index -z --force-remove --stdin':
      for (const path of paths) {
        store.index.delete(path)
      }
      return done()
    case 'update-index -z --index-info':
      for (const line of paths) {
        const [, id = '', path = ''] = /^100644 (\S+)\t(.*)$/.exec(line) ?? []
        store.index.set(path, { text: store.objects.get(id) ?? '', isPlaceholder: true })
      }
      return done()
    case 'fast-import --quiet --done': {
      const ids: string[] = []
      let rest = stdin
      for (let blob = /^blob\nmark :\d+\ndata (\d+)\n/.exec(rest); blob !== null; blob = /^blob\nmark :\d+\ndata (\d+)\n/.exec(rest)) {
        const start = blob[0].length
        const text = rest.slice(start, start + Number(blob[1]))
        ids.push(objectOf(store, text))
        rest = rest.slice(start + text.length).replace(/^\nget-mark :\d+\n/, '')
      }
      return done(ids.map(id => `${id}\n`).join(''))
    }
    case 'write-tree': {
      const snapshot = new Map([...store.index].map(([path, one]) => [path, one.text]))
      const id = `t${hashOf(JSON.stringify([...snapshot].toSorted(([x], [y]) => (x < y ? -1 : 1))))}`
      store.trees.set(id, snapshot)
      return done(`${id}\n`)
    }
    case 'update-ref --stdin':
      for (const line of stdin.split('\n').filter(one => one !== '')) {
        const [verb, ref = '', id = ''] = line.split(' ')
        // git keeps each in a file of its own, which difnote reads.
        if (verb === 'delete') {
          store.refs.delete(ref)
          disk.written.delete(`${gitDir}/${ref}`)
        } else {
          store.refs.set(ref, id)
          disk.written.set(`${gitDir}/${ref}`, `${id}\n`)
        }
      }
      return done()
    case 'rev-parse --verify --quiet refs/difnote/base': {
      const id = store.refs.get('refs/difnote/base')
      return id === undefined ? failed(1, '') : done(`${id}\n`)
    }
    case 'diff-tree -r -z --no-renames --no-ext-diff --no-textconv --patch-with-raw -U3 refs/difnote/base refs/difnote/shown --':
      return done(
        diffOf(
          store,
          store.trees.get(store.refs.get('refs/difnote/base') ?? '') ?? new Map(),
          store.trees.get(store.refs.get('refs/difnote/shown') ?? '') ?? new Map(),
        ),
      )
    case 'cat-file --batch-check':
      return done(
        stdin
          .split('\n')
          .filter(id => id !== '')
          .map(id => {
            const text = store.objects.get(id)
            return text === undefined ? `${id} missing\n` : `${id} blob ${text.length}\n`
          })
          .join(''),
      )
    case 'check-ignore -z --stdin': {
      const found = paths.filter(isIgnored)
      return found.length === 0 ? failed(1, '') : done(found.map(path => `${path}\0`).join(''))
    }
    case 'read-tree --empty':
      store.index.clear()
      return done()
    case 'gc --quiet --prune=1.hour.ago':
      return done()
    default:
      return failed(129, `usage: git ${command}\n`)
  }
}

// Whether a path in the work tree is ignored: by the private folder's
// info/exclude or the work tree's own .gitignore.
function ignoring(disk: Disk, gitDir: string, tree: string): (path: string) => boolean {
  const rules = [...(disk.written.get(`${gitDir}/info/exclude`) ?? '').split('\n'), ...(disk.files.get(`${tree}/.gitignore`) ?? '').split('\n')]
    .map(line => line.trim())
    .filter(line => line !== '' && !line.startsWith('#'))
  return path =>
    rules.some(rule => {
      if (rule === '/*/') {
        return path.includes('/')
      }
      if (rule.startsWith('*.')) {
        return path.endsWith(rule.slice(1))
      }
      if (rule.endsWith('/')) {
        return `/${path}`.includes(`/${rule}`)
      }
      return path === rule || path.endsWith(`/${rule}`)
    })
}

function objectOf(store: Store, text: string): string {
  const id = `o${hashOf(text)}`
  store.objects.set(id, text)
  return id
}

function hashOf(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0
  }
  return `${hash.toString(16).padStart(8, '0')}${text.length.toString(16).padStart(8, '0')}`
}

const NONE = '0000000000000000'

// diff-tree's output for two states: the changed files, NUL-separated, a
// NUL, then each one's patch.
function diffOf(store: Store, before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): string {
  const paths = [...new Set([...before.keys(), ...after.keys()])].toSorted().filter(path => before.get(path) !== after.get(path))
  if (paths.length === 0) {
    return ''
  }
  const sides = paths.map(path => {
    const old = before.get(path)
    const now = after.get(path)
    return {
      path,
      old,
      now,
      status: old === undefined ? 'A' : now === undefined ? 'D' : 'M',
      from: old === undefined ? NONE : objectOf(store, old),
      to: now === undefined ? NONE : objectOf(store, now),
    }
  })
  const raw = sides
    .map(
      one =>
        `:${one.old === undefined ? '000000' : '100644'} ${one.now === undefined ? '000000' : '100644'} ${one.from} ${one.to} ${one.status}\0${one.path}\0`,
    )
    .join('')
  const patches = sides.map(one => {
    const head = [
      `diff --git a/${one.path} b/${one.path}`,
      ...(one.status === 'A' ? ['new file mode 100644'] : one.status === 'D' ? ['deleted file mode 100644'] : []),
      `index ${one.from.slice(0, 7)}..${one.to.slice(0, 7)}`,
    ]
    if ((one.old ?? '').includes('\0') || (one.now ?? '').includes('\0')) {
      return [
        ...head,
        `Binary files ${one.old === undefined ? '/dev/null' : `a/${one.path}`} and ${one.now === undefined ? '/dev/null' : `b/${one.path}`} differ`,
        '',
      ].join('\n')
    }
    const hunks = hunksOf(linesOf(one.old ?? ''), linesOf(one.now ?? '')) ?? []
    return [
      ...head,
      `--- ${one.old === undefined ? '/dev/null' : `a/${one.path}`}`,
      `+++ ${one.now === undefined ? '/dev/null' : `b/${one.path}`}`,
      ...hunks.flatMap(hunkLines),
      '',
    ].join('\n')
  })
  return `${raw}\0${patches.join('')}`
}

// A hunk as git prints it: a side with no lines numbered from the line
// before it, a count of 1 left out.
function hunkLines(hunk: Hunk): string[] {
  const side = (start: number, count: number) => `${count === 0 ? start - 1 : start}${count === 1 ? '' : `,${count}`}`
  return [`@@ -${side(hunk.oldStart, hunk.oldLines)} +${side(hunk.newStart, hunk.newLines)} @@`, ...hunk.lines]
}
