// A file's icon: a Nerd Font glyph and its color, as nvim-web-devicons gives
// them (see devicons.ts), so a terminal with a Nerd Font shows the marks the
// person's editor does. The File icons option turns them off where the
// terminal's font has none.

import { BY_EXTENSION, BY_NAME } from './devicons'

export type Icon = { glyph: string; color: string }

// The tables with their keys lowercased, as nvim-web-devicons reads them: a
// key that is already lowercase keeps its entry.
function lowered(table: Readonly<Record<string, readonly [string, string]>>): Map<string, Icon> {
  const map = new Map<string, Icon>()
  for (const [key, [glyph, color]] of Object.entries(table)) {
    const lower = key.toLowerCase()
    if (key === lower || !map.has(lower)) {
      map.set(lower, { glyph, color })
    }
  }
  return map
}

const names = lowered(BY_NAME)
const extensions = lowered(BY_EXTENSION)
const DEFAULT: Icon = { glyph: '\u{f0f6}', color: '#6d8086' }

// The icon for a path, found as nvim-web-devicons finds it: by the file's
// whole name, lowercased; else by its extension, the longest first
// (`.test.ts`, then `.ts`); else the default.
export function iconOf(path: string): Icon {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  const byName = names.get(name)
  if (byName !== undefined) {
    return byName
  }
  let rest = name
  for (let dot = rest.indexOf('.'); dot >= 0; dot = rest.indexOf('.')) {
    rest = rest.slice(dot + 1)
    const byExtension = extensions.get(rest)
    if (byExtension !== undefined) {
      return byExtension
    }
  }
  return DEFAULT
}
