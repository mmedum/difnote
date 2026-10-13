import { describe, expect, test } from 'claude-code/testing'
import { entriesOf, fileOf } from '../hooks/git'

// What git 2.55 printed for `diff-tree -r -z --no-renames --no-ext-diff
// --no-textconv --patch-with-raw -U3` between two states of a folder.
// In the first: a file changed, one new, one binary new, one deleted.
const CHANGED =
  ':100644 100644 814f4a422927b82f5f8a43f8fab6d3839e3983f2 ddc897f039f57aa91e16efa6dfde386c4255206f M\0a.txt\0:000000 100644 0000000000000000000000000000000000000000 3e757656cf36eca53338e520d134963a44f793f8 A\0c.txt\0:000000 100644 0000000000000000000000000000000000000000 88768efdf77ec78c9a995f94881793be6a41752b A\0d.bin\0:100644 000000 587be6b4c3f93f93c489c0111bba5596147a26cb 0000000000000000000000000000000000000000 D\0sub/b.txt\0\0diff --git a/a.txt b/a.txt\nindex 814f4a4..ddc897f 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,3 @@\n one\n-two\n+TWO\n+three\ndiff --git a/c.txt b/c.txt\nnew file mode 100644\nindex 0000000..3e75765\n--- /dev/null\n+++ b/c.txt\n@@ -0,0 +1 @@\n+new\ndiff --git a/d.bin b/d.bin\nnew file mode 100644\nindex 0000000..88768ef\nBinary files /dev/null and b/d.bin differ\ndiff --git a/sub/b.txt b/sub/b.txt\ndeleted file mode 100644\nindex 587be6b..0000000\n--- a/sub/b.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n'
// In the second: a file that ended without a newline, a file over 1 MiB by
// its placeholder, and one deleted.
const KEPT =
  ':100644 100644 9ed40b44250875c2c4532588b014ab45a1799a0f 879de50b9a967adae6ab5fe536d4ef6e0af21bb1 M\0a.txt\0:100644 100644 d5642212f8bec8e7363c0a01828d1fc7770ae573 41f13169f558c5846448fddbba848d9a739088f2 M\0big.log\0:100644 000000 286c5f5776916d7d7d5849988ca9d83e722cf9c2 0000000000000000000000000000000000000000 D\0old.txt\0\0diff --git a/a.txt b/a.txt\nindex 9ed40b4..879de50 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n one\n-two\n\\ No newline at end of file\n+TWO\ndiff --git a/big.log b/big.log\nindex d564221..41f1316 100644\n--- a/big.log\n+++ b/big.log\n@@ -1,2 +1,2 @@\n difnote: no copy kept\n-large 1200000 1000\n+large 1200002 2000\ndiff --git a/old.txt b/old.txt\ndeleted file mode 100644\nindex 286c5f5..0000000\n--- a/old.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n'

const files = (out: string, isCut = false, sizes = new Map<string, number>()) =>
  entriesOf(out, isCut).map(entry => fileOf(entry, '/w', '/w', sizes, 0))

describe("git's difference of two states", () => {
  test('reads each file with how it changed and its hunks, a side with no lines starting at the line after', () => {
    expect(
      files(CHANGED).map(({ shown, isCreate, isDelete, hunks, added, removed, bare }) => ({
        shown,
        isCreate,
        isDelete,
        hunks,
        added,
        removed,
        bare,
      })),
    ).toEqual([
      {
        shown: 'a.txt',
        isCreate: false,
        isDelete: false,
        hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: [' one', '-two', '+TWO', '+three'] }],
        added: 2,
        removed: 1,
        bare: null,
      },
      {
        shown: 'c.txt',
        isCreate: true,
        isDelete: false,
        hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: ['+new'] }],
        added: 1,
        removed: 0,
        bare: null,
      },
      { shown: 'd.bin', isCreate: true, isDelete: false, hunks: [], added: 0, removed: 0, bare: { why: 'binary', before: null, after: null } },
      {
        shown: 'sub/b.txt',
        isCreate: false,
        isDelete: true,
        hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 0, lines: ['-x'] }],
        added: 0,
        removed: 1,
        bare: null,
      },
    ])
  })

  test("leaves out git's no-newline marks, and reads a placeholder's sizes in place of its lines", () => {
    const [text, big] = files(KEPT)

    expect(text?.hunks).toEqual([{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' one', '-two', '+TWO'] }])
    expect(big?.bare).toEqual({ why: 'large', before: 1_200_000, after: 1_200_002 })
    expect(big?.hunks).toEqual([])
  })

  test('marks the files whose patches the cut output ends before, or in, as cut, with their sizes', () => {
    const out = KEPT.slice(0, KEPT.indexOf('+large'))
    const sizes = new Map([['286c5f5776916d7d7d5849988ca9d83e722cf9c2', 5]])

    expect(files(out, true, sizes).map(({ shown, bare }) => ({ shown, bare }))).toEqual([
      { shown: 'a.txt', bare: null },
      { shown: 'big.log', bare: { why: 'cut', before: null, after: null } },
      { shown: 'old.txt', bare: { why: 'cut', before: 5, after: null } },
    ])
  })
})
