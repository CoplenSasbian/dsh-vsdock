/**
 * The editor-side MCP server, and the client that pairs it with QuickDock.
 *
 * This module is deliberately free of `vscode` imports: the protocol and the
 * pairing rules can be exercised by plain Node tests, and the tools that do need
 * the editor live in `tools.ts`. The wire contract is QuickDock's - the
 * `dsh-quickdock` plugin serves these three calls on its loopback listener and
 * forwards them to DSH's workspace MCP bridge (see `MCP-BRIDGE.md` in the
 * QuickDock repo):
 *
 *   POST /quickdock/api/mcp-register    { workspace, url, name?, headers?, waitMs? }
 *   POST /quickdock/api/mcp-unregister  { workspace, name? }
 *   GET  /quickdock/api/mcp-list?workspace=<absolute directory>
 *
 * Tools are scoped to the directory they were registered for: a DSH session
 * whose working directory is that directory (or below it) mounts
 * `mcp__<name>__<tool>`, and nothing else sees them.
 */

import { randomBytes } from 'node:crypto'
import { createServer, request as httpRequest } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'

import { samePath } from './paths'

// Re-exported: the pairing rules are part of this module's surface.
export { samePath }

/** Namespace of the tools DSH mounts from this server (`mcp__vscode__*`). */
export const TOOL_NAMESPACE = 'vscode'
/** Default loopback port for the editor's MCP server. */
export const DEFAULT_MCP_PORT = 47920
/** Prefix of QuickDock's dock API on its own loopback listener. */
const DOCK_API_PATH = '/quickdock/api/'

/** Protocol revisions this server can answer. */
const PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18']
const DEFAULT_PROTOCOL = '2025-06-18'
/** Bodies are JSON-RPC documents; a tool result cannot legitimately exceed this. */
const MAX_BODY_BYTES = 8 * 1024 * 1024

/** One tool: schema for `tools/list`, implementation for `tools/call`. */
export interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  call(args: Record<string, unknown>): unknown | Promise<unknown>
}

export type Log = (line: string) => void

export interface StartMcpOptions {
  /** 0 asks the OS for a free port (tests, and a second editor window). */
  port: number
  token: string
  version: string
  tools: McpTool[]
  log?: Log
}

export interface McpServerHandle {
  port: number
  url: string
  healthUrl: string
  close(): Promise<void>
}

/** A fresh capability token: 32 random bytes, base64url, no padding. */
export function newToken(): string {
  return randomBytes(32).toString('base64url')
}

/* ------------------------------- pairing -------------------------------- */

/** What the editor asks QuickDock to mount: the bridge registration body. */
export interface Registration {
  /** Absolute directory the tools belong to. */
  workspace: string
  /** This server's streamable HTTP endpoint. */
  url: string
  /** Tool namespace; QuickDock's default is derived from the URL. */
  name?: string
  /** Extra headers DSH sends to the server (the bearer token). */
  headers?: Record<string, string>
  /** How long the bridge may wait for live sessions (ms). */
  waitMs?: number
  /**
   * Build that serves these tools. Kept by QuickDock for the dock's tool panel and
   * never forwarded to the DSH bridge.
   */
  version?: string
  /** Tool names, so the dock can show what it published. Not sent to the bridge. */
  tools?: string[]
}

/** One live session mounted on a registered server. */
export interface BridgeSession {
  sessionId: string
  state: string
  error?: string
}

/** One registered server, as the bridge describes it. */
export interface BridgeServer {
  name: string
  workspace?: string
  transport?: string
  url?: string
  sessions?: BridgeSession[]
}

/** The `mcp-list` answer. */
export interface BridgeList {
  ok: boolean
  workspaces: { workspace: string; servers: BridgeServer[] }[]
}

/** The `mcp-register` answer. */
export interface BridgeRegistration {
  ok: boolean
  registered?: { name?: string; workspace?: string; url?: string }
  replaced?: boolean
  sessions?: BridgeSession[]
}

/** One call to the dock, reduced to what a caller needs to decide next. */
export interface DockAnswer<T> {
  /** Whether the dock answered 2xx with JSON. */
  ok: boolean
  /** HTTP status, or 0 when the listener did not answer at all. */
  status: number
  body?: T
  /** Why it failed: an error code (ECONNREFUSED) or the dock's own message. */
  error?: string
}

/** Absolute URL of one dock API action. */
export function dockApiUrl(port: number, action: string): string {
  return 'http://127.0.0.1:' + port + DOCK_API_PATH + action
}

/**
 * Register (or replace) this server for one workspace directory.
 * @param port QuickDock's loopback port.
 * @param registration the bridge body.
 * @param timeoutMs budget; the bridge may wait `waitMs` for live sessions.
 */
export function registerEditorServer(
  port: number,
  registration: Registration,
  timeoutMs = 20_000
): Promise<DockAnswer<BridgeRegistration>> {
  return requestJson<BridgeRegistration>(port, 'mcp-register', 'POST', registration, undefined, timeoutMs)
}

/** Remove this server (or every server) of one workspace directory. */
export function unregisterEditorServer(
  port: number,
  workspace: string,
  name: string = TOOL_NAMESPACE,
  timeoutMs = 8_000
): Promise<DockAnswer<{ ok: boolean; removed?: string[] }>> {
  return requestJson(port, 'mcp-unregister', 'POST', { workspace, name }, undefined, timeoutMs)
}

/** What DSH currently mounts for one workspace directory. */
export function listEditorServers(
  port: number,
  workspace: string,
  timeoutMs = 5_000
): Promise<DockAnswer<BridgeList>> {
  return requestJson<BridgeList>(port, 'mcp-list', 'GET', undefined, { workspace }, timeoutMs)
}

/** One file mutation DSH's own tools reported (`GET /quickdock/api/file-events`). */
export interface FileEvent {
  /** Monotonic sequence; pass the highest one back as `since`. */
  seq: number
  /** Path as DSH displays it: absolute, or relative to the session's folder. */
  path: string
  /** Whether the file is now present, or was removed. */
  kind: 'write' | 'delete'
  /** Epoch milliseconds at the DSH side. */
  at?: number
}

/** The `file-events` answer: what happened after the caller's cursor. */
export interface FileEventAnswer {
  ok: boolean
  /** Highest sequence the dock has recorded; the next `since`. */
  seq: number
  events: FileEvent[]
  /** Events the dock's ring had already dropped before the cursor. */
  dropped?: number
}

/**
 * The writes DSH's own file tools made after a cursor.
 *
 * This is the only write attribution that exists: the dock reports what DSH's
 * filesystem service observed, and a build tool started from a shell never
 * appears in it. The call long-polls, so it may take up to `waitMs` to answer.
 * @param port QuickDock's loopback port.
 * @param since last sequence this client saw.
 * @param waitMs long-poll budget; the dock caps it at 25 s.
 */
export function listFileEvents(
  port: number,
  since: number,
  waitMs = 15_000
): Promise<DockAnswer<FileEventAnswer>> {
  return requestJson<FileEventAnswer>(
    port,
    'file-events',
    'GET',
    undefined,
    { since: String(Math.max(0, Math.trunc(since))), wait: String(Math.max(0, Math.trunc(waitMs))) },
    waitMs + 10_000
  )
}

/**
 * The registration the bridge holds for one directory, when it holds one.
 * @param body the `mcp-list` answer.
 * @param workspace absolute directory to look for.
 * @param name tool namespace.
 */
export function findRegistration(
  body: BridgeList | undefined,
  workspace: string,
  name: string = TOOL_NAMESPACE
): BridgeServer | undefined {
  const entry = body?.workspaces?.find((candidate) => samePath(candidate.workspace, workspace))
  return entry?.servers?.find((server) => server.name === name)
}

/**
 * Whether registering is needed: nothing mounted yet, or another endpoint.
 * @param body the `mcp-list` answer.
 * @param registration what this editor would register.
 */
export function needsRegistration(body: BridgeList | undefined, registration: Registration): boolean {
  const current = findRegistration(body, registration.workspace, registration.name ?? TOOL_NAMESPACE)
  return current === undefined || current.url !== registration.url
}

/**
 * Call one dock action and read one JSON answer.
 *
 * A refused connection is an answer, not an exception: the extension retries on
 * its next beat instead of showing a dialog for a DSH that is still starting.
 * @param port QuickDock's loopback port.
 * @param action dock API action name.
 * @param method HTTP method.
 * @param body JSON body for POST.
 * @param query query parameters for GET.
 * @param timeoutMs per-call budget.
 */
function requestJson<T>(
  port: number,
  action: string,
  method: 'GET' | 'POST',
  body: unknown,
  query: Record<string, string> | undefined,
  timeoutMs: number
): Promise<DockAnswer<T>> {
  const url = new URL(dockApiUrl(port, action))
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value)
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8')
  const headers: Record<string, string> = { accept: 'application/json' }
  if (payload) {
    headers['content-type'] = 'application/json'
    headers['content-length'] = String(payload.length)
  }

  return new Promise<DockAnswer<T>>((resolve) => {
    let settled = false
    const done = (answer: DockAnswer<T>): void => {
      if (settled) return
      settled = true
      resolve(answer)
    }
    const request = httpRequest(url, { method, headers, timeout: timeoutMs }, (response: IncomingMessage) => {
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size <= 2 * 1024 * 1024) chunks.push(chunk)
      })
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        const status = response.statusCode ?? 0
        let parsed: unknown
        try {
          parsed = text.trim() ? JSON.parse(text) : undefined
        } catch (_) {
          done({ ok: false, status, error: 'the dock answered with something other than JSON' })
          return
        }
        if (status < 200 || status >= 300) {
          const message = (parsed as { error?: unknown } | undefined)?.error
          done({ ok: false, status, error: typeof message === 'string' ? message : 'HTTP ' + status })
          return
        }
        done({ ok: true, status, body: parsed as T })
      })
      response.on('error', (error: NodeJS.ErrnoException) => {
        done({ ok: false, status: 0, error: error.code ?? error.message })
      })
    })
    request.on('timeout', () => {
      request.destroy(new Error('no answer in ' + timeoutMs + ' ms'))
    })
    request.on('error', (error: NodeJS.ErrnoException) => {
      done({ ok: false, status: 0, error: error.code ?? error.message })
    })
    if (payload) request.write(payload)
    request.end()
  })
}

/* -------------------------------- server -------------------------------- */

interface JsonRpcMessage {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: Record<string, unknown>
}

const SUPPORTED_PROTOCOL = (requested: unknown): string => {
  const text = String(requested ?? '')
  return PROTOCOL_VERSIONS.includes(text) ? text : DEFAULT_PROTOCOL
}

/**
 * Start the MCP server on loopback.
 *
 * Responses are plain JSON (`application/json`), which the streamable HTTP
 * client accepts; `GET /mcp` answers 405 because this server never initiates
 * messages, and `DELETE /mcp` ends a session with 204.
 */
export async function startMcpServer(options: StartMcpOptions): Promise<McpServerHandle> {
  const tools = new Map(options.tools.map((tool) => [tool.name, tool]))
  const log = options.log ?? (() => {})

  const server = createServer((req, res) => {
    void dispatch(req, res).catch((error) => {
      log(`mcp: request failed: ${String((error as Error)?.message ?? error)}`)
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'internal error' } }))
      }
    })
  })

  async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const auth = req.headers.authorization
    if (auth !== 'Bearer ' + options.token) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }

    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify({ ok: true, version: options.version, tools: tools.size }))
      return
    }

    if (url.pathname !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'not found' }))
      return
    }

    if (req.method === 'GET') {
      // No server-initiated messages: 405 is the streamable HTTP "no SSE" answer.
      res.writeHead(405, { Allow: 'POST, DELETE', 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'no server-initiated stream' }))
      return
    }
    if (req.method === 'DELETE') {
      res.writeHead(204)
      res.end()
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST, DELETE' })
      res.end()
      return
    }

    const body = await readBody(req)
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch (_) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }))
      return
    }

    const batch = Array.isArray(parsed)
    const messages = (batch ? parsed : [parsed]) as JsonRpcMessage[]
    const responses: unknown[] = []
    let sessionId: string | undefined
    let initialized = false

    for (const message of messages) {
      const result = await answer(message, tools, options.version)
      if (result.sessionId) {
        sessionId = result.sessionId
        initialized = true
      }
      if (result.response) responses.push(result.response)
    }

    if (responses.length === 0) {
      res.writeHead(202, sessionId ? { 'Mcp-Session-Id': sessionId } : {})
      res.end()
      return
    }
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    }
    if (initialized && sessionId) headers['Mcp-Session-Id'] = sessionId
    res.writeHead(200, headers)
    res.end(JSON.stringify(batch ? responses : responses[0]))
  }

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error)
    server.once('error', onError)
    server.listen(options.port, '127.0.0.1', () => {
      server.off('error', onError)
      resolve()
    })
  })

  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : options.port
  log(`mcp: listening on http://127.0.0.1:${port}/mcp with ${tools.size} tool(s)`)

  return {
    port,
    url: `http://127.0.0.1:${port}/mcp`,
    healthUrl: `http://127.0.0.1:${port}/health`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      })
  }
}

/** Collect the request body, refusing anything absurd. */
async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

interface Answer {
  response?: unknown
  sessionId?: string
}

/** Answer one JSON-RPC message; notifications produce no response. */
async function answer(
  message: JsonRpcMessage,
  tools: Map<string, McpTool>,
  version: string
): Promise<Answer> {
  const id = message.id ?? null
  const isNotification = message.id === undefined
  const reply = (result: unknown): Answer => ({
    response: isNotification ? undefined : { jsonrpc: '2.0', id, result }
  })
  const fail = (code: number, text: string): Answer => ({
    response:
      isNotification
        ? undefined
        : { jsonrpc: '2.0', id, error: { code, message: text } }
  })

  switch (message.method) {
    case 'initialize': {
      const sessionId = randomBytes(16).toString('hex')
      return {
        sessionId,
        response: {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: SUPPORTED_PROTOCOL(message.params?.protocolVersion),
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'dsh-vsdock', version },
            instructions:
              'Editor tools from VS Code: diagnostics, symbols, the active selection, file reads, and a read-only diff editor for reviewing changes.'
          }
        }
      }
    }
    case 'ping':
      return reply({})
    case 'tools/list':
      return reply({
        tools: [...tools.values()].map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema
        }))
      })
    case 'tools/call': {
      const name = String(message.params?.name ?? '')
      const tool = tools.get(name)
      if (!tool) return fail(-32602, `unknown tool: ${name}`)
      const args =
        message.params?.arguments && typeof message.params.arguments === 'object'
          ? (message.params.arguments as Record<string, unknown>)
          : {}
      try {
        const value = await tool.call(args)
        const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
        return reply({ content: [{ type: 'text', text }] })
      } catch (error) {
        const text = String((error as Error)?.message ?? error)
        return reply({ content: [{ type: 'text', text: `error: ${text}` }], isError: true })
      }
    }
    default:
      // Notifications (`notifications/initialized`, …) need no answer; unknown
      // requests get a method-not-found error.
      return isNotification ? {} : fail(-32601, `method not found: ${String(message.method)}`)
  }
}

/** Exposed for tests: the raw server (so a test can inspect state if needed). */
export type { Server }
