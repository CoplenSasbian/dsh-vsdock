/**
 * The editor tools DSH can call through MCP.
 *
 * Most are read-only: the agent looks at the workspace, the active selection,
 * diagnostics, symbols and file contents, searches the tree, asks the language
 * servers for definitions, references, hovers and code actions, and puts a change
 * on screen for review. A second group does write - editing a buffer, saving,
 * running a task, a terminal command or a debug session - and only exists when
 * `dshVsdock.mcpWriteTools` is on, because those reach past the DSH sandbox.
 *
 * Results are bounded and say when they were truncated, so the model can ask for
 * a narrower read instead of receiving a wall of text.
 */

import * as vscode from 'vscode'

import { openReviewDiff } from './diff'
import type { McpTool } from './mcp'

const MAX_SELECTION = 4000
const MAX_LINES = 2000
const MAX_BYTES = 256 * 1024
const MAX_SYMBOLS = 200
const MAX_DIAGNOSTICS = 200
const MAX_MESSAGE = 600
/** Matches one search may return, and files it may read to find them. */
const MAX_SEARCH_RESULTS = 200
const MAX_SEARCH_FILES = 2000
/** One search result keeps this much of its line, so a long line cannot flood. */
const MAX_PREVIEW = 200
/** Locations one provider call may return. */
const MAX_LOCATIONS = 200
/** Characters of hover text a tool returns. */
const MAX_HOVER_CHARS = 4000
/** Code actions one call may list. */
const MAX_ACTIONS = 50
/** Files one listing may return. */
const MAX_FILES = 500
/** Size of one file a text search will read. */
const MAX_SEARCH_BYTES = 512 * 1024
/** Size of the replacement text one edit may carry. */
const MAX_EDIT_CHARS = 512 * 1024

const noArguments = { type: 'object', properties: {}, additionalProperties: false }

function severityName(severity: vscode.DiagnosticSeverity): string {
  return String(vscode.DiagnosticSeverity[severity] ?? 'unknown').toLowerCase()
}

function integer(value: unknown, fallback: number): number {
  const number = Math.floor(Number(value))
  return Number.isFinite(number) ? number : fallback
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** A 1-based `{ line, column }` from tool arguments. */
function positionFrom(args: Record<string, unknown>): vscode.Position {
  const line = clamp(integer(args.line, 1), 1, 1_000_000)
  const column = clamp(integer(args.column, 1), 1, 1_000_000)
  return new vscode.Position(line - 1, column - 1)
}

/** The document a provider call works on: `path`, or the active editor. */
async function targetDocument(args: Record<string, unknown>): Promise<vscode.TextDocument | undefined> {
  const path = typeof args.path === 'string' && args.path.trim().length > 0 ? args.path.trim() : undefined
  try {
    if (path) return await vscode.workspace.openTextDocument(vscode.Uri.file(path))
    return vscode.window.activeTextEditor?.document
  } catch (_) {
    return undefined
  }
}

/** One location in a provider answer, flattened for the model. */
function locationRecord(uri: vscode.Uri, range?: vscode.Range, extra?: Record<string, unknown>): Record<string, unknown> {
  return {
    path: uri.scheme === 'file' ? uri.fsPath : uri.toString(),
    line: range ? range.start.line + 1 : 1,
    column: range ? range.start.character + 1 : 1,
    ...extra
  }
}

/** Normalise what the definition/reference providers return. */
function normalizeLocations(raw: unknown): Array<{ uri: vscode.Uri; range?: vscode.Range }> {
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw]
  const out: Array<{ uri: vscode.Uri; range?: vscode.Range }> = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const uri = (record.targetUri ?? record.uri) as vscode.Uri | undefined
    const range = (record.targetRange ?? record.range) as vscode.Range | undefined
    if (!uri) continue
    out.push({ uri, range })
    if (out.length >= MAX_LOCATIONS) break
  }
  return out
}

/** Flatten the markdown the hover provider returns into one bounded string. */
function hoverText(raw: unknown): string {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : []
  const parts: string[] = []
  for (const item of list) {
    const contents = (item as { contents?: unknown } | undefined)?.contents
    const entries = Array.isArray(contents) ? contents : contents ? [contents] : []
    for (const entry of entries) {
      if (typeof entry === 'string') parts.push(entry)
      else if (entry && typeof entry === 'object') {
        const value = (entry as { value?: unknown }).value
        if (typeof value === 'string') parts.push(value)
      }
    }
    if (parts.join('\n').length > MAX_HOVER_CHARS) break
  }
  const text = parts.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  return text.length > MAX_HOVER_CHARS ? text.slice(0, MAX_HOVER_CHARS) + '…' : text
}

/** One line of a file, shortened so a minified file cannot flood the result. */
function previewOf(line: string): string {
  const text = line.trim()
  return text.length > MAX_PREVIEW ? text.slice(0, MAX_PREVIEW) + '…' : text
}

/** Flatten whatever the language provider returned into bounded nodes. */
function flattenSymbols(raw: unknown[], depthLimit: number): unknown[] {
  const out: unknown[] = []
  const visit = (node: Record<string, unknown>, depth: number): void => {
    if (out.length >= MAX_SYMBOLS || depth > depthLimit) return
    const record: Record<string, unknown> = {
      name: String(node.name ?? ''),
      kind: String(vscode.SymbolKind[Number(node.kind)] ?? 'unknown').toLowerCase()
    }
    const location = node.location as { range?: vscode.Range; uri?: vscode.Uri } | undefined
    const range = (node.range as vscode.Range | undefined) ?? location?.range
    if (range) record.line = range.start.line + 1
    if (location?.uri) record.path = location.uri.fsPath
    out.push(record)
    const children = node.children as unknown[] | undefined
    if (Array.isArray(children)) {
      for (const child of children) {
        if (child && typeof child === 'object') visit(child as Record<string, unknown>, depth + 1)
      }
    }
  }
  for (const node of raw) {
    if (node && typeof node === 'object') visit(node as Record<string, unknown>, 0)
  }
  return out
}

/**
 * The editor tool set.
 * @param log diagnostic channel for slow or failing provider calls.
 * @param options `write` adds the tools that change state (a buffer, a save, a
 *   task, a terminal, a debug session); they are off unless the user opts in.
 */
export function editorTools(
  log: (line: string) => void = () => {},
  options: { write?: boolean } = {}
): McpTool[] {
  return [
    {
      name: 'vscode_workspace_folders',
      description:
        'List the VS Code workspace roots and the active editor (path, language). Use it to learn which project the user is in.',
      inputSchema: noArguments,
      call: () => {
        const folders = (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
          name: folder.name,
          path: folder.uri.fsPath
        }))
        const editor = vscode.window.activeTextEditor
        return {
          folders,
          workspaceFile: vscode.workspace.workspaceFile?.fsPath ?? null,
          active: editor
            ? {
                path: editor.document.uri.fsPath,
                languageId: editor.document.languageId,
                dirty: editor.document.isDirty
              }
            : null
        }
      }
    },
    {
      name: 'vscode_selection',
      description:
        'The active editor: file, language, cursor position and the selected text (truncated at 4000 characters). Empty selection means the cursor position alone.',
      inputSchema: noArguments,
      call: () => {
        const editor = vscode.window.activeTextEditor
        if (!editor) return { active: null }
        const document = editor.document
        const selection = editor.selection
        const text = document.getText(selection)
        const truncated = text.length > MAX_SELECTION
        return {
          path: document.uri.fsPath,
          languageId: document.languageId,
          dirty: document.isDirty,
          line: selection.active.line + 1,
          column: selection.active.character + 1,
          selection: {
            start: { line: selection.start.line + 1, column: selection.start.character + 1 },
            end: { line: selection.end.line + 1, column: selection.end.character + 1 },
            empty: selection.isEmpty
          },
          text: truncated ? text.slice(0, MAX_SELECTION) + '\n…[truncated]' : text,
          truncated
        }
      }
    },
    {
      name: 'vscode_diagnostics',
      description:
        'Errors and warnings from the language servers. Defaults to the active file; pass path or scope "workspace" for more. Returns counts and at most 200 items.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute file path. Defaults to the active editor.' },
          scope: {
            type: 'string',
            enum: ['file', 'workspace'],
            description: 'Read one file or every open document. Defaults to file.'
          },
          limit: { type: 'integer', minimum: 1, maximum: MAX_DIAGNOSTICS, description: 'Maximum items, default 50.' }
        },
        additionalProperties: false
      },
      call: (args) => {
        const scope = args.scope === 'workspace' ? 'workspace' : 'file'
        const limit = Math.min(MAX_DIAGNOSTICS, Math.max(1, integer(args.limit, 50)))
        const path = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : undefined
        let entries: Array<[vscode.Uri, vscode.Diagnostic[]]>
        if (scope === 'workspace') {
          entries = vscode.languages.getDiagnostics()
        } else {
          const uri = path
            ? vscode.Uri.file(path)
            : vscode.window.activeTextEditor?.document.uri
          if (!uri) return { scope, file: null, counts: { error: 0, warning: 0, information: 0, hint: 0 }, items: [] }
          entries = [[uri, vscode.languages.getDiagnostics(uri)]]
        }
        const counts = { error: 0, warning: 0, information: 0, hint: 0 }
        const items: unknown[] = []
        for (const [uri, list] of entries) {
          for (const diagnostic of list) {
            const severity = severityName(diagnostic.severity)
            if (severity === 'error') counts.error += 1
            else if (severity === 'warning') counts.warning += 1
            else if (severity === 'information') counts.information += 1
            else if (severity === 'hint') counts.hint += 1
            if (items.length >= limit) continue
            items.push({
              path: uri.fsPath,
              line: diagnostic.range.start.line + 1,
              column: diagnostic.range.start.character + 1,
              severity,
              message: diagnostic.message.slice(0, MAX_MESSAGE),
              source: diagnostic.source ?? null,
              code: typeof diagnostic.code === 'object' ? diagnostic.code.value : (diagnostic.code ?? null)
            })
          }
        }
        return {
          scope,
          file: scope === 'file' && entries[0] ? entries[0][0].fsPath : null,
          counts,
          items,
          truncated: Object.values(counts).reduce((sum, value) => sum + value, 0) > items.length
        }
      }
    },
    {
      name: 'vscode_read_file',
      description:
        'Read an editor file, including unsaved changes. Optional 1-based line range. Truncated at 2000 lines or 256 KB.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute file path.' },
          startLine: { type: 'integer', minimum: 1, description: 'First line (1-based).' },
          endLine: { type: 'integer', minimum: 1, description: 'Last line, inclusive.' }
        },
        required: ['path'],
        additionalProperties: false
      },
      call: async (args) => {
        const path = typeof args.path === 'string' ? args.path.trim() : ''
        if (!path) throw new Error('path is required')
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path))
        const lineCount = document.lineCount
        const start = Math.min(lineCount, Math.max(1, integer(args.startLine, 1)))
        const requestedEnd = Math.min(lineCount, Math.max(start, integer(args.endLine, lineCount)))
        const lines: string[] = []
        let bytes = 0
        let end = start - 1
        for (let line = start; line <= requestedEnd; line += 1) {
          if (lines.length >= MAX_LINES) break
          const text = document.lineAt(line - 1).text
          const size = Buffer.byteLength(text, 'utf8') + 1
          if (bytes + size > MAX_BYTES) break
          bytes += size
          lines.push(text)
          end = line
        }
        return {
          path: document.uri.fsPath,
          languageId: document.languageId,
          dirty: document.isDirty,
          lineCount,
          startLine: start,
          endLine: end,
          text: lines.join('\n'),
          truncated: end < requestedEnd
        }
      }
    },
    {
      name: 'vscode_symbols',
      description:
        'The document outline from the language server: symbols with kind and line, at most 3 levels deep and 200 nodes.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute file path. Defaults to the active editor.' },
          depth: { type: 'integer', minimum: 0, maximum: 3, description: 'Child levels to include, default 2.' }
        },
        additionalProperties: false
      },
      call: async (args) => {
        const path = typeof args.path === 'string' && args.path.trim()
          ? args.path.trim()
          : vscode.window.activeTextEditor?.document.uri.fsPath
        if (!path) return { path: null, symbols: [] }
        const raw = await vscode.commands.executeCommand<unknown[]>(
          'vscode.executeDocumentSymbolProvider',
          vscode.Uri.file(path)
        )
        const symbols = flattenSymbols(Array.isArray(raw) ? raw : [], Math.min(3, Math.max(0, integer(args.depth, 2))))
        log(`mcp: symbols ${path} -> ${symbols.length}`)
        return { path, symbols, truncated: symbols.length >= MAX_SYMBOLS }
      }
    },
    {
      name: 'vscode_open_diff',
      description:
        'Open a change in a VS Code diff editor so the user can review it. Pass original with the text the file had before your change (you have it after reading the file); without it the file is compared with its git HEAD revision. Nothing is written: the left pane is a read-only virtual document.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path of the file on disk (the "after" side).' },
          original: {
            type: 'string',
            description: 'The text the file had before the change. Omit to compare with the git HEAD revision.'
          },
          title: { type: 'string', description: 'Diff tab title. Defaults to the file name.' }
        },
        required: ['path'],
        additionalProperties: false
      },
      call: async (args) => {
        const path = typeof args.path === 'string' ? args.path.trim() : ''
        if (!path) throw new Error('path is required')
        const result = await openReviewDiff({
          path,
          original: typeof args.original === 'string' ? args.original : undefined,
          title: typeof args.title === 'string' ? args.title : undefined
        })
        log(`mcp: diff ${path} -> ${result.opened ? result.before : 'not opened: ' + (result.reason ?? '')}`)
        return result
      }
    },
    {
      name: 'vscode_search',
      description:
        'Search the workspace text and return matching lines: path, line, column and a short preview. Pass include/exclude globs to narrow it. Cheaper than reading files one by one when looking for a symbol or a string.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Text or regular expression to look for.' },
          regex: { type: 'boolean', description: 'Treat query as a regular expression. Default false.' },
          caseSensitive: { type: 'boolean', description: 'Match case. Default false.' },
          include: { type: 'string', description: 'Glob to include, for example src/**/*.ts.' },
          exclude: { type: 'string', description: 'Glob to exclude, for example **/out/**.' },
          maxResults: { type: 'integer', minimum: 1, maximum: MAX_SEARCH_RESULTS, description: 'Default 100.' }
        },
        required: ['query'],
        additionalProperties: false
      },
      call: async (args) => {
        const query = typeof args.query === 'string' ? args.query : ''
        if (query.length === 0) throw new Error('query is required')
        const limit = clamp(integer(args.maxResults, 100), 1, MAX_SEARCH_RESULTS)
        const include = typeof args.include === 'string' && args.include.trim() ? args.include.trim() : '**/*'
        const exclude = typeof args.exclude === 'string' && args.exclude.trim() ? args.exclude.trim() : undefined
        let expression: RegExp
        try {
          expression = new RegExp(args.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), args.caseSensitive ? '' : 'i')
        } catch (error) {
          throw new Error(`invalid regular expression: ${String((error as Error)?.message ?? error)}`)
        }
        const files = await vscode.workspace.findFiles(include, exclude, MAX_SEARCH_FILES)
        const matches: Record<string, unknown>[] = []
        let scanned = 0
        for (const uri of files) {
          if (matches.length >= limit) break
          let text: string
          try {
            const stat = await vscode.workspace.fs.stat(uri)
            if (stat.size > MAX_SEARCH_BYTES) continue
            text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8')
          } catch (_) {
            continue
          }
          if (text.includes('\u0000')) continue
          scanned += 1
          const lines = text.split(/\r?\n/)
          for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index]
            const found = expression.exec(line)
            if (!found) continue
            matches.push({
              path: uri.fsPath,
              line: index + 1,
              column: found.index + 1,
              preview: previewOf(line)
            })
            if (matches.length >= limit) break
          }
        }
        log(`mcp: search "${query}" -> ${matches.length} in ${scanned} file(s)`)
        return {
          query,
          matches,
          scanned,
          truncated: matches.length >= limit || files.length >= MAX_SEARCH_FILES
        }
      }
    },
    {
      name: 'vscode_list_files',
      description:
        'List workspace files by glob (for example **/*.test.ts), newest order is not guaranteed. Use it to learn the tree before reading specific files.',
      inputSchema: {
        type: 'object',
        properties: {
          include: { type: 'string', description: 'Glob to include. Default **/*.' },
          exclude: { type: 'string', description: 'Glob to exclude.' },
          maxResults: { type: 'integer', minimum: 1, maximum: MAX_FILES, description: 'Default 200.' }
        },
        additionalProperties: false
      },
      call: async (args) => {
        const include = typeof args.include === 'string' && args.include.trim() ? args.include.trim() : '**/*'
        const exclude = typeof args.exclude === 'string' && args.exclude.trim() ? args.exclude.trim() : undefined
        const limit = clamp(integer(args.maxResults, 200), 1, MAX_FILES)
        const files = await vscode.workspace.findFiles(include, exclude, limit)
        const folders = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath)
        log(`mcp: list ${include} -> ${files.length}`)
        return {
          include,
          folders,
          files: files.map((uri) => uri.fsPath),
          truncated: files.length >= limit
        }
      }
    },
    {
      name: 'vscode_definitions',
      description:
        'Where is this symbol defined? Asks the language servers and returns the locations (path, line, column). Defaults to the active editor cursor; pass path and line/column to point elsewhere.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute file path. Defaults to the active editor.' },
          line: { type: 'integer', minimum: 1, description: '1-based line. Default 1.' },
          column: { type: 'integer', minimum: 1, description: '1-based column. Default 1.' }
        },
        additionalProperties: false
      },
      call: async (args) => {
        const document = await targetDocument(args)
        if (!document) return { path: null, locations: [] }
        const raw = await vscode.commands.executeCommand<unknown>(
          'vscode.executeDefinitionProvider',
          document.uri,
          positionFrom(args)
        )
        const locations = normalizeLocations(raw).map(({ uri, range }) => locationRecord(uri, range))
        log(`mcp: definitions ${document.uri.fsPath} -> ${locations.length}`)
        return { path: document.uri.fsPath, locations, truncated: locations.length >= MAX_LOCATIONS }
      }
    },
    {
      name: 'vscode_references',
      description:
        'Every place this symbol is used. Asks the language servers and returns the locations. Defaults to the active editor cursor.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute file path. Defaults to the active editor.' },
          line: { type: 'integer', minimum: 1, description: '1-based line. Default 1.' },
          column: { type: 'integer', minimum: 1, description: '1-based column. Default 1.' }
        },
        additionalProperties: false
      },
      call: async (args) => {
        const document = await targetDocument(args)
        if (!document) return { path: null, locations: [] }
        const raw = await vscode.commands.executeCommand<unknown>(
          'vscode.executeReferenceProvider',
          document.uri,
          positionFrom(args)
        )
        const locations = normalizeLocations(raw).map(({ uri, range }) => locationRecord(uri, range))
        log(`mcp: references ${document.uri.fsPath} -> ${locations.length}`)
        return { path: document.uri.fsPath, locations, truncated: locations.length >= MAX_LOCATIONS }
      }
    },
    {
      name: 'vscode_hover',
      description:
        'The type and documentation the language server shows at a position (markdown, bounded). Defaults to the active editor cursor.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute file path. Defaults to the active editor.' },
          line: { type: 'integer', minimum: 1, description: '1-based line. Default 1.' },
          column: { type: 'integer', minimum: 1, description: '1-based column. Default 1.' }
        },
        additionalProperties: false
      },
      call: async (args) => {
        const document = await targetDocument(args)
        if (!document) return { path: null, text: '' }
        const raw = await vscode.commands.executeCommand<unknown>(
          'vscode.executeHoverProvider',
          document.uri,
          positionFrom(args)
        )
        const text = hoverText(raw)
        log(`mcp: hover ${document.uri.fsPath} -> ${text.length} char(s)`)
        return { path: document.uri.fsPath, text, truncated: text.endsWith('…') }
      }
    },
    {
      name: 'vscode_code_actions',
      description:
        'Quick fixes, refactors and source actions available at a position or selection. Lists titles and kinds only; applying one is a separate, deliberate step.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute file path. Defaults to the active editor.' },
          startLine: { type: 'integer', minimum: 1, description: '1-based first line. Defaults to the cursor line.' },
          startColumn: { type: 'integer', minimum: 1, description: '1-based first column. Default 1.' },
          endLine: { type: 'integer', minimum: 1, description: '1-based last line. Defaults to startLine.' },
          endColumn: { type: 'integer', minimum: 1, description: '1-based last column. Defaults to startColumn.' }
        },
        additionalProperties: false
      },
      call: async (args) => {
        const document = await targetDocument(args)
        if (!document) return { path: null, actions: [] }
        const editor = vscode.window.activeTextEditor
        const startLine = clamp(integer(args.startLine, (editor?.selection.start.line ?? 0) + 1), 1, 1_000_000)
        const startColumn = clamp(integer(args.startColumn, (editor?.selection.start.character ?? 0) + 1), 1, 1_000_000)
        const endLine = clamp(integer(args.endLine, startLine), startLine, 1_000_000)
        const endColumn = clamp(integer(args.endColumn, endLine === startLine ? startColumn : 1), 1, 1_000_000)
        const range = new vscode.Range(startLine - 1, startColumn - 1, endLine - 1, endColumn - 1)
        const raw = await vscode.commands.executeCommand<unknown[]>(
          'vscode.executeCodeActionProvider',
          document.uri,
          range,
          undefined,
          MAX_ACTIONS
        )
        const actions = (Array.isArray(raw) ? raw : []).slice(0, MAX_ACTIONS).map((item) => {
          const record = item as { title?: unknown; kind?: { value?: unknown }; isPreferred?: unknown }
          return {
            title: String(record.title ?? ''),
            kind: String(record.kind?.value ?? ''),
            preferred: Boolean(record.isPreferred)
          }
        })
        log(`mcp: code actions ${document.uri.fsPath} -> ${actions.length}`)
        return { path: document.uri.fsPath, line: startLine, actions }
      }
    },
    {
      name: 'vscode_reveal',
      description:
        'Open a file in the editor and put the cursor on a line (no diff). Use it when the user should look at code rather than at a change.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute file path.' },
          line: { type: 'integer', minimum: 1, description: '1-based line to reveal. Default 1.' }
        },
        required: ['path'],
        additionalProperties: false
      },
      call: async (args) => {
        const path = typeof args.path === 'string' ? args.path.trim() : ''
        if (path.length === 0) throw new Error('path is required')
        const line = clamp(integer(args.line, 1), 1, 1_000_000)
        try {
          const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path))
          const position = new vscode.Position(Math.min(line - 1, Math.max(0, document.lineCount - 1)), 0)
          await vscode.window.showTextDocument(document, { selection: new vscode.Range(position, position), preview: true })
          log(`mcp: reveal ${path}:${line}`)
          return { opened: true, path, line }
        } catch (error) {
          return { opened: false, path, reason: String((error as Error)?.message ?? error) }
        }
      }
    },
    ...(options.write ? writeTools(log) : [])
  ]
}

/**
 * The tools that change something, only when `dshVsdock.mcpWriteTools` is on.
 *
 * They reach past the DSH sandbox into the editor: a buffer becomes unsaved, a
 * file is saved, a task/terminal/debug session starts. Each call is visible to the
 * user (an opened editor, a terminal, a task), and an edit is always undoable.
 * @param log diagnostic channel.
 */
function writeTools(log: (line: string) => void): McpTool[] {
  return [
    {
      name: 'vscode_apply_edit',
      description:
        'Replace a range (or the whole file) with new text through a workspace edit: the buffer becomes unsaved (Ctrl+Z undoes it) and the change is shown in a diff tab for review. Nothing is saved unless save is true.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute file path.' },
          text: { type: 'string', description: 'The replacement text.' },
          startLine: { type: 'integer', minimum: 1, description: '1-based first line to replace. Omit to replace the whole file.' },
          startColumn: { type: 'integer', minimum: 1, description: '1-based first column. Default 1.' },
          endLine: { type: 'integer', minimum: 1, description: '1-based last line to replace (inclusive). Defaults to startLine.' },
          endColumn: {
            type: 'integer',
            minimum: 1,
            description: '1-based last column (exclusive). Defaults to the end of endLine, so naming lines replaces whole lines.'
          },
          save: { type: 'boolean', description: 'Write the file to disk immediately. Default false.' }
        },
        required: ['path', 'text'],
        additionalProperties: false
      },
      call: async (args) => {
        const path = typeof args.path === 'string' ? args.path.trim() : ''
        if (path.length === 0) throw new Error('path is required')
        const text = typeof args.text === 'string' ? args.text : ''
        if (text.length > MAX_EDIT_CHARS) throw new Error(`text is ${text.length} characters, over the limit`)
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path))
        const before = document.getText()
        const wholeFile = args.startLine === undefined
        const startLine = clamp(integer(args.startLine, 1), 1, Math.max(1, document.lineCount))
        const startColumn = clamp(integer(args.startColumn, 1), 1, 1_000_000)
        const endLine = clamp(integer(args.endLine, wholeFile ? document.lineCount : startLine), startLine, Math.max(1, document.lineCount))
        // An omitted endColumn means "to the end of endLine": a caller naming a line
        // means that whole line. Inserting at a point needs both columns.
        const endColumn = clamp(
          args.endColumn === undefined ? document.lineAt(endLine - 1).text.length + 1 : integer(args.endColumn, 1),
          1,
          1_000_000
        )
        const range = wholeFile
          ? new vscode.Range(0, 0, document.lineCount, 0)
          : new vscode.Range(startLine - 1, startColumn - 1, endLine - 1, endColumn - 1)
        const edit = new vscode.WorkspaceEdit()
        edit.replace(document.uri, range, text)
        const applied = await vscode.workspace.applyEdit(edit)
        if (!applied) return { path, applied: false, reason: 'the workspace refused the edit' }
        if (args.save === true) await document.save()
        await vscode.window.showTextDocument(document, { preview: false })
        const diff = await openReviewDiff({ path, original: before, title: path.split(/[\\/]/).pop() + ' (DSH edit)' })
        log(`mcp: edit ${path} (${text.length} chars, saved=${args.save === true})`)
        return {
          path,
          applied: true,
          saved: args.save === true,
          range: { startLine, startColumn, endLine, endColumn },
          diff: diff.opened
        }
      }
    },
    {
      name: 'vscode_save_file',
      description: 'Save one file (by path) or every dirty editor. Use it after an edit when the file should reach disk now.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute file path. Omit to save every dirty editor.' }
        },
        additionalProperties: false
      },
      call: async (args) => {
        const path = typeof args.path === 'string' && args.path.trim().length > 0 ? args.path.trim() : undefined
        if (path) {
          const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path))
          const saved = document.isDirty ? await document.save() : true
          log(`mcp: save ${path} -> ${saved}`)
          return { saved: saved ? [path] : [], failed: saved ? [] : [path] }
        }
        const dirty = vscode.workspace.textDocuments.filter((document) => document.isDirty)
        const saved: string[] = []
        const failed: string[] = []
        for (const document of dirty) {
          if (await document.save()) saved.push(document.uri.fsPath)
          else failed.push(document.uri.fsPath)
        }
        log(`mcp: save all -> ${saved.length} saved, ${failed.length} failed`)
        return { saved, failed }
      }
    },
    {
      name: 'vscode_run_task',
      description:
        'List the workspace tasks, or run one by its label (build, test, ...). The task output appears in VS Code, not in this answer.',
      inputSchema: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Task label to run. Omit to list the available tasks.' }
        },
        additionalProperties: false
      },
      call: async (args) => {
        const label = typeof args.label === 'string' ? args.label.trim() : ''
        const tasks = await vscode.tasks.fetchTasks()
        const described = tasks.map((task) => ({
          label: task.name,
          source: task.source,
          scope: String(task.scope ?? '')
        }))
        if (label.length === 0) {
          log(`mcp: tasks -> ${described.length}`)
          return { tasks: described.slice(0, MAX_ACTIONS), truncated: described.length > MAX_ACTIONS }
        }
        const task =
          tasks.find((candidate) => candidate.name === label) ??
          tasks.find((candidate) => candidate.name.toLowerCase() === label.toLowerCase())
        if (!task) return { started: false, reason: `no task named ${label}`, tasks: described.slice(0, MAX_ACTIONS) }
        await vscode.tasks.executeTask(task)
        log(`mcp: task ${task.name} started`)
        return { started: true, label: task.name }
      }
    },
    {
      name: 'vscode_terminal_run',
      description:
        'Run a command line in a VS Code terminal named "DSH Agent". The output stays in that terminal; this answer only says it started.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command line to run.' },
          cwd: { type: 'string', description: 'Working directory. Defaults to the first workspace folder.' }
        },
        required: ['command'],
        additionalProperties: false
      },
      call: async (args) => {
        const command = typeof args.command === 'string' ? args.command.trim() : ''
        if (command.length === 0) throw new Error('command is required')
        const cwd = typeof args.cwd === 'string' && args.cwd.trim().length > 0 ? args.cwd.trim() : undefined
        const terminal = vscode.window.createTerminal({ name: 'DSH Agent', cwd })
        terminal.show(false)
        terminal.sendText(command, true)
        log(`mcp: terminal "${command}"`)
        return { started: true, command, cwd: cwd ?? null }
      }
    },
    {
      name: 'vscode_start_debug',
      description:
        'List the launch configurations, or start one by name. Debugging happens in VS Code; this answer only says it started.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Launch configuration name. Omit to list them.' }
        },
        additionalProperties: false
      },
      call: async (args) => {
        const name = typeof args.name === 'string' ? args.name.trim() : ''
        const folder = vscode.workspace.workspaceFolders?.[0]
        const configurations = (vscode.workspace.getConfiguration('launch', folder?.uri).get<Array<{ name?: string; type?: string }>>('configurations') ?? [])
          .filter((entry) => typeof entry?.name === 'string')
          .map((entry) => ({ name: String(entry.name), type: String(entry.type ?? '') }))
        if (name.length === 0) {
          log(`mcp: debug configurations -> ${configurations.length}`)
          return { configurations: configurations.slice(0, MAX_ACTIONS), truncated: configurations.length > MAX_ACTIONS }
        }
        const configuration = configurations.find((entry) => entry.name === name) ??
          configurations.find((entry) => entry.name.toLowerCase() === name.toLowerCase())
        if (!configuration) return { started: false, reason: `no launch configuration named ${name}`, configurations }
        const started = await vscode.debug.startDebugging(folder, configuration.name)
        log(`mcp: debug ${configuration.name} -> ${started}`)
        return { started, name: configuration.name }
      }
    }
  ]
}
