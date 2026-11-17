/**
 * Repository checks for translations and manifest placeholders.
 *
 * Every string passed to `vscode.l10n.t` (or the local `translate`/`t` wrapper)
 * must exist in `l10n/bundle.l10n.zh-cn.json`, and every `%key%` in
 * `package.json` must exist in both `package.nls.json` files.
 *
 *   node scripts/check-strings.mjs
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const read = (relative) => readFileSync(join(root, relative), 'utf8')

const failures = []

/* ------------------------------ runtime keys ------------------------------ */

const sources = readdirSync(join(root, 'src'))
  .filter((file) => file.endsWith('.ts'))
  .map((file) => ({ file: 'src/' + file, text: read('src/' + file) }))

const pattern = /\b(?:t|translate)\(\s*'((?:[^'\\]|\\.)*)'/g
const used = new Set()
for (const { text } of sources) {
  let match
  while ((match = pattern.exec(text)) !== null) {
    used.add(match[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\'))
  }
}

const bundle = JSON.parse(read('l10n/bundle.l10n.zh-cn.json'))
for (const key of used) {
  if (!(key in bundle)) failures.push(`missing zh translation: ${JSON.stringify(key)}`)
  else if (typeof bundle[key] !== 'string' || bundle[key].trim() === '') {
    failures.push(`empty zh translation: ${JSON.stringify(key)}`)
  }
}
for (const key of Object.keys(bundle)) {
  if (!used.has(key)) failures.push(`unused zh translation: ${JSON.stringify(key)}`)
}

// Placeholders must survive translation.
for (const [key, value] of Object.entries(bundle)) {
  const indexes = (text) => [...text.matchAll(/\{(\d+)\}/g)].map((match) => match[1]).sort().join(',')
  if (indexes(key) !== indexes(value)) {
    failures.push(`placeholder mismatch: ${JSON.stringify(key)} -> ${JSON.stringify(value)}`)
  }
}

/* ---------------------------- manifest strings ---------------------------- */

const usedNls = new Set([...read('package.json').matchAll(/"%([^"%]+)%"/g)].map((match) => match[1]))
const english = JSON.parse(read('package.nls.json'))
const chinese = JSON.parse(read('package.nls.zh-cn.json'))
for (const key of usedNls) {
  if (!(key in english)) failures.push(`package.nls.json is missing ${key}`)
  if (!(key in chinese)) failures.push(`package.nls.zh-cn.json is missing ${key}`)
}
for (const key of Object.keys(english)) {
  if (!usedNls.has(key)) failures.push(`unused manifest string: ${key}`)
}

/* --------------------------------- report -------------------------------- */

if (failures.length > 0) {
  console.error('check failed:')
  for (const failure of failures) console.error('  - ' + failure)
  process.exit(1)
}
console.log(`ok: ${used.size} runtime strings, ${usedNls.size} manifest strings`)
