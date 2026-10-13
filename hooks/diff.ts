// Line diffs, worked out in the module: Myers' algorithm over the lines two
// texts don't share at either end, grouped into hunks with three lines of
// context, numbered as the files are.

import type { Hunk } from '../types'

export const CONTEXT = 3

// Past this many differing lines a diff is not worked out (Myers' trace
// grows with their square): the latest change's own hunks stand in.
export const MOST_EDITS = 1_000

// A text's lines, without the empty one after a final newline.
export function linesOf(text: string): string[] {
  const lines = text.split('\n')
  if (lines.at(-1) === '') {
    lines.pop()
  }

  return lines
}

type Step = ' ' | '-' | '+'

// The steps from `a` to `b`, one per line kept (' '), dropped ('-') or
// added ('+'); null past MOST_EDITS differing lines.
export function stepsOf(a: readonly string[], b: readonly string[]): Step[] | null {
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) {
    head += 1
  }
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) {
    tail += 1
  }
  const middle = myers(a.slice(head, a.length - tail), b.slice(head, b.length - tail))
  if (middle === null) {
    return null
  }

  return [...Array<Step>(head).fill(' '), ...middle, ...Array<Step>(tail).fill(' ')]
}

// Myers' O(ND) diff: for each number of edits d, the furthest point on each
// diagonal, kept per d so the path can be walked back.
function myers(a: readonly string[], b: readonly string[]): Step[] | null {
  const n = a.length
  const m = b.length
  // Only added or only removed lines need no search, however many: a new
  // file, a deleted block.
  if (n === 0 || m === 0) {
    return [...Array<Step>(n).fill('-'), ...Array<Step>(m).fill('+')]
  }
  const off = n + m
  const v = new Int32Array(2 * off + 2)
  const trace: Int32Array[] = []
  for (let d = 0; d <= Math.min(off, MOST_EDITS); d += 1) {
    for (let k = -d; k <= d; k += 2) {
      const isDown = k === -d || (k !== d && (v[off + k - 1] ?? 0) < (v[off + k + 1] ?? 0))
      let x = isDown ? (v[off + k + 1] ?? 0) : (v[off + k - 1] ?? 0) + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x += 1
        y += 1
      }
      v[off + k] = x
      if (x >= n && y >= m) {
        return walkBack(trace, n, m, d)
      }
    }
    trace.push(v.slice(off - d, off + d + 1))
  }

  return null
}

function walkBack(trace: readonly Int32Array[], n: number, m: number, edits: number): Step[] {
  const steps: Step[] = []
  let x = n
  let y = m
  for (let d = edits; d > 0; d -= 1) {
    const before = trace[d - 1] ?? new Int32Array(0)
    const at = (k: number) => before[k + d - 1] ?? 0
    const k = x - y
    const isDown = k === -d || (k !== d && at(k - 1) < at(k + 1))
    const from = isDown ? k + 1 : k - 1
    const fromX = at(from)
    const startX = isDown ? fromX : fromX + 1
    while (x > startX) {
      steps.push(' ')
      x -= 1
      y -= 1
    }
    steps.push(isDown ? '+' : '-')
    x = fromX
    y = fromX - from
  }
  while (x > 0) {
    steps.push(' ')
    x -= 1
  }

  return steps.toReversed()
}

// The hunks from `a` to `b`: each change with up to CONTEXT lines around
// it, changes that close together in one hunk. A side's start is the number
// of its first line in the hunk, or, where it has none, of the line that
// follows. Null past MOST_EDITS differing lines.
export function hunksOf(a: readonly string[], b: readonly string[]): Hunk[] | null {
  const steps = stepsOf(a, b)
  if (steps === null) {
    return null
  }

  const changed = steps.flatMap((step, i) => (step === ' ' ? [] : [i]))
  const hunks: Hunk[] = []
  let i = 0
  while (i < changed.length) {
    const first = changed[i] ?? 0
    let last = first
    while (i + 1 < changed.length && (changed[i + 1] ?? 0) - last <= 2 * CONTEXT + 1) {
      i += 1
      last = changed[i] ?? last
    }
    i += 1
    const from = Math.max(0, first - CONTEXT)
    const to = Math.min(steps.length, last + CONTEXT + 1)
    const before = steps.slice(0, from)
    let oldLine = before.filter(step => step !== '+').length
    let newLine = before.filter(step => step !== '-').length
    const hunk: Hunk = { oldStart: oldLine + 1, oldLines: 0, newStart: newLine + 1, newLines: 0, lines: [] }
    for (const step of steps.slice(from, to)) {
      if (step === '+') {
        hunk.lines.push(`+${b[newLine] ?? ''}`)
        newLine += 1
        hunk.newLines += 1
      } else if (step === '-') {
        hunk.lines.push(`-${a[oldLine] ?? ''}`)
        oldLine += 1
        hunk.oldLines += 1
      } else {
        hunk.lines.push(` ${a[oldLine] ?? ''}`)
        oldLine += 1
        newLine += 1
        hunk.oldLines += 1
        hunk.newLines += 1
      }
    }
    hunks.push(hunk)
  }

  return hunks
}

// The text after a change, from the text before it and the hunks Claude
// Code recorded for it: what the file became, whatever rules the tool
// followed. A hunk's old lines must stand where it says, or one line off;
// null where they don't. A "\ No newline at end of file" line after a side's
// last line says that side ends without one.
export function patched(before: string, hunks: readonly Hunk[]): string | null {
  const old = linesOf(before)
  const out: string[] = []
  let at = 0
  let hasNewline = before === '' || before.endsWith('\n')
  for (const hunk of hunks) {
    const olds = hunk.lines.filter(line => line.startsWith(' ') || line.startsWith('-')).map(line => line.slice(1))
    const from = [hunk.oldStart - 1, hunk.oldStart, hunk.oldStart - 2].find(start => start >= at && olds.every((line, i) => old[start + i] === line))
    if (from === undefined) {
      return null
    }
    out.push(...old.slice(at, from))
    at = from
    let last = ' '
    for (const line of hunk.lines) {
      const sign = line[0] ?? ''
      if (sign === '\\') {
        hasNewline = last === '-'
        continue
      }
      if (sign === '+' || sign === ' ') {
        out.push(line.slice(1))
      }
      if (sign === '-' || sign === ' ') {
        at += 1
      }
      last = sign
    }
  }
  out.push(...old.slice(at))

  return out.length === 0 ? '' : `${out.join('\n')}${hasNewline ? '\n' : ''}`
}

// The text after an Edit, from the text before it: its replacement made as
// Claude Code makes it, every occurrence or the one. Null where the old
// string isn't there. Only where Claude Code recorded no hunks.
export function edited(before: string, oldString: string, newString: string, isEvery: boolean): string | null {
  if (oldString === '' || !before.includes(oldString)) {
    return null
  }

  return isEvery ? before.split(oldString).join(newString) : before.replace(oldString, () => newString)
}
