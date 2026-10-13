import { describe, expect, test } from 'claude-code/testing'
import { MOST_EDITS, edited, hunksOf, linesOf, patched } from '../hooks/diff'
import type { Hunk } from '../types'
import { iconOf } from '../hooks/icons'
import { splitHunk } from '../hooks/review'

const lines = (n: number, name = 'line') => Array.from({ length: n }, (_, i) => `${name} ${i + 1}`)

describe('hunksOf', () => {
  test('gives no hunk for the same lines', () => {
    expect(hunksOf(['a', 'b'], ['a', 'b'])).toEqual([])
  })

  test('numbers a hunk at the top from line 1, and an added side from the line that follows', () => {
    expect(hunksOf(['b'], ['a', 'b'])).toEqual([{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ['+a', ' b'] }])
  })

  test('keeps three lines of context on each side', () => {
    const before = lines(9)
    const after = before.map(line => (line === 'line 5' ? 'LINE 5' : line))

    expect(hunksOf(before, after)).toEqual([
      {
        oldStart: 2,
        oldLines: 7,
        newStart: 2,
        newLines: 7,
        lines: [' line 2', ' line 3', ' line 4', '-line 5', '+LINE 5', ' line 6', ' line 7', ' line 8'],
      },
    ])
  })

  test('joins changes up to six unchanged lines apart into one hunk, and splits those further apart', () => {
    const before = lines(20)
    const near = before.map(line => (line === 'line 2' || line === 'line 9' ? line.toUpperCase() : line))
    const far = before.map(line => (line === 'line 2' || line === 'line 10' ? line.toUpperCase() : line))

    expect(hunksOf(before, near)?.length).toBe(1)
    expect(hunksOf(before, far)?.map(hunk => [hunk.newStart, hunk.newLines])).toEqual([
      [1, 5],
      [7, 7],
    ])
  })

  test("puts a hunk's removed lines before its added ones", () => {
    expect(hunksOf(['a', 'b', 'c'], ['x', 'y', 'z'])?.[0]?.lines).toEqual(['-a', '-b', '-c', '+x', '+y', '+z'])
  })

  test('finds the shortest way through lines that repeat', () => {
    expect(hunksOf(['a', 'b', 'a', 'b'], ['b', 'a', 'b', 'a'])?.[0]?.lines).toEqual(['-a', ' b', ' a', ' b', '+a'])
  })

  // The new lines, from the old ones and the hunks between them.
  const applied = (old: readonly string[], hunks: readonly Hunk[]) => {
    const out: string[] = []
    let at = 0
    for (const hunk of hunks) {
      out.push(...old.slice(at, hunk.oldStart - 1))
      at = hunk.oldStart - 1
      for (const line of hunk.lines) {
        if (line.startsWith('+')) {
          out.push(line.slice(1))
        } else {
          if (line.startsWith(' ')) {
            out.push(line.slice(1))
          }
          at += 1
        }
      }
    }
    return [...out, ...old.slice(at)]
  }
  // The fewest lines to drop and add between two lists: what their longest
  // common subsequence leaves over.
  const fewest = (a: readonly string[], b: readonly string[]) => {
    let row = Array<number>(b.length + 1).fill(0)
    for (const x of a) {
      const next = [0]
      b.forEach((y, j) => next.push(x === y ? (row[j] ?? 0) + 1 : Math.max(row[j + 1] ?? 0, next[j] ?? 0)))
      row = next
    }
    return a.length + b.length - 2 * (row[b.length] ?? 0)
  }

  test('turns the old lines into the new ones with the fewest changes, for any texts', () => {
    let seed = 7
    const random = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
      return seed % n
    }
    const text = () => Array.from({ length: random(12) }, () => 'abc'[random(3)] ?? 'a')
    for (let round = 0; round < 300; round += 1) {
      const [a, b] = [text(), text()]
      const hunks = hunksOf(a, b) ?? []
      const changes = hunks.flatMap(hunk => hunk.lines).filter(line => !line.startsWith(' ')).length

      expect([applied(a, hunks), changes]).toEqual([b, fewest(a, b)])
    }
  })

  test('works out a file only added, or only removed, of any size', () => {
    expect(hunksOf([], lines(1_200))?.[0]?.newLines).toBe(1_200)
    expect(hunksOf(lines(1_200), [])?.[0]?.oldLines).toBe(1_200)
  })

  test(`gives up past ${MOST_EDITS} differing lines`, () => {
    expect(hunksOf(lines(600, 'old'), lines(600, 'new'))).toBeNull()
  })
})

describe('linesOf', () => {
  test('leaves out the empty line after a final newline', () => {
    expect(linesOf('a\nb\n')).toEqual(['a', 'b'])
    expect(linesOf('a\nb')).toEqual(['a', 'b'])
  })
})

describe('patched', () => {
  test('applies hunks where their old lines stand', () => {
    const hunks = [{ oldStart: 2, oldLines: 2, newStart: 2, newLines: 2, lines: [' b', '-c', '+C'] }]

    expect(patched('a\nb\nc\nd\n', hunks)).toBe('a\nb\nC\nd\n')
  })

  test('follows the marks for a side without a final newline', () => {
    const dropped = [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b', '\\ No newline at end of file'] }]
    const added = [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '\\ No newline at end of file', '+b'] }]

    expect(patched('a\n', dropped)).toBe('b')
    expect(patched('a', added)).toBe('b\n')
  })

  test('gives nothing for hunks whose old lines are not where they say', () => {
    expect(patched('a\nb\n', [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-x', '+y'] }])).toBeNull()
  })
})

describe('edited', () => {
  test('replaces the one occurrence, or every one, and says when the old text is missing', () => {
    expect(edited('a-a', 'a', 'b', false)).toBe('b-a')
    expect(edited('a-a', 'a', 'b', true)).toBe('b-b')
    expect(edited('a-a', 'c', 'b', false)).toBeNull()
  })

  test('takes the new text as it is, $ signs included', () => {
    expect(edited('price', 'price', '$&$1', false)).toBe('$&$1')
  })
})

describe('splitHunk', () => {
  test('cuts a hunk after the lines asked, each piece numbered where it starts on both sides', () => {
    const hunk = { oldStart: 4, oldLines: 4, newStart: 4, newLines: 4, lines: [' a', '-b', '+B', ' c', ' d'] }

    expect(splitHunk(hunk, new Set([2]))).toEqual([
      { oldStart: 4, oldLines: 2, newStart: 4, newLines: 2, lines: [' a', '-b', '+B'] },
      { oldStart: 6, oldLines: 2, newStart: 6, newLines: 2, lines: [' c', ' d'] },
    ])
  })

  test('makes no empty piece after the last line', () => {
    const hunk = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+A'] }

    expect(splitHunk(hunk, new Set([1]))).toEqual([hunk])
  })
})

describe('iconOf', () => {
  test("finds a file's icon as nvim-web-devicons does: by its whole name, its longest extension, any case, else the default", () => {
    expect(iconOf('/x/Dockerfile')).toEqual({ glyph: '\u{f0868}', color: '#458ee6' })
    expect(iconOf('/x/app.test.ts')).toEqual({ glyph: '\u{f499}', color: '#519aba' })
    expect(iconOf('/x/APP.TS')).toEqual({ glyph: '\u{e628}', color: '#519aba' })
    expect(iconOf('/x/notes.unknown')).toEqual({ glyph: '\u{f0f6}', color: '#6d8086' })
  })
})
