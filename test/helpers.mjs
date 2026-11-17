import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import quickdock from '../out/quickdock.js'
import html from '../out/html.js'

export const qd = quickdock
export const page = html

/** Minimal `vscode.l10n.t` stand-in: substitutes {0}, {1}, … */
export function t(message, ...args) {
  return String(message).replace(/\{(\d+)\}/g, (whole, index) => {
    const value = args[Number(index)]
    return value === undefined ? whole : String(value)
  })
}

/** An in-memory `FsLike` for detection tests. */
export function fakeFs(files) {
  return {
    existsSync: (path) => Object.prototype.hasOwnProperty.call(files, path),
    readFileSync: (path) => {
      if (!(path in files)) throw new Error('ENOENT: ' + path)
      return files[path]
    }
  }
}

/** Read the sibling `dsh-quickdock` checkout when it is present. */
export function readSiblingPluginFile(relative) {
  try {
    return readFileSync(join(process.cwd(), '..', 'dsh-quickdock', relative), 'utf8')
  } catch {
    return undefined
  }
}
