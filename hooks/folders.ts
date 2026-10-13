// Which folders difnote watches and where it keeps their records: the
// places on this machine it goes by, the folders it refuses, and the
// folders a shell command names. Pure: hooks/register.tsx acts on them.

// Where difnote keeps its private git folders, Claude Code's own folder, and
// the person's home folder, each found from paths alone, never from the
// environment; null where a path doesn't tell.
export type Places = { data: string; config: string | null; home: string | null }

// An installed plugin runs from <config>/plugins/cache/<marketplace>/<name>/
// <version>, and Claude Code keeps its data in <config>/plugins/data/<id>,
// <id> being name@marketplace with every character but a letter, a digit, _
// and - made a -. A plugin loaded from a folder keeps its data in that
// folder, under .data.
export function placesOf(pluginRoot: string, cwd: string): Places {
  const installed = /^(.*)\/plugins\/cache\/([^/]+)\/([^/]+)\/[^/]+\/?$/.exec(pluginRoot)
  const [, config, marketplace, name] = installed ?? []
  const home = config?.endsWith('/.claude') === true ? config.slice(0, -'/.claude'.length) : (homeOf(cwd) ?? homeOf(pluginRoot))
  if (config === undefined || marketplace === undefined || name === undefined) {
    return { data: `${pluginRoot}/.data`, config: home === null ? null : `${home}/.claude`, home }
  }

  return { data: `${config}/plugins/data/${`${name}@${marketplace}`.replaceAll(/[^A-Za-z0-9_-]/g, '-')}`, config, home }
}

// The home folder a path is in, by the shapes home folders take.
export function homeOf(path: string): string | null {
  return /^(\/home\/[^/]+|\/Users\/[^/]+|\/var\/home\/[^/]+|\/root)(?:\/|$)/.exec(path)?.[1] ?? null
}

// Whether `path` is `folder` or inside it.
export function isInside(path: string, folder: string): boolean {
  return path === folder || path.startsWith(folder === '/' ? '/' : `${folder}/`)
}

const TEMPORARY = ['/tmp', '/var/tmp', '/private/tmp', '/var/folders', '/private/var/folders']

// Why difnote won't watch a folder, or null where it will: a folder that
// holds everything, Claude Code's own, or a temporary one.
export function refusalOf(folder: string, places: Places): string | null {
  const { home, config } = places
  if (folder === '/') {
    return 'the whole disk'
  }
  if (home !== null && folder === home) {
    return 'your home folder'
  }
  if (home !== null && isInside(home, folder)) {
    return 'holds your home folder'
  }
  const name = ['Desktop', 'Documents', 'Downloads'].find(one => home !== null && folder === `${home}/${one}`)
  if (name !== undefined) {
    return `your ${name} folder`
  }
  if (config !== null && isInside(folder, config)) {
    return "Claude Code's own folder"
  }
  if (TEMPORARY.some(one => isInside(folder, one))) {
    return 'a temporary folder'
  }

  return null
}

// A folder's name for its private git folder: its own name, readable, and a
// hash of its whole path.
export function slugOf(folder: string): string {
  const name = folder
    .slice(folder.lastIndexOf('/') + 1)
    .replaceAll(/[^A-Za-z0-9_.-]/g, '-')
    .slice(0, 40)
  return `${name === '' ? 'root' : name}-${hashOf(folder)}`
}

// FNV-1a over the text's code points, forward and backward: 64 bits, as 16
// hex digits.
function hashOf(text: string): string {
  // oxlint-disable-next-line typescript/no-misused-spread -- code points, not UTF-16 units
  const points = [...text].map(char => char.codePointAt(0) ?? 0)
  const fnv = (list: readonly number[]) => list.reduce((hash, point) => Math.imul(hash ^ point, 0x01000193) >>> 0, 0x811c9dc5)
  return [fnv(points), fnv(points.toReversed())].map(hash => hash.toString(16).padStart(8, '0')).join('')
}

// A path with its `.` and `..` worked out.
export function normal(path: string): string {
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '..') {
      parts.pop()
    } else if (part !== '' && part !== '.') {
      parts.push(part)
    }
  }

  return `/${parts.join('/')}`
}

export function parentOf(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut <= 0 ? '/' : path.slice(0, cut)
}

// How many of the paths a command names difnote looks at.
export const MOST_NAMED = 20

// The folders and files a shell command names: absolute paths, paths from
// the home folder, and where it goes with cd or pushd, the session's folder
// taking a relative one. Not the system's own folders.
export function pathsIn(command: string, cwd: string, home: string | null): string[] {
  const found: string[] = []
  const add = (raw: string) => {
    const path = raw.replace(/^["']|["']$/g, '')
    const full =
      path.startsWith('~/') || path === '~' ? (home === null ? null : `${home}${path.slice(1)}`) : path.startsWith('/') ? path : `${cwd}/${path}`
    if (full === null || full.startsWith('//')) {
      return
    }
    const at = normal(full)
    if (at !== '/' && !['/dev', '/proc', '/sys'].some(one => isInside(at, one)) && !found.includes(at)) {
      found.push(at)
    }
  }
  for (const match of command.matchAll(/(?:^|[;&|({]|\bthen|\bdo|\belse)\s*(?:cd|pushd)\s+(?:--\s+)?("[^"]*"|'[^']*'|[^\s;&|)]+)/g)) {
    add(match[1] ?? '')
  }
  for (const match of command.matchAll(/(?:^|[\s"'=(<>|;&])(~?\/[^\s"'`;&|<>()${}\\]*)/g)) {
    add(match[1] ?? '')
  }

  return found.slice(0, MOST_NAMED)
}
