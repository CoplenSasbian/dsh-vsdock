/**
 * Whether an on-disk change is worth a review diff.
 *
 * A review is opened for exactly one thing: a file DSH reported writing (QuickDock
 * forwards the filesystem service's `fs/observed` event, see `file-events`). That
 * is why a build tool's output never reaches this module - a Gradle or Maven build
 * writes to the disk directly, not through DSH.
 *
 * What is left here is the "can this be a diff at all" decision, without touching
 * `vscode`: the path has to sit inside a folder the editor registered for DSH, it
 * must not be a generated, vendored or binary path, it must not be the buffer the
 * user is typing in, and the file has to be small enough to render.
 */

import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Directories whose contents are generated, vendored or not text. */
const IGNORED_SEGMENTS = new Set([
  // Version control and editor state.
  '.git',
  '.svn',
  '.hg',
  '.idea',
  '.fleet',
  '.settings',
  // JavaScript / TypeScript builds.
  'node_modules',
  'out',
  'dist',
  'build',
  'coverage',
  'tmp',
  'temp',
  '.cache',
  '.next',
  '.nuxt',
  '.output',
  '.turbo',
  '.parcel-cache',
  '.svelte-kit',
  '.angular',
  '.pnpm-store',
  '.yarn',
  '.eslintcache',
  // JVM builds: Gradle, Maven, Kotlin, Android, and the native pieces they run.
  '.gradle',
  '.kotlin',
  '.m2',
  'captures',
  '.externalNativeBuild',
  '.cxx',
  // Bazel.
  '.bazel',
  'bazel-out',
  'bazel-bin',
  'bazel-testlogs',
  // Apple / Dart / PHP / Go / Rust / Python / Terraform outputs and caches.
  'Pods',
  'DerivedData',
  '.dart_tool',
  '.pub-cache',
  'vendor',
  'target',
  'obj',
  'bin',
  '__pycache__',
  '.venv',
  'venv',
  '.terraform',
  // Test harness leftovers.
  '.vscode-test',
  '.electron-test'
])

/** File names that are always generated, whatever they sit next to. */
const IGNORED_NAMES = new Set(['local.properties', 'thumbs.db', 'desktop.ini'])

/** Extensions whose contents a diff editor cannot show usefully. */
const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'ico', 'bmp', 'webp', 'avif', 'tiff',
  'pdf', 'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'tar',
  'exe', 'dll', 'node', 'so', 'dylib', 'class', 'jar', 'wasm', 'asar', 'vsix', 'map',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'mp3', 'mp4', 'mov', 'wav', 'webm', 'avi', 'mkv',
  'ico', 'icns', 'db', 'sqlite', 'sqlite3', 'lock'
])

/**
 * Turn one user glob into a matcher.
 *
 * `**` crosses directories (`**\/` also matches no directory at all), `*` and `?`
 * stay inside one segment. A pattern without a separator matches at any depth, so
 * `*.log` covers `logs/build.log` too.
 * @param pattern the glob as the user typed it.
 * @returns the matcher, or undefined for a blank pattern.
 */
function globToRegExp(pattern: string): RegExp | undefined {
  const text = String(pattern)
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
  if (text.length === 0) return undefined
  let body = ''
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === '*') {
      if (text[index + 1] === '*') {
        index += 1
        if (text[index + 1] === '/') {
          index += 1
          body += '(?:.*/)?'
        } else {
          body += '.*'
        }
      } else {
        body += '[^/]*'
      }
    } else if (char === '?') {
      body += '[^/]'
    } else {
      body += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }
  }
  if (!text.includes('/')) body = '(?:.*/)?' + body
  return new RegExp('^' + body + '$', process.platform === 'win32' ? 'i' : '')
}

/**
 * Whether the user asked for a path to stay out of reviews.
 *
 * A bare directory pattern such as `generated` also covers everything below it,
 * which is what someone typing it in a settings field means.
 * @param relativePath path relative to its workspace folder (either separator).
 * @param patterns `dshVsdock.reviewIgnore` entries.
 */
export function matchesIgnorePattern(relativePath: string, patterns: string[]): boolean {
  if (patterns.length === 0) return false
  const path = String(relativePath).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
  if (path.length === 0) return true
  for (const pattern of patterns) {
    const trimmed = String(pattern).trim()
    if (trimmed.length === 0) continue
    const direct = globToRegExp(trimmed)
    if (direct && direct.test(path)) return true
    // `build` means "the build directory", not just a file called build.
    if (!trimmed.endsWith('/**') && !trimmed.endsWith('*')) {
      const below = globToRegExp(trimmed.replace(/\/+$/, '') + '/**')
      if (below && below.test(path)) return true
    }
  }
  return false
}

/**
 * Whether a workspace-relative path is generated, vendored or binary.
 * @param relativePath path relative to its workspace folder (either separator).
 * @param patterns extra globs from `dshVsdock.reviewIgnore`.
 */
export function isIgnoredReviewPath(relativePath: string, patterns: string[] = []): boolean {
  const segments = relativePath.split(/[\\/]+/).filter((segment) => segment.length > 0)
  if (segments.length === 0) return true
  if (segments.some((segment) => IGNORED_SEGMENTS.has(segment.toLowerCase()))) return true
  const name = segments[segments.length - 1]
  if (IGNORED_NAMES.has(name.toLowerCase())) return true
  if (name.endsWith('.min.js') || name.endsWith('.min.css')) return true
  if (patterns.length > 0 && matchesIgnorePattern(relativePath, patterns)) return true
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return false
  return BINARY_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())
}

/** What the watcher knows about one write when it decides. */
export interface ReviewDecisionInput {
  /** Absolute path that changed. */
  path: string
  /** Absolute workspace folders this editor has open. */
  folders: string[]
  /** Absolute folders currently registered with DSH (empty means "not paired"). */
  paired: string[]
  /** Whether an editor buffer for this path has unsaved changes. */
  dirty: boolean
  /** Whether an earlier version is known, so there is something to compare. */
  hasBefore: boolean
  /** Size of the new content in bytes. */
  bytes: number
  /** Files above this size are skipped instead of freezing the diff editor. */
  maxBytes: number
}

export type ReviewDecision = { review: true } | { review: false; reason: string }

/**
 * Decide whether one reported write opens a review diff.
 * @param input what the watcher saw.
 * @returns the verdict, with a short reason when it declines.
 */
export function decideReview(input: ReviewDecisionInput): ReviewDecision {
  if (input.dirty) return { review: false, reason: 'the buffer has unsaved changes' }
  if (input.paired.length === 0) return { review: false, reason: 'no folder is registered with DSH' }
  if (!insideAny(input.path, input.paired)) return { review: false, reason: 'outside the folders DSH may change' }
  if (input.bytes > input.maxBytes) return { review: false, reason: 'file is too large' }
  if (!input.hasBefore) return { review: false, reason: 'no earlier version to compare with' }
  return { review: true }
}

/**
 * Turn a path DSH reported into one this editor can open.
 *
 * The filesystem service reports whatever its backend finds clearest: the local
 * backend an absolute path, a remote one a workspace-relative path or a URI. A
 * dock only reviews what it can reach, so the path is resolved against the folder
 * it edits and anything else is dropped.
 * @param reported the path as the dock reported it.
 * @param folders absolute folders this editor has open (the dock's own first).
 * @returns an absolute path, or undefined when it cannot be resolved locally.
 */
export function resolveReportedPath(reported: string, folders: string[]): string | undefined {
  const text = String(reported ?? '').trim()
  if (text.length === 0) return undefined
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) {
    if (!/^file:/i.test(text)) return undefined
    try {
      return fileURLToPath(text)
    } catch (_) {
      return undefined
    }
  }
  if (isAbsolute(text)) return text
  const folder = folders.find((candidate) => candidate && candidate.trim().length > 0)
  return folder ? join(folder, text) : undefined
}

/** Whether `path` is one of `directories` or sits below one. */
export function insideAny(path: string, directories: string[]): boolean {
  const child = normalise(path)
  return directories.some((directory) => {
    const parent = normalise(directory)
    if (parent.length === 0) return false
    return child === parent || child.startsWith(parent + '/')
  })
}

/** Comparison form: forward slashes, no trailing separator, lower case on Windows. */
function normalise(value: string): string {
  let text = String(value).replace(/\\/g, '/').replace(/\/+$/, '')
  if (text.length === 0) text = '/'
  return process.platform === 'win32' ? text.toLowerCase() : text
}
