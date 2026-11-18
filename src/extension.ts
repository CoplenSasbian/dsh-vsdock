/**
 * DSH Dock: QuickDock's compact DSH UI in a VS Code tab.
 *
 * The heavy lifting belongs to `dsh-quickdock`: it serves a shell page on a
 * loopback port, and that page embeds DSH's own Web UI (sessions, tool cards,
 * approvals). This extension is the client side of that contract - it opens the
 * tab, resolves the port (which the plugin lets users move), and explains what
 * to do when nothing answers.
 */

import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'

import * as vscode from 'vscode'

import { dshCommandLine, listProfiles, looksLikePath, type FsLike } from './dsh'
import { openReviewDiff } from './diff'
import { renderConnecting, renderFrame, renderOffline, type Translate } from './html'
import { EditReview } from './review-watcher'
import {
  DEFAULT_MCP_PORT,
  TOOL_NAMESPACE,
  listEditorServers,
  needsRegistration,
  newToken,
  registerEditorServer,
  samePath,
  startMcpServer,
  unregisterEditorServer,
  type McpServerHandle,
  type Registration
} from './mcp'
import {
  DEFAULT_PORT,
  configFile,
  detectQuickDockPort,
  hostLogFile,
  isUsablePort,
  pageUrl,
  probeQuickDock,
  resolvePort,
  stateDir,
  supportsEmbeddedView,
  type Detection,
  type PortInfo,
  type ProbeResult
} from './quickdock'
import { editorTools } from './tools'

const VIEW_ID = 'dshVsdock.dock'
/** Commands the webview's offline page may link to, and nothing else. */
const COMMAND_URIS = [
  'dshVsdock.retry',
  'dshVsdock.startDsh',
  'dshVsdock.useDetectedPort',
  'dshVsdock.openPortSettings',
  'dshVsdock.openLog'
]
const STATUS_REFRESH_MS = 20_000
/** How often the editor tools are checked against DSH (and re-registered). */
const MCP_SYNC_MS = 20_000
/** Reuse a probe for this long instead of hitting the socket again. */
const PROBE_CACHE_MS = 4_000
/**
 * Digest of the tool set DSH last mounted.
 *
 * The bridge mounts a client per session; a session keeps the tool list it
 * connected with. An upgraded extension therefore has to *remount* once, and this
 * key is how it knows its tool set moved on (`register` replaces the endpoint).
 */
const TOOL_FINGERPRINT_KEY = 'dshVsdock.mcpTools'
/** How long a launched DSH gets to answer on QuickDock's port (ms). */
const DSH_START_TIMEOUT_MS = 90_000
/** How often the launch is checked while waiting (ms). */
const DSH_START_POLL_MS = 1_500

/** The two filesystem calls the profile listing needs. */
const nodeFs: FsLike = {
  existsSync,
  readdirSync: (path) => readdirSync(path)
}

/** DSH's home directory: `$DSH_HOME`, else `~/.dsh` (where `profiles/` lives). */
function dshHome(): string {
  const custom = process.env.DSH_HOME
  if (typeof custom === 'string' && custom.trim().length > 0) return custom.trim()
  return join(homedir(), '.dsh')
}

const translate: Translate = (message, ...args) => vscode.l10n.t(message, ...args)

let channel: vscode.OutputChannel

function log(message: string): void {
  channel.appendLine(`[${new Date().toISOString()}] ${message}`)
}

/** One sentence explaining a failed probe, for tooltips and the offline page. */
function probeReason(result: ProbeResult): string {
  switch (result.failure) {
    case 'disabled':
      return translate('the listener is switched off (port 0)')
    case 'refused':
      return translate('connection refused — nothing is listening on that port')
    case 'timeout':
      return translate('no answer in time')
    case 'http':
      return translate('the port answered with {0}', result.detail)
    case 'json':
      return translate('something answered, but not with QuickDock\'s manifest')
    case 'foreign':
      return translate('another program is listening on that port ({0})', result.detail)
    default:
      return translate('the connection failed ({0})', result.detail)
  }
}

/** Why this port was chosen, in words (status bar tooltip). */
function sourceNote(info: PortInfo): string {
  switch (info.source) {
    case 'setting':
      return translate('Port from the dshVsdock.port setting.')
    case 'config-file':
      return translate('Port from QuickDock\'s config.json.')
    case 'log':
      return translate('Port from QuickDock\'s host.log.')
    default:
      return translate('QuickDock\'s default port; nothing in its configuration overrides it.')
  }
}

class DockController implements vscode.Disposable {
  private view: vscode.WebviewView | undefined
  private statusItem: vscode.StatusBarItem | undefined
  private timer: NodeJS.Timeout | undefined
  private focusListener: vscode.Disposable | undefined
  private lastProbe: ProbeResult | undefined
  private lastProbeAt = 0
  private renderedPort: number | undefined
  private renderedOk: boolean | undefined
  private loadSeq = 0
  private probing = false
  /**
   * The running editor MCP server and what DSH mounts from it.
   *
   * `registered` maps the workspace folder (as VS Code spells it) to the endpoint
   * registered for it, so a folder the user closed can be unregistered again.
   */
  private mcp:
    | {
        handle: McpServerHandle
        timer: NodeJS.Timeout
        token: string
        registered: Map<string, string>
      }
    | undefined
  private mcpStarting = false
  private mcpSyncing = false
  /** Last pairing failure, so a heartbeat does not repeat it in the log. */
  private mcpFailure = ''
  /** One id per editor window: QuickDock keeps one dock context per id. */
  private readonly dockId = 'vscode-' + randomBytes(6).toString('hex')
  /** Automatic review of changes made outside the editor (see review-watcher.ts). */
  private review: EditReview | undefined
  /** The terminal a launched DSH runs in, reused while it is alive. */
  private dshTerminal: vscode.Terminal | undefined
  private dshStarting = false

  constructor(private readonly context: vscode.ExtensionContext) {}

  /* ------------------------------- lifecycle ------------------------------- */

  /** Create the status bar entry and start the background probe. */
  start(): void {
    this.syncStatusBar()
    this.timer = setInterval(() => this.refreshStatus(), STATUS_REFRESH_MS)
    this.focusListener = vscode.window.onDidChangeWindowState((state) => {
      if (!state.focused) return
      if (Date.now() - this.lastProbeAt > 10_000) this.refreshStatus()
      // Coming back to the editor is when a DSH restart is most likely to have
      // happened behind our back: re-check the pairing now instead of on the beat.
      void this.syncMcp('focus')
    })
    this.refreshStatus()
    if (this.mcpEnabled()) void this.startMcp()
    this.syncReview()
    this.syncReviewContext()
    log(`review: automatic diffs are ${this.reviewEnabled() ? 'on' : 'off'}`)
  }

  dispose(): void {
    this.stopMcp()
    this.review?.dispose()
    this.review = undefined
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.focusListener?.dispose()
    this.statusItem?.dispose()
    this.statusItem = undefined
  }

  /* ------------------------------ resolution ------------------------------ */

  /** The value of `dshVsdock.port`, but only when the user actually set it. */
  private explicitPort(): number | undefined {
    const inspected = vscode.workspace.getConfiguration('dshVsdock').inspect<number>('port')
    const explicit =
      inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? inspected?.globalValue
    return typeof explicit === 'number' ? explicit : undefined
  }

  private follow(): boolean {
    return vscode.workspace.getConfiguration('dshVsdock').get<boolean>('followQuickDockConfig', true)
  }

  /** The port in effect, and the detection behind it. */
  private resolve(): { info: PortInfo; detected?: Detection } {
    const detected = detectQuickDockPort()
    const setting = this.explicitPort()
    const info = resolvePort({ setting, follow: this.follow(), detected })
    return { info, detected }
  }

  /** Probe, reusing a recent answer unless `force` is set. */
  private async probe(port: number, force = false): Promise<ProbeResult> {
    if (!force && this.lastProbe && this.lastProbe.port === port && Date.now() - this.lastProbeAt < PROBE_CACHE_MS) {
      return this.lastProbe
    }
    const result = await probeQuickDock(port)
    this.lastProbe = result
    this.lastProbeAt = Date.now()
    return result
  }

  /* -------------------------------- dsh ---------------------------------- */

  /** The configured `dsh` executable: a name on PATH, or an absolute path. */
  private dshCommand(): string {
    const value = vscode.workspace.getConfiguration('dshVsdock').get<string>('dshCommand', 'dsh')
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : 'dsh'
  }

  /** The configured profile, empty when DSH should pick its own default. */
  private dshProfile(): string {
    const value = vscode.workspace.getConfiguration('dshVsdock').get<string>('dshProfile', '')
    return typeof value === 'string' ? value.trim() : ''
  }

  /** Extra arguments appended to the launch line. */
  private dshArgs(): string {
    const value = vscode.workspace.getConfiguration('dshVsdock').get<string>('dshArgs', '')
    return typeof value === 'string' ? value.trim() : ''
  }

  /**
   * Boot DSH in a terminal when nothing answers.
   *
   * The extension never starts DSH behind the user's back: this is the action the
   * offline card and the palette offer, it runs the configured command visibly in
   * a terminal, and the dock reloads by itself once the listener answers.
   */
  async startDsh(): Promise<void> {
    const { info } = this.resolve()
    if (info.port <= 0) {
      void vscode.window.showInformationMessage(
        translate('QuickDock is switched off (port 0), so starting DSH would not make the dock appear.')
      )
      return
    }
    if (this.dshStarting) return
    const current = await this.probe(info.port, true)
    if (current.ok) {
      void vscode.window.showInformationMessage(
        translate('DSH is already answering on port {0}.', info.port)
      )
      await this.open()
      return
    }
    this.dshStarting = true
    try {
      const command = this.dshCommand()
      if (looksLikePath(command) && !existsSync(command)) {
        const choice = await vscode.window.showErrorMessage(
          translate('The configured dsh command does not exist: {0}', command),
          translate('Open Settings')
        )
        if (choice === translate('Open Settings')) await this.openSetting('dshVsdock.dshCommand')
        return
      }
      const profile = await this.chooseProfile()
      if (profile === undefined) {
        log('dsh: start cancelled at the profile picker')
        return
      }
      let line: string
      try {
        line = dshCommandLine({ command, profile, args: this.dshArgs() })
      } catch (error) {
        void vscode.window.showErrorMessage(String((error as Error)?.message ?? error))
        return
      }
      this.startDshTerminal(line)
      void vscode.window.showInformationMessage(translate('Starting DSH in a terminal: {0}', line))
      await this.waitForDsh(info.port)
    } finally {
      this.dshStarting = false
    }
  }

  /**
   * Which profile to boot: the configured one, or a picker when it is unset.
   *
   * `dsh` refuses to start without `--profile <name>`, so there is no "let DSH
   * choose": the launch either has a name or does not happen.
   * @returns the profile name, or undefined to cancel.
   */
  private async chooseProfile(): Promise<string | undefined> {
    const configured = this.dshProfile()
    if (configured.length > 0) return configured
    const home = dshHome()
    const profiles = listProfiles(home, nodeFs)
    if (profiles.length === 0) {
      const choice = await vscode.window.showErrorMessage(
        translate(
          'No DSH profile found under {0}. Set {1} to the profile to boot - for example desktop.',
          join(home, 'profiles'),
          'dshVsdock.dshProfile'
        ),
        translate('Open Settings')
      )
      if (choice === translate('Open Settings')) await this.openSetting('dshVsdock.dshProfile')
      return undefined
    }
    const picked = await vscode.window.showQuickPick(
      profiles.map((name) => ({ label: name, description: 'dsh --profile ' + name })),
      {
        title: translate('Which DSH profile should start?'),
        placeHolder: translate('The profile decides which plugins and apps boot. {0} pins this choice.', 'dshVsdock.dshProfile')
      }
    )
    return picked ? picked.label : undefined
  }

  /** One terminal per window: reuse ours while it is alive, otherwise make one. */
  private startDshTerminal(line: string): void {
    if (!this.dshTerminal || this.dshTerminal.exitStatus !== undefined) {
      this.dshTerminal = vscode.window.createTerminal({
        name: 'DSH',
        iconPath: new vscode.ThemeIcon('rocket'),
        cwd: this.workspaceFolders()[0]
      })
      this.dshTerminal.show(false)
    } else {
      this.dshTerminal.show(false)
    }
    this.dshTerminal.sendText(line, true)
    log(`dsh: sent "${line}" to the DSH terminal`)
  }

  /** Watch the listener until it answers (or give up with the terminal's output). */
  private async waitForDsh(port: number): Promise<void> {
    const deadline = Date.now() + DSH_START_TIMEOUT_MS
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, DSH_START_POLL_MS))
      const probe = await this.probe(port, true)
      if (!probe.ok) continue
      log(`dsh: answering on ${port} after the launch`)
      void vscode.window.showInformationMessage(translate('DSH is up: the dock is reconnecting.'))
      this.lastProbeAt = 0
      if (this.view) await this.load(this.view)
      else await this.refreshStatus(true)
      return
    }
    log(`dsh: no answer on ${port} within ${DSH_START_TIMEOUT_MS / 1000} s`)
    void vscode.window.showWarningMessage(
      translate(
        'DSH did not answer within {0} seconds. Check the DSH terminal and the {1} setting.',
        Math.round(DSH_START_TIMEOUT_MS / 1000),
        'dshVsdock.dshCommand'
      )
    )
  }

  /* -------------------------------- view --------------------------------- */

  /**
   * Reveal the dock.
   *
   * The dock is a webview view in the secondary side bar (the side Copilot
   * chat lives in), not an editor tab: a sidebar can be dragged between the two
   * sides and does not steal the editor area.
   */
  async open(): Promise<void> {
    try {
      await vscode.commands.executeCommand('workbench.view.extension.dshVsdock')
    } catch (error) {
      log(`cannot reveal the dock container: ${String((error as Error)?.message ?? error)}`)
    }
    if (this.view) {
      const { info } = this.resolve()
      // A moved port must not leave the view showing the old address.
      if (this.renderedPort !== undefined && this.renderedPort !== info.port) void this.load(this.view)
      // Make the dock the active view in its bar, not just visible in it.
      this.view.show?.(true)
    }
  }

  /**
   * Called by VS Code the first time the view is shown (and after a reload).
   * @param webviewView the contributed view.
   */
  resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = this.webviewOptions()
    webviewView.onDidDispose(() => {
      if (this.view === webviewView) this.view = undefined
    })
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) this.onShown()
    })
    // The dock's own title bar asks for the editor-tools switch (see html.ts).
    webviewView.webview.onDidReceiveMessage((message: unknown) => {
      const payload = message as { type?: unknown; path?: unknown } | undefined
      const type = payload?.type
      if (type === 'dshVsdock.mcp-toggle') void this.toggleMcp()
      if (type === 'dshVsdock.open-file' && typeof payload?.path === 'string' && payload.path) {
        void this.openDockFile(payload.path)
      }
    })
    this.view = webviewView
    // A fresh view document: render it from scratch.
    this.renderedPort = undefined
    this.renderedOk = undefined
    void this.load(webviewView)
  }

  /** Re-render only when the view was never filled in or the port moved. */
  private onShown(): void {
    if (!this.view) return
    const { info } = this.resolve()
    if (this.renderedPort !== info.port || this.renderedOk === false) void this.load(this.view)
  }

  private webviewOptions(): vscode.WebviewOptions {
    return {
      // The shell page inside the iframe is a full application: scripts must run.
      enableScripts: true,
      // Only the four commands the offline page links to.
      enableCommandUris: COMMAND_URIS,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
    }
  }

  /** Render the current state of the listener into the view. */
  private async load(view: vscode.WebviewView): Promise<void> {
    const seq = ++this.loadSeq
    const { info, detected } = this.resolve()
    this.renderedPort = info.port
    if (info.port > 0) {
      view.webview.html = renderConnecting({ port: info.port, lang: vscode.env.language, t: translate })
    }
    const result = await this.probe(info.port)
    // A newer load took over, or the view went away.
    if (seq !== this.loadSeq || this.view !== view) return

    // `view=vscode` is the plugin's IDE contract: trimmed chrome, and the app
    // served through the Host's app proxy (the webview cannot carry DSH's
    // SameSite=Strict cookie itself).
    const embeddable = result.ok && supportsEmbeddedView(result.meta)
    this.renderedOk = embeddable
    if (embeddable) {
      const url = pageUrl(info.port, 'vscode')
      view.webview.html = renderFrame({
        pageUrl: url,
        lang: vscode.env.language,
        dockId: this.dockId,
        workspaceFolders: this.workspaceFolders(),
        mcp: Boolean(this.mcp)
      })
      // The dock's own bar hosts the editor-tools switch only in a build that
      // reports `mcpBridge`; an older build keeps the native view-title button.
      this.setDockShown(Boolean(result.meta?.mcpBridge))
      log(`dock -> ${url} (QuickDock ${result.meta?.version ?? '?'}, dock ${this.dockId})`)
      this.pushMcpState()
    } else {
      this.setDockShown(false)
      log(
        `dock: cannot show the dock on port ${info.port}: `
          + (result.ok ? 'the plugin does not advertise app-proxy' : result.failure + ' ' + result.detail)
      )
      const stale = Boolean(result.ok)
      view.webview.html = renderOffline({
        port: info.port,
        pageUrl: info.port > 0 ? pageUrl(info.port, 'browser') : 'http://127.0.0.1/quickdock',
        lead: stale
          ? translate('QuickDock is running, but this build cannot serve an IDE tab.')
          : result.failure === 'disabled'
            ? translate('The QuickDock listener is switched off.')
            : translate('Nothing answered at {0}.', 'http://127.0.0.1:' + info.port + '/quickdock'),
        reason: stale
          ? translate('the installed QuickDock does not advertise app-proxy (view=vscode)')
          : probeReason(result),
        detail: stale ? 'apiVersion ' + String(result.meta?.apiVersion ?? '?') : result.detail,
        detectedPort: detected?.port,
        detectedFile: detected?.file,
        detectedDiffers: detected !== undefined && detected.port !== info.port,
        disabled: result.failure === 'disabled',
        startable: !stale && (result.failure === 'refused' || result.failure === 'timeout' || result.failure === 'unreachable'),
        stale,
        hasLog: existsSync(hostLogFile()),
        stateDir: stateDir(),
        lang: vscode.env.language,
        t: translate
      })
    }
    this.applyStatus(result, info)
  }

  /** Re-render the view (or reveal it when there is none). */
  async reload(): Promise<void> {
    if (!this.view) {
      await this.open()
      return
    }
    await this.load(this.view)
  }

  /**
   * A folder was opened or closed: the registrations change, and the dock page
   * carries the folder list in its URL, so it is re-rendered.
   */
  workspaceFoldersChanged(): void {
    if (this.view && this.renderedOk) void this.load(this.view)
    void this.syncMcp('folders')
  }

  /* ------------------------------- status -------------------------------- */

  /** Create, show or hide the status bar entry from the setting. */
  private syncStatusBar(): void {
    const wanted = vscode.workspace.getConfiguration('dshVsdock').get<boolean>('statusBar', true)
    if (wanted && !this.statusItem) {
      this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
      this.statusItem.command = 'dshVsdock.open'
      this.statusItem.name = translate('DSH Dock')
      this.statusItem.show()
    } else if (!wanted && this.statusItem) {
      this.statusItem.dispose()
      this.statusItem = undefined
    }
  }

  /** Probe in the background and paint the status bar. */
  async refreshStatus(force = false): Promise<void> {
    if ((!this.statusItem && !this.view) || this.probing) return
    this.probing = true
    try {
      const { info } = this.resolve()
      // The port can move under an open tab (DSH → Settings → QuickDock): a
      // frame bound to the old address is dead, so follow the move.
      if (this.view && this.renderedPort !== undefined && this.renderedPort !== info.port) {
        log(`port moved to ${info.port}; reloading the dock`)
        void this.load(this.view)
        return
      }
      const result = await this.probe(info.port, force)
      // Recover without a manual click once the listener is back.
      if (this.view && this.renderedOk === false && result.ok && supportsEmbeddedView(result.meta)) {
        log('listener is back; reloading the dock')
        void this.load(this.view)
        return
      }
      this.applyStatus(result, info)
    } finally {
      this.probing = false
    }
  }

  private applyStatus(result: ProbeResult, info: PortInfo): void {
    const item = this.statusItem
    if (!item) return
    const url = info.port > 0 ? pageUrl(info.port) : ''
    if (result.ok) {
      const heading = result.meta?.version
        ? translate('QuickDock {0} is listening.', result.meta.version)
        : translate('QuickDock is listening.')
      item.text = '$(browser) DSH Dock'
      item.color = undefined
      item.backgroundColor = undefined
      item.tooltip = new vscode.MarkdownString(
        [
          `**${heading}**`,
          '',
          `\`${url}\``,
          '',
          sourceNote(info),
          '',
          translate('Click to open the dock.')
        ].join('\n')
      )
      return
    }
    item.text = '$(circle-slash) DSH Dock'
    item.color = new vscode.ThemeColor('statusBarItem.warningForeground')
    item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground')
    item.tooltip = new vscode.MarkdownString(
      [
        `**${translate('QuickDock is not answering on port {0}', info.port)}**`,
        '',
        probeReason(result),
        '',
        sourceNote(info),
        '',
        translate('Click for details and the fix.')
      ].join('\n')
    )
  }

  /* ------------------------------ commands ------------------------------- */

  /** Open the shell page in the default browser, outside VS Code. */
  async openInBrowser(): Promise<void> {
    const { info } = this.resolve()
    if (!(info.port > 0)) {
      void vscode.window.showWarningMessage(translate('QuickDock\'s listener is switched off (port 0).'))
      return
    }
    // A tab is a first-party document, so it takes the browser view (trimmed
    // chrome, the app embedded directly - no proxy needed).
    const url = pageUrl(info.port, 'browser')
    log(`open in browser: ${url}`)
    const opened = await vscode.env.openExternal(vscode.Uri.parse(url))
    if (!opened) {
      void vscode.window.showWarningMessage(translate('Could not open {0} in the browser.', url))
      return
    }
    if (this.lastProbe && !this.lastProbe.ok) {
      const settings = translate('Connection settings')
      void vscode.window
        .showWarningMessage(
          translate('QuickDock is not answering on port {0}; the browser will show the same error.', info.port),
          settings
        )
        .then((choice) => {
          if (choice === settings) void this.openPortSettings()
        })
    }
  }

  /** Apply the port found in QuickDock's own configuration. */
  async useDetectedPort(): Promise<void> {
    const detected = detectQuickDockPort()
    if (!detected) {
      void vscode.window.showInformationMessage(
        translate('No QuickDock config.json was found at {0}.', configFile())
      )
      return
    }
    if (detected.port === 0) {
      const settings = translate('Connection settings')
      void vscode.window
        .showWarningMessage(
          translate(
            'QuickDock records port 0 in {0}, which turns its listener off. Choose a port in DSH → Settings → QuickDock → Connection first.',
            detected.file
          ),
          settings
        )
        .then((choice) => {
          if (choice === settings) void this.openPortSettings()
        })
      return
    }
    await vscode.workspace
      .getConfiguration('dshVsdock')
      .update('port', detected.port, vscode.ConfigurationTarget.Global)
    void vscode.window.showInformationMessage(
      translate('DSH Dock now uses port {0}, read from {1}.', detected.port, detected.file)
    )
  }

  /** Open the extension's port setting. */
  async openPortSettings(): Promise<void> {
    await vscode.commands.executeCommand('workbench.action.openSettings', '@id:dshVsdock.port')
  }

  /** Jump to one of this extension's settings, by its full id. */
  private async openSetting(id: string): Promise<void> {
    await vscode.commands.executeCommand('workbench.action.openSettings', '@id:' + id)
  }

  /** Reveal QuickDock's host log (the plugin writes it next to config.json). */
  async openLog(): Promise<void> {
    const file = hostLogFile()
    if (existsSync(file)) {
      await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: true })
      return
    }
    const dir = stateDir()
    const openFolder = translate('Open folder')
    const choice = await vscode.window.showInformationMessage(
      translate('QuickDock\'s host.log does not exist yet at {0}. Start DSH with the QuickDock plugin installed.', file),
      openFolder
    )
    if (choice === openFolder) await vscode.env.openExternal(vscode.Uri.file(dir))
  }

  /**
   * Review the active file against its last commit.
   *
   * The same editor the agent's `vscode_open_diff` tool opens, for the case where
   * the user wants the diff and the agent is not the one asking.
   */
  async openDiff(): Promise<void> {
    const editor = vscode.window.activeTextEditor
    if (!editor || editor.document.uri.scheme !== 'file') {
      void vscode.window.showInformationMessage(
        translate('Open a file in the editor to compare it with its last commit.')
      )
      return
    }
    const path = editor.document.uri.fsPath
    const result = await openReviewDiff({ path, title: 'HEAD ↔ ' + basename(path) })
    if (result.opened) return
    void vscode.window.showInformationMessage(
      translate('No diff for {0}: {1}', basename(path), result.reason ?? '')
    )
  }

  /**
   * The dock's conversation asked for a file: open it here.
   *
   * DSH's own preview would open inside the dock, which is the wrong window when
   * the dock is a VS Code tab; the client half of the dock forwards the click
   * instead (see QuickDock's `client.js`). A relative path is resolved against the
   * open folders, and a path that matches nothing is only logged - a click must
   * never raise a dialog.
   */
  private async openDockFile(path: string): Promise<void> {
    // QuickDock appends the clicked element's tag/class after a NUL so a click
    // that opens nothing still says what was clicked in the log.
    const [target, source] = path.split('\u0000')
    const detail = source ? ` [${source}]` : ''
    if (!target) {
      // A diagnostic probe, not a file: the dock reports what was clicked.
      log(`dock: click probe${detail}`)
      return
    }
    const folders = this.workspaceFolders()
    const candidates = isAbsolute(target) ? [target] : folders.map((folder) => join(folder, target))
    for (const candidate of candidates) {
      try {
        const stat = await vscode.workspace.fs.stat(vscode.Uri.file(candidate))
        if (!(stat.type & vscode.FileType.File)) continue
        await vscode.window.showTextDocument(vscode.Uri.file(candidate), { preview: true })
        log(`dock: opened ${candidate}${isAbsolute(target) ? '' : ' (resolved)'}${detail}`)
        return
      } catch (_) {
        // Try the next folder; a file may live in only one of several roots.
      }
    }
    log(`dock: no file matches ${target}${detail}${folders.length === 0 ? ' (no folder is open)' : ''}`)
  }

  /* -------------------------------- review -------------------------------- */

  /** Whether a change made outside the editor opens a diff. */
  private reviewEnabled(): boolean {
    return vscode.workspace.getConfiguration('dshVsdock').get<boolean>('reviewEdits', true)
  }

  /** Paths the user does not want reviewed, on top of the built-in list. */
  private reviewIgnorePatterns(): string[] {
    const value = vscode.workspace.getConfiguration('dshVsdock').get<unknown>('reviewIgnore', [])
    if (!Array.isArray(value)) return []
    return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
  }

  /** QuickDock's listener, which is where DSH's file writes are read from. */
  private dockPort(): number | undefined {
    const { info } = this.resolve()
    return isUsablePort(info.port) ? info.port : undefined
  }

  /** Drives the two `when` clauses on the view-title diff buttons. */
  private syncReviewContext(): void {
    void vscode.commands.executeCommand('setContext', 'dshVsdock.reviewOn', this.reviewEnabled())
  }

  /** The view-title button: review DSH's edits, and remember the choice. */
  async enableReview(): Promise<void> {
    await this.updateReviewSetting(true)
    this.syncReview()
    void vscode.window.showInformationMessage(
      translate('Automatic diffs are on: a file DSH changes or creates opens a review tab.')
    )
  }

  /** The view-title button: stop opening diffs, and remember the choice. */
  async disableReview(): Promise<void> {
    await this.updateReviewSetting(false)
    this.syncReview()
    void vscode.window.showInformationMessage(translate('Automatic diffs are off.'))
  }

  /** Persist the toggle where the setting already lives, else globally. */
  private async updateReviewSetting(value: boolean): Promise<void> {
    const config = vscode.workspace.getConfiguration('dshVsdock')
    const inspected = config.inspect<boolean>('reviewEdits')
    const target =
      inspected?.workspaceValue !== undefined
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global
    try {
      await config.update('reviewEdits', value, target)
    } catch (error) {
      log(`review: cannot persist dshVsdock.reviewEdits: ${String((error as Error)?.message ?? error)}`)
    }
  }

  /**
   * Start or stop the review watcher to match the setting.
   *
   * It only runs while the editor tools are on: with no pairing there is no
   * folder DSH may change, so watching would just cache files for nothing.
   */
  private syncReview(): void {
    const wanted = this.reviewEnabled() && this.mcpEnabled()
    if (!wanted) {
      this.review?.dispose()
      this.review = undefined
      return
    }
    if (this.review) return
    this.review = new EditReview({
      enabled: () => this.reviewEnabled(),
      pairedFolders: () => [...(this.mcp?.registered.keys() ?? [])],
      workspaceFolders: () => this.workspaceFolders(),
      ignorePatterns: () => this.reviewIgnorePatterns(),
      dockPort: () => this.dockPort(),
      log
    })
    this.review.start()
  }

  /* --------------------------------- mcp ---------------------------------- */

  /**
   * The dock's own title bar: flip the editor tools.
   *
   * The bar hosts the switch (html.ts relays the click), so a user who is looking
   * at the dock never has to reach for the VS Code view title; those menu entries
   * stay for the offline card, where the dock page cannot render.
   */
  async toggleMcp(): Promise<void> {
    if (this.mcp) await this.disableMcp()
    else await this.enableMcp()
  }

  /**
   * Put the active selection into the dock's composer as an `@path` reference.
   *
   * The extension owns the editor and the dock page owns the input machine, so
   * the message carries the file and the 1-based selection only.
   */
  async addToChat(): Promise<void> {
    const editor = vscode.window.activeTextEditor
    if (!editor) {
      void vscode.window.showInformationMessage('Open a file to add to the DSH conversation.')
      return
    }
    const view = this.view
    if (!view) {
      void vscode.window.showWarningMessage('Open the DSH Dock tool window first.')
      return
    }
    const selection = editor.selection
    await view.webview.postMessage({
      type: 'quickdock:add-to-chat',
      path: editor.document.uri.fsPath,
      line: selection.start.line + 1,
      endLine: selection.end.line + 1,
      column: selection.start.character + 1,
      endColumn: selection.end.character + 1
    })
  }

  /** Push the current tool state into the dock's title bar. */
  private pushMcpState(): void {
    const view = this.view
    if (!view) return
    void view.webview.postMessage({
      type: 'dshVsdock.mcp-state',
      on: Boolean(this.mcp),
      detail: this.mcpFailure
    })
  }

  /** Hand the editor-tools switch to the dock bar (or take it back). */
  private setDockShown(shown: boolean): void {
    void vscode.commands.executeCommand('setContext', 'dshVsdock.dockShown', shown)
  }

  /**
   * Start the editor MCP server and pair it with DSH through QuickDock.
   *
   * QuickDock owns the registration: it forwards the endpoint to DSH's
   * workspace-scoped MCP bridge, so the tools reach sessions inside the open
   * folders and nowhere else. The pairing is repeated on every beat, which is how
   * the tools come back after DSH restarts without the user doing anything.
   * @param announce report the outcome in a notification (the view-title button).
   */
  async startMcp(announce = false): Promise<void> {
    if (this.mcp || this.mcpStarting) return
    this.mcpStarting = true
    try {
      const version = String(this.context.extension.packageJSON.version ?? '0.0.0')
      const token = await this.mcpToken()
      const handle = await this.startEditorServer(token, version)
      const timer = setInterval(() => void this.syncMcp('heartbeat'), MCP_SYNC_MS)
      this.mcp = { handle, timer, token, registered: new Map() }
      this.mcpFailure = ''
      this.setMcpContext(true)
      this.syncReview()
      await this.syncMcp('start', announce)
      if (announce && this.mcp) {
        void vscode.window.showInformationMessage(translate('MCP server listening on {0}.', handle.url))
      }
    } catch (error) {
      const detail = String((error as Error)?.message ?? error)
      log(`mcp: cannot start: ${detail}`)
      void vscode.window.showErrorMessage(translate('Could not start the MCP server: {0}', detail))
    } finally {
      this.mcpStarting = false
      this.pushMcpState()
    }
  }

  /**
   * Bind the editor server to the preferred port, falling back to a free one.
   *
   * `dshVsdock.mcpPort` is only a preference: a second editor window (or any
   * other listener) may already hold it, and the pairing carries the real URL, so
   * an ephemeral port costs nothing.
   */
  private async startEditorServer(token: string, version: string): Promise<McpServerHandle> {
    const port = this.mcpPort()
    const tools = editorTools(log, { write: this.mcpWriteTools() })
    try {
      return await startMcpServer({ port, token, version, tools, log })
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EADDRINUSE') throw error
      log(`mcp: port ${port} is already taken; this window uses a free port instead`)
      return startMcpServer({ port: 0, token, version, tools, log })
    }
  }

  /**
   * Reconcile DSH with the editor: register the open folders that are missing,
   * unregister folders the user closed, drop stale endpoints.
   * @param reason what triggered the sync (logging and the waiting budget).
   * @param announce show a warning when QuickDock refuses the tools.
   */
  async syncMcp(reason: string, announce = false): Promise<void> {
    const state = this.mcp
    if (!state || this.mcpSyncing || !this.mcpEnabled()) return
    this.mcpSyncing = true
    try {
      const { info } = this.resolve()
      const folders = this.workspaceFolders()
      // A new build of this extension publishes new tools, and DSH only sees them
      // when the mount is replaced: compare against what was registered last.
      const fingerprint = this.toolFingerprint()
      const toolsChanged = this.context.globalState.get<string>(TOOL_FINGERPRINT_KEY) !== fingerprint
      // A closed folder must stop contributing tools; the bridge would otherwise
      // keep mounting this editor's long-gone server for that directory.
      for (const folder of [...state.registered.keys()]) {
        if (folders.some((current) => samePath(current, folder))) continue
        const dropped = await unregisterEditorServer(info.port, folder, TOOL_NAMESPACE)
        state.registered.delete(folder)
        log(
          dropped.ok
            ? `mcp: unregistered ${folder} (folder closed)`
            : `mcp: cannot unregister ${folder}: ${dropped.error}`
        )
      }
      if (folders.length === 0) {
        this.noteMcp(`no workspace folder is open, so DSH has nothing to mount the editor tools on (${reason})`)
        return
      }
      for (const folder of folders) {
        const registration: Registration = {
          workspace: folder,
          url: state.handle.url,
          name: TOOL_NAMESPACE,
          headers: { Authorization: 'Bearer ' + state.token },
          // QuickDock keeps this and shows it in the dock's tool panel; the DSH
          // bridge never receives it (the Host strips it before forwarding).
          version: this.context.extension.packageJSON.version as string,
          tools: editorTools(() => {}, { write: this.mcpWriteTools() }).map((tool) => tool.name),
          // Only the first beat waits for running sessions; a heartbeat that
          // registered after a DSH restart reports `connecting` and moves on.
          waitMs: reason === 'start' ? 5_000 : 1_000
        }
        const listed = await listEditorServers(info.port, folder)
        if (!listed.ok) {
          // QuickDock not answering is not a refusal: the dock view already
          // explains that, and the next beat pairs as soon as it is back.
          this.noteMcp(
            `cannot ask QuickDock on port ${info.port} about ${folder}: `
              + (listed.status === 404 ? this.dockUpgradeHint(listed.error) : listed.error)
              + ` (${reason})`
          )
          return
        }
        if (!toolsChanged && !needsRegistration(listed.body, registration)) {
          state.registered.set(folder, registration.url)
          this.mcpFailure = ''
          continue
        }
        const answer = await registerEditorServer(info.port, registration)
        if (!answer.ok) {
          this.noteMcp(
            answer.status === 404
              ? this.dockUpgradeHint(answer.error)
              : `QuickDock did not accept the editor tools for ${folder}: ${answer.error} (${reason})`,
            announce
          )
          continue
        }
        state.registered.set(folder, registration.url)
        this.mcpFailure = ''
        if (toolsChanged) void this.context.globalState.update(TOOL_FINGERPRINT_KEY, fingerprint)
        const sessions = answer.body?.sessions ?? []
        const failed = sessions.filter((session) => session.state === 'failed')
        log(
          `mcp: paired ${folder} -> ${registration.url}`
            + ` (${sessions.length} session${sessions.length === 1 ? '' : 's'}`
            + `${failed.length ? ', ' + failed.length + ' failed' : ''}`
            + `${toolsChanged ? ', new tool set' : ''})`
        )
        for (const session of failed) {
          log(`mcp: session ${session.sessionId} could not connect: ${session.error ?? 'unknown error'}`)
        }
      }
    } finally {
      this.mcpSyncing = false
      // The bar's tooltip carries the outcome ("on", "on (…error)"), so it is
      // pushed after every beat, not only when the switch flips.
      this.pushMcpState()
    }
  }

  /** The absolute paths of the open workspace folders. */
  private workspaceFolders(): string[] {    return (vscode.workspace.workspaceFolders ?? [])
      .map((folder) => folder.uri.fsPath)
      .filter((path) => path.length > 0)
  }

  /**
   * A 404 from the dock means the plugin predates the pairing routes: the tools
   * cannot be registered until QuickDock is updated, and the port has nothing to
   * do with it.
   */
  private dockUpgradeHint(detail?: string): string {
    return 'this QuickDock build has no editor-tool pairing route, so update the dsh-quickdock plugin'
      + (detail ? ` (${detail})` : '')
  }

  /** A short digest of the tool set this build publishes. */
  private toolFingerprint(): string {
    const description = editorTools(() => {}, { write: this.mcpWriteTools() })
      .map((tool) => tool.name + '\u0000' + tool.description + '\u0000' + JSON.stringify(tool.inputSchema))
      .join('\u0001')
    return createHash('sha1').update(description).digest('hex').slice(0, 12)
  }

  /**
   * Log a pairing problem once per distinct message; a 20-second beat must not
   * fill the output channel with the same line.
   */
  private noteMcp(message: string, announce = false): void {
    if (message === this.mcpFailure) return
    this.mcpFailure = message
    log(`mcp: ${message}`)
    if (!announce) return
    void vscode.window.showWarningMessage(
      translate(
        'QuickDock did not accept the editor tools ({0}). DSH sessions will not see them; see the DSH Dock log.',
        message
      )
    )
  }

  /** Stop the server and withdraw its tools from DSH. */
  stopMcp(): void {
    const state = this.mcp
    if (!state) {
      this.setMcpContext(false)
      return
    }
    clearInterval(state.timer)
    const { info } = this.resolve()
    const folders = [...state.registered.keys()]
    state.registered.clear()
    this.mcp = undefined
    this.mcpFailure = ''
    void state.handle.close()
    for (const folder of folders) {
      void unregisterEditorServer(info.port, folder, TOOL_NAMESPACE).then((answer) => {
        if (!answer.ok) log(`mcp: cannot unregister ${folder}: ${answer.error}`)
      })
    }
    this.setMcpContext(false)
    this.pushMcpState()
    this.syncReview()
    log('mcp: stopped')
  }

  /** The view-title button: start the server and remember the choice. */
  async enableMcp(): Promise<void> {
    await this.updateMcpSetting(true)
    if (!this.mcp) {
      await this.startMcp(true)
    } else {
      void vscode.window.showInformationMessage(translate('MCP server listening on {0}.', this.mcp.handle.url))
    }
  }

  /** The view-title button: stop the server and remember the choice. */
  async disableMcp(): Promise<void> {
    await this.updateMcpSetting(false)
    this.stopMcp()
    void vscode.window.showInformationMessage(translate('MCP server stopped.'))
  }

  /** Persist the toggle where the setting already lives, else globally. */
  private async updateMcpSetting(value: boolean): Promise<void> {
    const config = vscode.workspace.getConfiguration('dshVsdock')
    const inspected = config.inspect<boolean>('mcp')
    const target =
      inspected?.workspaceValue !== undefined
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global
    try {
      await config.update('mcp', value, target)
    } catch (error) {
      log(`mcp: cannot persist dshVsdock.mcp: ${String((error as Error)?.message ?? error)}`)
    }
  }

  /** Drives the two `when` clauses on the view-title button. */
  private setMcpContext(on: boolean): void {
    void vscode.commands.executeCommand('setContext', 'dshVsdock.mcpOn', on)
  }

  private mcpEnabled(): boolean {
    return vscode.workspace.getConfiguration('dshVsdock').get<boolean>('mcp', false)
  }

  private mcpPort(): number {
    const value = vscode.workspace.getConfiguration('dshVsdock').get<number>('mcpPort', DEFAULT_MCP_PORT)
    return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535
      ? value
      : DEFAULT_MCP_PORT
  }

  /** Whether the tools that change state (edit, save, task, terminal, debug) exist. */
  private mcpWriteTools(): boolean {
    return vscode.workspace.getConfiguration('dshVsdock').get<boolean>('mcpWriteTools', false)
  }

  private async mcpToken(): Promise<string> {
    const key = 'dshVsdock.mcpToken'
    const existing = this.context.globalState.get<string>(key)
    if (typeof existing === 'string' && existing.length > 0 && existing.length <= 200) return existing
    const token = newToken()
    await this.context.globalState.update(key, token)
    return token
  }

  /* ------------------------------ settings ------------------------------- */

  /** React to a settings change without reloading the embedded app needlessly. */
  onConfigurationChanged(event: vscode.ConfigurationChangeEvent): void {
    if (event.affectsConfiguration('dshVsdock.reviewEdits')) {
      this.syncReview()
      this.syncReviewContext()
      return
    }
    if (event.affectsConfiguration('dshVsdock.mcpWriteTools') && this.mcp) {
      // The write tools are part of the server's tool list: bounce the server so
      // the new set is published and DSH remounts it.
      this.stopMcp()
      void this.startMcp()
      return
    }
    if (
      event.affectsConfiguration('dshVsdock.mcp') ||
      event.affectsConfiguration('dshVsdock.mcpPort')
    ) {
      // Idempotent: the button may already have started or stopped the server.
      if (this.mcpEnabled() && !this.mcp) void this.startMcp()
      if (!this.mcpEnabled() && this.mcp) this.stopMcp()
      this.syncReview()
      if (this.mcp && this.mcp.handle.port !== this.mcpPort()) {
        this.stopMcp()
        void this.startMcp()
      } else if (this.mcp) {
        void this.syncMcp('settings')
      }
      return
    }
    if (
      event.affectsConfiguration('dshVsdock.port') ||
      event.affectsConfiguration('dshVsdock.followQuickDockConfig')
    ) {
      const { info } = this.resolve()
      log(`settings changed: port=${info.port} (${info.source})`)
      this.lastProbeAt = 0
      // A moved QuickDock port moves every registration with it.
      void this.syncMcp('port')
      if (this.view) void this.load(this.view)
      else void this.refreshStatus(true)
      return
    }
    if (event.affectsConfiguration('dshVsdock.statusBar')) {
      this.syncStatusBar()
      void this.refreshStatus(true)
    }
  }
}

export function activate(context: vscode.ExtensionContext): void {
  channel = vscode.window.createOutputChannel('DSH Dock')
  context.subscriptions.push(channel)

  const controller = new DockController(context)
  context.subscriptions.push(
    controller,
    vscode.commands.registerCommand('dshVsdock.open', () => controller.open()),
    vscode.commands.registerCommand('dshVsdock.reload', () => controller.reload()),
    vscode.commands.registerCommand('dshVsdock.retry', () => controller.reload()),
    vscode.commands.registerCommand('dshVsdock.openInBrowser', () => controller.openInBrowser()),
    vscode.commands.registerCommand('dshVsdock.useDetectedPort', () => controller.useDetectedPort()),
    vscode.commands.registerCommand('dshVsdock.openPortSettings', () => controller.openPortSettings()),
    vscode.commands.registerCommand('dshVsdock.openLog', () => controller.openLog()),
    vscode.commands.registerCommand('dshVsdock.startDsh', () => controller.startDsh()),
    vscode.commands.registerCommand('dshVsdock.openDiff', () => controller.openDiff()),
    vscode.commands.registerCommand('dshVsdock.addToChat', () => controller.addToChat()),
    vscode.commands.registerCommand('dshVsdock.reviewEnable', () => controller.enableReview()),
    vscode.commands.registerCommand('dshVsdock.reviewDisable', () => controller.disableReview()),
    vscode.commands.registerCommand('dshVsdock.mcpPair', () => controller.enableMcp()),
    vscode.commands.registerCommand('dshVsdock.mcpUnpair', () => controller.disableMcp()),
    // The dock lives in the secondary side bar (a "view", like Copilot chat):
    // it can be dragged to the other side, and it never takes the editor area.
    vscode.window.registerWebviewViewProvider(
      VIEW_ID,
      { resolveWebviewView: (view) => controller.resolveWebviewView(view) },
      { webviewOptions: { retainContextWhenHidden: true } }
    ),
    vscode.workspace.onDidChangeConfiguration((event) => controller.onConfigurationChanged(event)),
    // Opening or closing a folder changes which directory DSH mounts the editor
    // tools for, and what the dock's title bar can warn about.
    vscode.workspace.onDidChangeWorkspaceFolders(() => controller.workspaceFoldersChanged())
  )

  const detected = detectQuickDockPort()
  log(
    `activated: default=${DEFAULT_PORT} detected=${detected ? detected.port + ' (' + detected.source + ' ' + detected.file + ')' : 'none'}`
  )
  controller.start()
}

export function deactivate(): void {
  // Everything is registered in `context.subscriptions`.
}
