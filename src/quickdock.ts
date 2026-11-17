/**
 * The QuickDock contract, without any dependency on `vscode`.
 *
 * Everything here is pure or Node-only so it can be unit tested in a plain
 * Node process (see `test/`): where QuickDock keeps its configuration, which
 * port is in effect, and whether its listener answers.
 *
 * The extension is a thin client: QuickDock (the `dsh-quickdock` DSH plugin)
 * serves a shell page on a loopback port, and that page embeds DSH's own Web UI.
 * The port is fixed by the plugin's configuration, so this module mirrors the
 * plugin's defaults and discovery rules exactly.
 */

import { existsSync, readFileSync } from 'node:fs'
import { get as httpGet } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Loopback port the plugin binds when nothing says otherwise. Mirrors `host/constants.js`. */
export const DEFAULT_PORT = 47910
/** The manifest `name` the listen endpoint must report for us to trust it. */
export const PLUGIN_NAME = 'dsh-quickdock'

const HOST = '127.0.0.1'
const PAGE_PATH = '/quickdock'
const API_PREFIX = '/quickdock/api/'
const META_PATH = API_PREFIX + 'meta'
const MAX_BODY_BYTES = 64 * 1024

/** The two filesystem calls detection needs, injectable for tests. */
export interface FsLike {
  existsSync(path: string): boolean
  readFileSync(path: string, encoding: 'utf8'): string
}

const nodeFs: FsLike = {
  existsSync,
  readFileSync: (path, encoding) => readFileSync(path, encoding)
}

/** Where the plugin keeps `config.json` and `host.log`. */
export interface Detection {
  /** Port recorded by the plugin (0 means the listener is switched off). */
  port: number
  /** Which file the value came from. */
  source: 'config-file' | 'log'
  /** Absolute path of that file. */
  file: string
}

/** The port this client will talk to, and why. */
export interface PortInfo {
  port: number
  source: 'setting' | 'config-file' | 'log' | 'default'
  /** The file a detected port came from. */
  file?: string
}

/** What went wrong when the listener did not answer as QuickDock. */
export type ProbeFailure = 'refused' | 'timeout' | 'unreachable' | 'http' | 'json' | 'foreign' | 'disabled'

/** Capability manifest served by `GET /quickdock/api/meta`. */
export interface QuickDockMeta {
  name: string
  apiVersion?: number
  version?: string
  components?: Record<string, boolean>
  capabilities?: string[]
  /** Shell variants the plugin renders (`electron`, `vscode`, `browser`). */
  views?: string[]
  /**
   * Where a dock's MCP endpoint is registered, added by QuickDock 0.6.
   *
   * Its presence is what tells this extension the dock's title bar can host the
   * editor-tools switch; an older build has neither.
   */
  mcpBridge?: { enabled?: boolean; origin?: string | null; route?: string; tokenRequired?: boolean }
}

/** One probe of the listener. */
export interface ProbeResult {
  ok: boolean
  port: number
  meta?: QuickDockMeta
  failure?: ProbeFailure
  /** Short technical detail for logs and tooltips (error code, status line). */
  detail: string
  /** Milliseconds the probe took. */
  elapsed: number
}

/**
 * The directory the plugin uses for its state: `DSH_QUICKDOCK_STATE_DIR` when
 * set, else `LOCALAPPDATA` (falling back to the temp directory), plus
 * `dsh-quickdock`. Mirrors `host/trace.js`.
 */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  const custom = env.DSH_QUICKDOCK_STATE_DIR
  if (custom && custom.trim()) return custom.trim()
  const base = env.LOCALAPPDATA || env.TEMP || tmpdir()
  return join(base, PLUGIN_NAME)
}

/** Absolute path of the plugin's `config.json`. */
export function configFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(stateDir(env), 'config.json')
}

/** Absolute path of the plugin's `host.log`. */
export function hostLogFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(stateDir(env), 'host.log')
}

/** Whether a number can be a loopback port. 0 is valid and means "off". */
export function isValidPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 65535
}

/** Whether a number can be stored in the `dshVsdock.port` setting (0 is not a port). */
export function isUsablePort(value: unknown): value is number {
  return isValidPort(value) && value > 0
}

/**
 * The port recorded in a `config.json` body.
 * @param text raw file contents.
 * @returns the port, or undefined when absent or malformed.
 */
export function readPortFromConfig(text: string): number | undefined {
  try {
    const value: unknown = JSON.parse(text)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const port = (value as { port?: unknown }).port
    const number = typeof port === 'number' ? port : Number(port)
    return isValidPort(number) ? Math.trunc(number) : undefined
  } catch {
    return undefined
  }
}

/**
 * The last port the plugin logged as listening.
 *
 * `config.json` is authoritative, but the log line records the address that was
 * actually bound, which is what a client needs when the two ever disagree.
 * @param text raw `host.log` contents (the tail is enough).
 * @returns the last recorded port, or undefined.
 */
export function readPortFromLog(text: string): number | undefined {
  const pattern = /server listening on http:\/\/127\.0\.0\.1:(\d+)/g
  let match: RegExpExecArray | null
  let last: number | undefined
  while ((match = pattern.exec(text)) !== null) {
    const port = Number(match[1])
    if (isValidPort(port)) last = port
  }
  return last
}

/**
 * Find the port the running plugin actually uses.
 *
 * `config.json` wins: it is the value the plugin writes whenever the user
 * changes the port (Settings → QuickDock → Connection), so it is the source of
 * truth. `host.log` is the fallback for an install whose config file has not
 * been written yet.
 * @param env environment (LOCALAPPDATA / DSH_QUICKDOCK_STATE_DIR).
 * @param fs filesystem access (injected by tests).
 * @returns the detected port and where it came from.
 */
export function detectQuickDockPort(
  env: NodeJS.ProcessEnv = process.env,
  fs: FsLike = nodeFs
): Detection | undefined {
  const file = configFile(env)
  try {
    if (fs.existsSync(file)) {
      const port = readPortFromConfig(fs.readFileSync(file, 'utf8'))
      if (port !== undefined) return { port, source: 'config-file', file }
    }
  } catch {
    /* an unreadable config is a missing config */
  }
  const log = hostLogFile(env)
  try {
    if (fs.existsSync(log)) {
      const port = readPortFromLog(fs.readFileSync(log, 'utf8'))
      if (port !== undefined) return { port, source: 'log', file: log }
    }
  } catch {
    /* no log: keep the default */
  }
  return undefined
}

/**
 * Decide which port to use.
 *
 * Precedence mirrors the question "what did the user say last?":
 * 1. `dshVsdock.port`, when it is explicitly set (workspace or user settings);
 * 2. QuickDock's own `config.json` (or `host.log`), when follow mode is on;
 * 3. the plugin's compiled-in default.
 * @param input the explicit setting, whether to follow the plugin, and the detection.
 * @returns the port and the reason it was chosen.
 */
export function resolvePort(input: {
  setting?: number
  follow: boolean
  detected?: Detection
}): PortInfo {
  if (isUsablePort(input.setting)) return { port: input.setting, source: 'setting' }
  if (input.follow && input.detected) {
    return { port: input.detected.port, source: input.detected.source, file: input.detected.file }
  }
  return { port: DEFAULT_PORT, source: 'default' }
}

/** `http://127.0.0.1:<port>` */
export function baseUrl(port: number): string {
  return 'http://' + HOST + ':' + port
}

/** The shell page variants a client may ask the plugin for. */
export type QuickDockView = 'vscode' | 'browser'

/**
 * The shell page address for one view.
 *
 * `view` is the plugin's client discriminator: `vscode` trims the desktop
 * window controls and serves the app through the Host's app proxy, `browser`
 * keeps the trimmed bar but embeds the app directly (a tab is first-party).
 * @param port QuickDock loopback port.
 * @param view which client the page is rendered for.
 * @returns the absolute shell URL.
 */
export function pageUrl(port: number, view: QuickDockView = 'vscode'): string {
  return baseUrl(port) + PAGE_PATH + '?view=' + view
}

/** The capability manifest. */
export function metaUrl(port: number): string {
  return baseUrl(port) + META_PATH
}

/**
 * Whether a QuickDock build can serve an IDE tab.
 *
 * `app-proxy` is what lets `view=vscode` embed the DSH app inside a webview;
 * without it the tab could only show the authentication page, so an older
 * plugin is a clear "update QuickDock" instead of a broken tab.
 * @param meta the manifest reported by the listener.
 * @returns true when the vscode view is supported.
 */
export function supportsEmbeddedView(meta?: QuickDockMeta): boolean {
  return Boolean(meta && Array.isArray(meta.capabilities) && meta.capabilities.includes('app-proxy'))
}

/**
 * Ask the listener who it is.
 *
 * `GET /quickdock/api/meta` is the plugin's documented capability manifest, so
 * a 200 with `name: "dsh-quickdock"` proves both that something is listening and
 * that it is QuickDock (and not an unrelated server on the same port).
 * @param port loopback port to probe.
 * @param timeoutMs how long to wait before calling it unreachable.
 * @returns the outcome; never rejects.
 */
export function probeQuickDock(port: number, timeoutMs = 1500): Promise<ProbeResult> {
  const started = Date.now()
  const finish = (result: Omit<ProbeResult, 'elapsed'>): ProbeResult => ({
    ...result,
    elapsed: Date.now() - started
  })
  if (!isValidPort(port) || port === 0) {
    return Promise.resolve(finish({ ok: false, port, failure: 'disabled', detail: String(port) }))
  }
  return new Promise<ProbeResult>((resolve) => {
    let settled = false
    let request: ReturnType<typeof httpGet> | undefined
    const done = (result: Omit<ProbeResult, 'elapsed'>): void => {
      if (settled) return
      settled = true
      resolve(finish(result))
    }
    try {
      request = httpGet(
        {
          host: HOST,
          port,
          path: META_PATH,
          headers: { accept: 'application/json', connection: 'close' }
        },
        (response) => {
          const chunks: Buffer[] = []
          let size = 0
          response.on('data', (chunk: Buffer) => {
            size += chunk.length
            // The manifest is tiny; anything bigger is not ours.
            if (size <= MAX_BODY_BYTES) chunks.push(chunk)
          })
          response.on('end', () => {
            const status = response.statusCode ?? 0
            if (status !== 200) {
              done({ ok: false, port, failure: 'http', detail: 'HTTP ' + status })
              return
            }
            let meta: QuickDockMeta
            try {
              meta = JSON.parse(Buffer.concat(chunks).toString('utf8')) as QuickDockMeta
            } catch {
              done({ ok: false, port, failure: 'json', detail: 'invalid JSON' })
              return
            }
            if (!meta || meta.name !== PLUGIN_NAME) {
              const name = meta && typeof meta.name === 'string' ? meta.name : ''
              done({ ok: false, port, failure: 'foreign', detail: name || 'unknown server' })
              return
            }
            done({ ok: true, port, meta, detail: meta.version ?? 'ok' })
          })
          response.on('error', () => {
            done({ ok: false, port, failure: 'unreachable', detail: 'response error' })
          })
        }
      )
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code ?? 'error'
      done({ ok: false, port, failure: 'unreachable', detail: code })
      return
    }
    request.setTimeout(timeoutMs, () => {
      done({ ok: false, port, failure: 'timeout', detail: 'no answer in ' + timeoutMs + ' ms' })
      request?.destroy()
    })
    request.on('error', (error: NodeJS.ErrnoException) => {
      const code = error?.code || 'error'
      const failure: ProbeFailure =
        code === 'ECONNREFUSED' ? 'refused' : code === 'ETIMEDOUT' ? 'timeout' : 'unreachable'
      done({ ok: false, port, failure, detail: code })
    })
  })
}
