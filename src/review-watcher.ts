/**
 * Automatic review: open a diff for a file DSH says it changed.
 *
 * A review is only ever opened for a write DSH reported. QuickDock forwards the
 * filesystem service's `fs/observed` events (`GET /quickdock/api/file-events`),
 * which fire when one of DSH's own file tools finishes a mutation - write, edit,
 * patch, move, delete. Nothing else reaches this module: a Gradle or Maven build,
 * a formatter, a dev server, `git checkout` - anything a shell command does to the
 * disk - never passes through DSH and so never opens a tab.
 *
 * That is the whole filter. What remains here is bookkeeping: keep the text each
 * reviewable file had before the change (so the diff can show it), resolve the
 * path DSH reported against the folder this editor owns, skip what a diff editor
 * cannot render (binaries, huge files, a buffer the user is typing in), and open
 * the diff as a preview tab that never takes focus.
 *
 * When the dock build is too old to report writes, the log says so once and
 * nothing pops: this extension has no second, guessier way to attribute a change
 * to the agent.
 */

import { relative } from 'node:path'

import * as vscode from 'vscode'

import { openReviewDiff } from './diff'
import { listFileEvents } from './mcp'
import type { FileEvent } from './mcp'
import { isInsideDirectory } from './paths'
import { decideReview, isIgnoredReviewPath, resolveReportedPath } from './review'

/** A reported write is coalesced for this long: one tool call may write twice. */
const DEBOUNCE_MS = 200
/** Files above this size are never cached or diffed. */
const MAX_FILE_BYTES = 512 * 1024
/** How much of the workspace is cached at startup (files, bytes). */
const MAX_CACHED_FILES = 4_000
const MAX_CACHED_BYTES = 48 * 1024 * 1024
/** How long one poll may wait for the next reported write. */
const POLL_WAIT_MS = 15_000
/** Backoff after a refused connection, so a stopped DSH costs nothing. */
const RETRY_MIN_MS = 2_000
const RETRY_MAX_MS = 30_000
/** A dock that does not serve the feed is re-checked this often (an upgrade). */
const UNSUPPORTED_RETRY_MS = 60_000

/** What the watcher needs from the extension. */
export interface EditReviewHost {
  /** Whether automatic reviews are switched on. */
  enabled(): boolean
  /** Absolute folders registered with DSH right now. */
  pairedFolders(): string[]
  /** Absolute workspace folders. */
  workspaceFolders(): string[]
  /** Extra ignore globs the user configured (`dshVsdock.reviewIgnore`). */
  ignorePatterns(): string[]
  /** QuickDock's loopback port, when one is in effect. */
  dockPort(): number | undefined
  /** Diagnostic channel. */
  log(line: string): void
}

/**
 * Follow DSH's reported file writes and put each one on screen for review.
 */
export class EditReview implements vscode.Disposable {
  private walk: vscode.CancellationTokenSource | undefined
  private readonly texts = new Map<string, string>()
  private readonly pending = new Map<string, NodeJS.Timeout>()
  private readonly listeners: vscode.Disposable[] = []
  /** Last sequence the dock reported; negative until the first answer. */
  private cursor = -1
  /** Last "cannot follow" line, so a stopped DSH logs once instead of per poll. */
  private noted = ''
  private disposed = false

  /** @param host the extension's own view of DSH and the workspace. */
  constructor(private readonly host: EditReviewHost) {}

  /** Begin following: cache the workspace, then read the feed forever. */
  start(): void {
    if (this.listeners.length > 0) return
    // A save the editor makes is the baseline the next reported write is
    // compared with, so a diff never shows the user's own typed text as DSH's.
    this.listeners.push(
      vscode.workspace.onDidSaveTextDocument((document) => {
        this.texts.set(document.uri.fsPath, document.getText())
      })
    )
    void this.cacheWorkspace()
    void this.follow()
  }

  dispose(): void {
    this.disposed = true
    for (const timer of this.pending.values()) clearTimeout(timer)
    this.pending.clear()
    this.walk?.cancel()
    this.walk?.dispose()
    for (const listener of this.listeners) listener.dispose()
    this.listeners.length = 0
  }

  /* ------------------------------- baseline ------------------------------- */

  /** Read the workspace once, so the first reported change has a "before". */
  private async cacheWorkspace(): Promise<void> {
    this.walk?.cancel()
    this.walk?.dispose()
    const token = new vscode.CancellationTokenSource()
    this.walk = token
    const patterns = this.host.ignorePatterns()
    let files = 0
    let bytes = 0
    try {
      for (const folder of vscode.workspace.workspaceFolders ?? []) {
        if (token.token.isCancellationRequested) return
        const found = await vscode.workspace.findFiles(
          new vscode.RelativePattern(folder, '**/*'),
          '**/{node_modules,.git,out,dist,build,coverage,tmp,.next,.cache,target,obj,bin,.gradle}/**',
          MAX_CACHED_FILES
        )
        for (const uri of found) {
          if (token.token.isCancellationRequested || files >= MAX_CACHED_FILES || bytes >= MAX_CACHED_BYTES) break
          if (isIgnoredReviewPath(vscode.workspace.asRelativePath(uri, false), patterns)) continue
          const text = await this.readText(uri)
          if (text === undefined) continue
          this.texts.set(uri.fsPath, text)
          files += 1
          bytes += text.length
        }
      }
      this.host.log(`review: cached ${files} file(s), ${Math.round(bytes / 1024)} KB, for automatic diffs`)
    } catch (error) {
      this.host.log(`review: cannot cache the workspace: ${String((error as Error)?.message ?? error)}`)
    }
  }

  /* --------------------------------- feed --------------------------------- */

  /** Read the dock's feed, poll after poll, until the extension is disposed. */
  private async follow(): Promise<void> {
    let backoff = RETRY_MIN_MS
    let unsupported = false
    while (!this.disposed) {
      if (!this.host.enabled()) {
        // The setting can come back on without a reload: idle, then retry.
        await this.sleep(RETRY_MIN_MS)
        continue
      }
      const port = this.host.dockPort()
      if (port === undefined) {
        this.noteOnce('review: no QuickDock port is in effect, so DSH writes are not followed')
        await this.sleep(backoff)
        backoff = Math.min(RETRY_MAX_MS, backoff * 2)
        continue
      }
      // The first poll starts at the end of the feed: history is not news, and a
      // replay would open a tab per file DSH ever wrote.
      const answer = await listFileEvents(port, this.cursor < 0 ? Number.MAX_SAFE_INTEGER : this.cursor, POLL_WAIT_MS)
      if (this.disposed) return
      if (!answer.ok) {
        // A 404 is a dock without the feed, not a transient failure.
        unsupported = answer.status === 404
        this.noteOnce(
          unsupported
            ? 'review: this QuickDock build does not report DSH writes (update dsh-quickdock), so no diff opens by itself'
            : `review: cannot read DSH writes from QuickDock: ${answer.error ?? 'unknown'}`
        )
        await this.sleep(unsupported ? UNSUPPORTED_RETRY_MS : backoff)
        if (!unsupported) backoff = Math.min(RETRY_MAX_MS, backoff * 2)
        continue
      }
      if (unsupported) this.host.log('review: QuickDock now reports DSH writes')
      unsupported = false
      backoff = RETRY_MIN_MS
      this.noted = ''
      if (this.cursor < 0) {
        this.cursor = typeof answer.body?.seq === 'number' ? answer.body.seq : 0
        this.host.log(`review: following DSH's reported writes from sequence ${this.cursor}`)
        continue
      }
      this.consume(answer.body)
    }
  }

  /** One answer from the feed: advance the cursor, then look at each write. */
  private consume(answer: { seq?: number; events?: FileEvent[]; dropped?: number } | undefined): void {
    if (!answer) return
    const seq = typeof answer.seq === 'number' ? answer.seq : this.cursor
    if (seq < this.cursor) {
      // The dock restarted and its sequence went back to zero: start again from
      // its current position instead of silently ignoring every future write.
      this.host.log(`review: the dock's write feed restarted (sequence ${seq})`)
    } else if ((answer.dropped ?? 0) > 0) {
      this.host.log(`review: ${answer.dropped} write(s) went by while DSH writes were not followed`)
    }
    for (const event of answer.events ?? []) {
      this.accept(event)
    }
    this.cursor = seq
  }

  /** One reported path: forget it, or schedule the review of its new content. */
  private accept(event: FileEvent): void {
    if (this.disposed || !this.host.enabled()) return
    const folders = this.host.pairedFolders()
    const path = resolveReportedPath(event.path, folders.length > 0 ? folders : this.host.workspaceFolders())
    if (!path) return
    if (event.kind === 'delete') {
      this.texts.delete(path)
      return
    }
    if (this.pending.has(path)) clearTimeout(this.pending.get(path))
    const timer = setTimeout(() => {
      this.pending.delete(path)
      void this.review(path)
    }, DEBOUNCE_MS)
    this.pending.set(path, timer)
  }

  /* -------------------------------- review -------------------------------- */

  /** Compare the new content with the cached text and put the change on screen. */
  private async review(path: string): Promise<boolean> {
    if (this.disposed || !this.host.enabled()) return false
    const relativePath = this.relative(path)
    if (relativePath === undefined) return false
    if (isIgnoredReviewPath(relativePath, this.host.ignorePatterns())) return false
    const dirty = vscode.workspace.textDocuments.some(
      (document) => document.isDirty && document.uri.scheme === 'file' && document.uri.fsPath === path
    )
    const text = await this.readText(vscode.Uri.file(path))
    if (text === undefined) return false
    const before = this.texts.get(path)
    const decision = decideReview({
      path,
      folders: this.host.workspaceFolders(),
      paired: this.host.pairedFolders(),
      dirty,
      hasBefore: true,
      bytes: Buffer.byteLength(text, 'utf8'),
      maxBytes: MAX_FILE_BYTES
    })
    if (!decision.review) return false
    if (before === text) {
      this.texts.set(path, text)
      return false
    }
    this.texts.set(path, text)
    const name = path.replace(/\\/g, '/').split('/').pop() ?? path
    try {
      // No cached "before" (a file that appeared before the cache, or one DSH
      // just created outside the open workspace) falls back to the git HEAD
      // comparison, which is a review either way.
      const result = await openReviewDiff({ path, original: before, title: `${name} (DSH)`, focus: false })
      this.host.log(
        result.opened
          ? `review: ${path} (${before === undefined ? 'git HEAD' : `${text.length - before.length >= 0 ? '+' : ''}${text.length - before.length} chars`})`
          : `review: ${path} not opened: ${result.reason ?? 'unknown'}`
      )
      return result.opened
    } catch (error) {
      this.host.log(`review: cannot open ${path}: ${String((error as Error)?.message ?? error)}`)
      return false
    }
  }

  /** The reported path relative to the folder this editor owns. */
  private relative(path: string): string | undefined {
    const folders = this.host.workspaceFolders()
    for (const folder of folders) {
      if (!isInsideDirectory(path, folder)) continue
      const inside = relative(folder, path)
      return inside === '' ? undefined : inside
    }
    // A paired folder that is not open in this editor is still reviewed, titled
    // by its own path: the workspace-relative filter then sees the whole path.
    return path
  }

  /* -------------------------------- helpers ------------------------------- */

  /** Read a text file, refusing what the diff editor cannot show anyway. */
  private async readText(uri: vscode.Uri): Promise<string | undefined> {
    try {
      const stat = await vscode.workspace.fs.stat(uri)
      if (stat.size > MAX_FILE_BYTES) return undefined
      const bytes = await vscode.workspace.fs.readFile(uri)
      const text = Buffer.from(bytes).toString('utf8')
      // A NUL byte in the first block is the usual "this is binary" signal.
      return text.includes('\u0000') ? undefined : text
    } catch (_) {
      return undefined
    }
  }

  /** Log a line once, and again only after a successful poll. */
  private noteOnce(line: string): void {
    if (this.noted === line) return
    this.noted = line
    this.host.log(line)
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms)
      if (typeof timer.unref === 'function') timer.unref()
    })
  }
}
