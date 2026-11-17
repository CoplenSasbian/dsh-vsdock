/**
 * Reviewing a change in the editor.
 *
 * The agent edits files outside VS Code, so what is left to build is the review
 * step: VS Code's own diff editor, with the text from before the change on the
 * left and the file on disk on the right. The "before" side is a read-only
 * virtual document - nothing is written, and no scratch file appears in the
 * user's workspace. When no `original` is supplied the file is compared with its
 * git HEAD revision through the built-in git extension, which covers the common
 * "show me what just changed" case.
 */

import { basename } from 'node:path'

import * as vscode from 'vscode'

import { isInsideDirectory } from './paths'

export interface ReviewDiffInput {
  /** Absolute path of the file on disk — the "after" side. */
  path: string
  /** Text the file had before the change; omitted means "compare with git HEAD". */
  original?: string
  /** Diff tab title; defaults to the file name. */
  title?: string
  /**
   * Whether the diff takes keyboard focus.
   *
   * An agent that asks for a diff wants the user to look at it; a change caught
   * by the watcher must not pull focus out of whatever the user is typing in.
   */
  focus?: boolean
}

export interface ReviewDiffResult {
  /** Whether a diff editor was opened. */
  opened: boolean
  path: string
  title: string
  /** Which side the left pane shows. */
  before?: 'original' | 'git-head'
  /** Why nothing was opened, in words. */
  reason?: string
}

/** Scheme of the read-only "before" documents. */
const SCHEME = 'dsh-diff'
/** A whole-file diff bigger than this is refused instead of freezing the editor. */
const MAX_ORIGINAL_BYTES = 2 * 1024 * 1024
/** How many synthetic left panes stay resolvable (reopened tabs read them again). */
const KEEP_DOCUMENTS = 32

let provider: vscode.Disposable | undefined
let sequence = 0
const originalTexts = new Map<string, string>()

/** The git extension's API, only the part this module uses. */
interface GitRepositoryLike {
  rootUri: vscode.Uri
  diffWithHEAD?: (path: string) => Promise<void>
}

interface GitApiLike {
  getAPI?: (version: number) => { repositories?: GitRepositoryLike[] } | undefined
}

/** The id embedded in a `dsh-diff:` URI path (`/<id>/<name>`). */
function documentId(uri: vscode.Uri): string {
  const segments = uri.path.split('/')
  return segments.length > 1 ? segments[1] : ''
}

/** Register the content provider once, on the first diff. */
function ensureProvider(): void {
  if (provider) return
  provider = vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
    provideTextDocumentContent: (uri) => originalTexts.get(documentId(uri)) ?? ''
  })
}

/**
 * The left pane of one review: the supplied text, behind a virtual URI.
 * @param text the file's earlier content.
 * @param path the file it belongs to (only the name reaches the tab).
 */
function beforeDocument(text: string, path: string): vscode.Uri {
  ensureProvider()
  sequence += 1
  const id = sequence.toString(36)
  originalTexts.set(id, text)
  while (originalTexts.size > KEEP_DOCUMENTS) {
    const oldest = originalTexts.keys().next().value
    if (oldest === undefined) break
    originalTexts.delete(oldest)
  }
  return vscode.Uri.from({ scheme: SCHEME, path: '/' + id + '/' + basename(path) })
}

/**
 * Compare the file with its last commit, through the built-in git extension.
 *
 * The git extension opens the diff itself and titles it, so there is nothing else
 * to pass; a file outside every repository simply falls through.
 * @param path absolute file path.
 * @returns false when the file is not in a repository this editor knows.
 */
async function gitHeadDiff(path: string): Promise<boolean> {
  const extension = vscode.extensions.getExtension('vscode.git')
  if (!extension) return false
  const exported = (await extension.activate()) as GitApiLike | undefined
  const api = exported?.getAPI?.(1)
  const repositories = api?.repositories ?? []
  const repository = repositories.find((candidate) => isInsideDirectory(path, candidate.rootUri.fsPath))
  if (!repository || typeof repository.diffWithHEAD !== 'function') return false
  await repository.diffWithHEAD(path)
  return true
}

/**
 * Open one review diff.
 * @param input the file, and optionally the text it had before the change.
 * @returns what was opened, or why nothing was.
 */
export async function openReviewDiff(input: ReviewDiffInput): Promise<ReviewDiffResult> {
  const path = input.path
  const title = input.title && input.title.trim() ? input.title.trim() : basename(path)

  if (input.original === undefined) {
    if (await gitHeadDiff(path)) return { opened: true, path, title, before: 'git-head' }
    return {
      opened: false,
      path,
      title,
      reason: 'the file is not in a git repository, so pass original with the text from before the change'
    }
  }

  const bytes = Buffer.byteLength(input.original, 'utf8')
  if (bytes > MAX_ORIGINAL_BYTES) {
    return { opened: false, path, title, reason: `original is ${bytes} bytes, over the 2 MB limit` }
  }

  await vscode.commands.executeCommand(
    'vscode.diff',
    beforeDocument(input.original, path),
    vscode.Uri.file(path),
    title,
    { preview: true, preserveFocus: input.focus === false }
  )
  return { opened: true, path, title, before: 'original' }
}
