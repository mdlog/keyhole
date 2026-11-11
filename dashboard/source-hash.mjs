/**
 * The console's source fingerprint. `vite build` writes it to docs/build.json; test/dashboard.test.ts recomputes it,
 * so a docs/ built from older source fails `npm test` without the test having to run Vite.
 * sha256 over each input's repo-style path and its text, CRLF read as LF, in sorted path order.
 */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

export const SOURCE_INPUTS = ['index.html', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'source-hash.mjs', 'src']

function collect(path, out) {
  if (statSync(path).isDirectory()) {
    for (const entry of readdirSync(path)) collect(join(path, entry), out)
  } else {
    out.push(path)
  }
}

export function sourceHash(root) {
  const files = []
  for (const input of SOURCE_INPUTS) collect(join(root, input), files)
  const named = files.map((f) => [relative(root, f).split(sep).join('/'), f]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const h = createHash('sha256')
  for (const [name, file] of named) {
    h.update(name)
    h.update('\0')
    h.update(readFileSync(file, 'utf8').replace(/\r\n/g, '\n'))
    h.update('\0')
  }
  return h.digest('hex')
}
