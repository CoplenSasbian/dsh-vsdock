/**
 * The two pages the webview can show.
 *
 * The dock itself is QuickDock's own shell page, loaded in an iframe: the page
 * already owns the compact layout, the session list and the DSH app, so this
 * module only frames it - plus the few lines of relay the dock's title bar needs
 * to reach the extension (see {@link renderFrame}). The other page is the part
 * QuickDock cannot render - "nothing is listening on that port" - with the
 * actions that fix it.
 *
 * The working page runs one inline script and no network calls; the offline page
 * uses VS Code command links (`command:...`) and stays scriptless.
 */

import { randomBytes } from 'node:crypto'

/** Translate one message; the extension passes `vscode.l10n.t`. */
export type Translate = (message: string, ...args: (string | number)[]) => string

/** Escape text for an HTML text node or a quoted attribute. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** The DeepSeek whale, the mark QuickDock's own window collapses into. */
const WHALE_VIEWBOX = '0 0 23.16 17.04'
const WHALE_PATH = 'M22.9168 1.43018C22.6713 1.31018 22.5658 1.53918 22.4223 1.65519C22.3733 1.69269 22.3318 1.74169 22.2903 1.78669C21.9317 2.1697 21.5127 2.42121 20.9657 2.39121C20.1657 2.34621 19.4827 2.59771 18.8787 3.20973C18.7502 2.45521 18.3236 2.0047 17.6746 1.71569C17.3351 1.56568 16.9916 1.41518 16.7536 1.08867C16.5876 0.856163 16.5421 0.597155 16.4591 0.341647C16.4061 0.187643 16.3536 0.0301382 16.1761 0.00363739C15.9836 -0.0263635 15.9081 0.135141 15.8326 0.270145C15.5306 0.822162 15.4136 1.43018 15.4251 2.0462C15.4516 3.43174 16.0366 4.53527 17.1991 5.3203C17.3311 5.4103 17.3651 5.5003 17.3236 5.63181C17.2441 5.90231 17.1501 6.16482 17.0671 6.43533C17.0141 6.60784 16.9351 6.64584 16.7501 6.57033C16.1121 6.30383 15.5611 5.90931 15.074 5.4328C14.2475 4.63328 13.5 3.75075 12.568 3.05973C12.349 2.89822 12.13 2.74822 11.9034 2.60522C10.9524 1.68169 12.028 0.923165 12.277 0.833162C12.5375 0.739159 12.3675 0.41615 11.5259 0.42015C10.6844 0.42365 9.91439 0.705658 8.93286 1.08117C8.78935 1.13767 8.63835 1.17867 8.48384 1.21267C7.59332 1.04367 6.66829 1.00617 5.70226 1.11517C3.88321 1.31768 2.43016 2.1777 1.36213 3.64575C0.0790928 5.4103 -0.222916 7.41536 0.146595 9.50642C0.535106 11.7105 1.66014 13.535 3.38869 14.9616C5.18125 16.4406 7.24581 17.1657 9.60138 17.0266C11.0319 16.9441 12.6245 16.7526 14.421 15.2321C14.874 15.4576 15.3496 15.5476 16.1381 15.6151C16.7456 15.6716 17.3306 15.5851 17.7836 15.4911C18.4931 15.3411 18.4441 14.6841 18.1876 14.5636C16.1081 13.595 16.5646 13.9891 16.1496 13.67C17.2061 12.42 18.8202 10.1979 19.3182 7.17235C19.3672 6.83834 19.4297 6.36783 19.4222 6.09732C19.4182 5.93231 19.4562 5.86831 19.6447 5.84931C20.1657 5.78931 20.6712 5.64681 21.1357 5.3913C22.4833 4.65528 23.0268 3.44624 23.1548 1.9972C23.1738 1.77569 23.1508 1.54668 22.9168 1.43018ZM11.1749 14.4736C9.15936 12.889 8.18184 12.3675 7.77832 12.39C7.40081 12.4125 7.46881 12.8445 7.55182 13.126C7.63882 13.404 7.75182 13.5955 7.91033 13.8396C8.01983 14.0011 8.09533 14.2411 7.80083 14.4216C7.15181 14.8231 6.02327 14.2866 5.97027 14.2601C4.65673 13.4865 3.5587 12.4655 2.78467 11.069C2.03715 9.72493 1.60314 8.28289 1.53164 6.74384C1.51264 6.37233 1.62214 6.24082 1.99215 6.17332C2.47916 6.08332 2.98118 6.06432 3.46769 6.13582C5.52476 6.43633 7.27581 7.35586 8.74385 8.8129C9.58188 9.64243 10.2159 10.634 10.8689 11.6025C11.5634 12.631 12.3105 13.611 13.262 14.4146C13.598 14.6961 13.866 14.9101 14.1225 15.0681C13.349 15.1546 12.058 15.1731 11.1749 14.4746L11.1749 14.4736ZM12.141 8.25988C12.141 8.09488 12.273 7.96338 12.439 7.96338C12.4765 7.96338 12.5105 7.97088 12.541 7.98188C12.5825 7.99688 12.6205 8.01938 12.6505 8.05338C12.7035 8.10588 12.7335 8.18088 12.7335 8.25988C12.7335 8.42489 12.6015 8.55639 12.4355 8.55639C12.2695 8.55639 12.141 8.42489 12.141 8.25988ZM15.1415 9.79893C14.949 9.87793 14.7565 9.94544 14.5715 9.95294C14.2845 9.96794 13.9715 9.85143 13.8015 9.70893C13.5375 9.48742 13.3485 9.36342 13.2695 8.97691C13.2355 8.8119 13.2545 8.55639 13.2845 8.40989C13.3525 8.09438 13.277 7.89187 13.0545 7.70787C12.8735 7.55786 12.643 7.51636 12.39 7.51636C12.2955 7.51636 12.209 7.47486 12.1445 7.44136C12.039 7.38886 11.9519 7.25735 12.035 7.09585C12.0615 7.04335 12.19 6.91584 12.22 6.89334C12.5635 6.69784 12.9595 6.76184 13.326 6.90834C13.6655 7.04735 13.9225 7.30236 14.292 7.66287C14.6695 8.09838 14.7375 8.21838 14.9525 8.54539C15.1225 8.8009 15.277 9.06341 15.3831 9.36392C15.4471 9.55142 15.3641 9.70493 15.1415 9.79893Z'

/** Shared look: VS Code theme variables, so the page matches the editor. */
function baseCss(): string {
  return `
  *, *::before, *::after { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    background: var(--vscode-editor-background, #1f1f1f);
    color: var(--vscode-foreground, #cccccc);
    font: 13px/1.5 var(--vscode-font-family, system-ui, sans-serif);
    -webkit-font-smoothing: antialiased;
    /* VS Code's webview stylesheet pads the body by 20px; the dock is full bleed. */
    padding: 0;
  }
  code, kbd {
    font-family: var(--vscode-editor-font-family, ui-monospace, monospace);
    font-size: .92em;
    background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.17));
    border-radius: 4px;
    padding: 1px 5px;
    white-space: nowrap;
  }
  a { color: var(--vscode-textLink-foreground, #3794ff); text-decoration: none; }
  a:hover { text-decoration: underline; }
  a:focus-visible { outline: 1px solid var(--vscode-focusBorder, #007fd4); outline-offset: 2px; }
  `
}

/**
 * The working page: QuickDock's shell page, full bleed.
 *
 * The shell's own title bar carries the editor-tools switch and the workspace
 * warning, but it is served by QuickDock on another origin, so the two ends talk
 * through this page: a click in the bar arrives here as `quickdock:mcp-toggle`
 * and is relayed to the extension, and the extension's `dshVsdock.mcp-state`
 * goes the other way. Nothing else runs in the webview.
 */
export function renderFrame(input: {
  /** Shell page URL, already carrying `?view=vscode`. */
  pageUrl: string
  lang: string
  /** Stable per-window dock id, so QuickDock keeps one context for this editor. */
  dockId: string
  /** Absolute folders whose sessions may mount this editor's tools. */
  workspaceFolders: string[]
  /** Whether the editor tools are on right now (the bar renders the switch). */
  mcp: boolean
}): string {
  const nonce = randomBytes(16).toString('base64')
  // `mcp` is both "this client owns the switch" and its initial state; the bar
  // reads `workspace` to warn when the session it shows works somewhere else.
  const shellUrl = new URL(input.pageUrl)
  shellUrl.searchParams.set('dock', input.dockId)
  shellUrl.searchParams.set('mcp', input.mcp ? '1' : '0')
  shellUrl.searchParams.delete('workspace')
  for (const folder of input.workspaceFolders) shellUrl.searchParams.append('workspace', folder)
  const src = escapeHtml(shellUrl.toString())
  const frameSource = shellUrl.origin
  return `<!DOCTYPE html>
<html lang="${escapeHtml(input.lang)}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; frame-src ${frameSource};">
<title>QuickDock</title>
<style nonce="${nonce}">
  ${baseCss()}
  iframe {
    display: block; width: 100%; height: 100%; border: 0;
    background: var(--vscode-editor-background, #1f1f1f);
    color-scheme: normal;
  }
</style>
</head>
<body>
<iframe src="${src}" title="QuickDock" allow="clipboard-read; clipboard-write"></iframe>
<script nonce="${nonce}">
(function () {
  var vscode = acquireVsCodeApi();
  var frame = document.querySelector('iframe');
  var origin = '';
  try { origin = frame ? new URL(frame.src).origin : '' } catch (error) { origin = '' }
  if (!frame || !origin) return;
  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || typeof data !== 'object') return;
    // The shell page is the only document allowed to drive us, and its origin is
    // the one in the iframe URL. Comparing event.source here is unreliable for
    // a cross-origin child inside a webview (it can be null), so the origin -
    // which cannot be forged for a postMessage - is the check.
    if (event.origin === origin) {
      // From the dock's title bar: flip the editor tools.
      if (data.type === 'quickdock:mcp-toggle') {
        vscode.postMessage({ type: 'dshVsdock.mcp-toggle' });
        return;
      }
      // From the dock's conversation: a clicked file belongs in this editor, not
      // in the dock's own preview panel.
      if (data.type === 'quickdock:open-file' && typeof data.path === 'string' && data.path) {
        vscode.postMessage({ type: 'dshVsdock.open-file', path: data.path });
      }
      return;
    }
    // From the extension host: the state the bar should show. The namespaces
    // differ on purpose - "dshVsdock." is this extension, "quickdock:" is the
    // shell's own contract - so the type is translated here, not forwarded.
    if (data.type === 'dshVsdock.mcp-state') {
      var state = { type: 'quickdock:mcp-state', on: Boolean(data.on), detail: data.detail };
      try { frame.contentWindow.postMessage(state, origin) } catch (error) { /* frame gone */ }
    }
  });
})();
</script>
</body>
</html>`
}

/** Shown while the probe runs, which is normally under a second. */
export function renderConnecting(input: { port: number; lang: string; t: Translate }): string {
  const nonce = randomBytes(16).toString('base64')
  const { t } = input
  return `<!DOCTYPE html>
<html lang="${escapeHtml(input.lang)}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}';">
<title>QuickDock</title>
<style nonce="${nonce}">
  ${baseCss()}
  body { display: flex; align-items: center; justify-content: center; }
  main { display: flex; flex-direction: column; align-items: center; gap: 14px; padding: 24px; text-align: center; }
  .spin {
    width: 22px; height: 22px; border-radius: 50%;
    border: 2px solid var(--vscode-descriptionForeground, #9d9d9d);
    border-top-color: transparent; animation: turn .8s linear infinite;
  }
  @keyframes turn { to { transform: rotate(360deg); } }
  p { margin: 0; color: var(--vscode-descriptionForeground, #9d9d9d); }
  .address { color: var(--vscode-foreground, #cccccc); }
</style>
</head>
<body>
<main>
  <div class="spin" role="status" aria-label="${escapeHtml(t('Connecting'))}"></div>
  <p class="address">${escapeHtml(t('Connecting to QuickDock on 127.0.0.1:{0}…', input.port))}</p>
  <p>${escapeHtml(t('This takes a moment while DSH is starting.'))}</p>
</main>
</body>
</html>`
}

/** Everything the offline page shows, already translated where needed. */
export interface OfflineModel {
  port: number
  pageUrl: string
  /** One sentence under the heading: what is wrong, in words. */
  lead: string
  /** Why the probe failed, in words. */
  reason: string
  /** Technical detail (error code, HTTP status), shown small. */
  detail: string
  /** The port found in QuickDock's own configuration, when there is one. */
  detectedPort?: number
  /** File the detected port was read from. */
  detectedFile?: string
  /** True when the detected port differs from the one in use. */
  detectedDiffers: boolean
  /** The plugin records port 0: the listener is deliberately off. */
  disabled: boolean
  /** The QuickDock build predates `view=vscode`; nothing here can be fixed by a port. */
  stale?: boolean
  /** Whether starting DSH from the editor makes sense here (not when port is 0). */
  startable?: boolean
  /** Whether `host.log` exists, so "open the log" is worth offering. */
  hasLog: boolean
  stateDir: string
  lang: string
  t: Translate
}

/** A short label/value row. */
function fact(label: string, value: string): string {
  return `<div class="fact"><span class="fact-label">${escapeHtml(label)}</span><span class="fact-value">${value}</span></div>`
}

/** Shown when the listener does not answer as QuickDock. */
export function renderOffline(input: OfflineModel): string {
  const nonce = randomBytes(16).toString('base64')
  const { t } = input
  const address = escapeHtml(input.pageUrl)
  const current = input.port > 0 ? escapeHtml('127.0.0.1:' + input.port) : escapeHtml(t('off'))

  // When nothing is listening at all, the missing piece is DSH itself: starting it
  // is the primary action, and retrying is what follows it.
  const actions: string[] = input.startable
    ? [
        `<a class="btn primary" role="button" href="command:dshVsdock.startDsh">${escapeHtml(t('Start DSH'))}</a>`,
        `<a class="btn" role="button" href="command:dshVsdock.retry">${escapeHtml(t('Retry'))}</a>`
      ]
    : [`<a class="btn primary" role="button" href="command:dshVsdock.retry">${escapeHtml(t('Retry'))}</a>`]
  if (!input.stale && input.detectedDiffers && input.detectedPort !== undefined && input.detectedPort > 0) {
    actions.push(
      `<a class="btn" role="button" href="command:dshVsdock.useDetectedPort">${escapeHtml(
        t('Use port {0}', input.detectedPort)
      )}</a>`
    )
  }
  actions.push(
    `<a class="btn" role="button" href="command:dshVsdock.openPortSettings">${escapeHtml(t('Connection settings'))}</a>`
  )
  if (input.hasLog) {
    actions.push(
      `<a class="btn ghost" role="button" href="command:dshVsdock.openLog">${escapeHtml(t('Open the QuickDock log'))}</a>`
    )
  }

  const facts = [
    fact(t('Address'), `<code>${address}</code>`),
    fact(t('Reason'), `${escapeHtml(input.reason)} <span class="detail">${escapeHtml(input.detail)}</span>`)
  ]
  if (input.detectedPort !== undefined) {
    const where = input.detectedFile ? escapeHtml(input.detectedFile) : ''
    facts.push(
      fact(
        t('QuickDock config'),
        `${escapeHtml(t('port {0}', input.detectedPort))}${where ? ` <span class="detail">${where}</span>` : ''}`
      )
    )
  } else {
    facts.push(fact(t('QuickDock config'), escapeHtml(t('no config.json found under {0}', input.stateDir))))
  }

  const steps = input.disabled
    ? [
        t('QuickDock records <code>port 0</code> in its configuration, which turns the listener off.'),
        t('Give it a real port in <b>DSH → Settings → QuickDock → Connection</b> (the default is <code>47910</code>), then press <b>Apply and restart</b>.'),
        t('Use the same port here: click <b>Connection settings</b> or run <b>DSH Dock: Use Port Detected from QuickDock</b>.')
      ]
    : input.stale
      ? [
          t('This tab needs QuickDock\'s <b>app-proxy</b> capability (<code>view=vscode</code>).'),
          t('Update the <b>dsh-quickdock</b> plugin in DSH, then press <b>Retry</b>; the port stays the same.')
        ]
      : [
          t('Start the DSH desktop app with the <b>dsh-quickdock</b> plugin installed. The listener starts with DSH.'),
          t('Check the port in <b>DSH → Settings → QuickDock → Connection</b>. It must match the port used here ({0}).', current || t('off')),
          t('If you moved it there, mirror it here: the <b>dshVsdock.port</b> setting, or one click on <b>Use port {0}</b>.', input.detectedPort ?? input.port)
        ]

  return `<!DOCTYPE html>
<html lang="${escapeHtml(input.lang)}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; img-src data:;">
<title>QuickDock</title>
<style nonce="${nonce}">
  ${baseCss()}
  body { overflow: auto; }
  .wrap { min-height: 100%; display: flex; align-items: center; justify-content: center; padding: 32px 20px; }
  .card { width: 100%; max-width: 560px; }
  .mark { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
  .mark svg { width: 42px; height: 31px; color: var(--vscode-textLink-foreground, #3794ff); }
  .mark .name { font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: var(--vscode-descriptionForeground, #9d9d9d); }
  h1 { font-size: 19px; font-weight: 600; margin: 0 0 6px; }
  .lead { margin: 0 0 18px; color: var(--vscode-descriptionForeground, #9d9d9d); }
  .facts { display: flex; flex-direction: column; gap: 1px; margin-bottom: 20px; border-radius: 6px; overflow: hidden; }
  .fact { display: flex; gap: 12px; padding: 8px 10px; background: var(--vscode-editorWidget-background, rgba(128,128,128,.09)); }
  .fact-label { flex: 0 0 120px; color: var(--vscode-descriptionForeground, #9d9d9d); }
  .fact-value { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
  .detail { color: var(--vscode-descriptionForeground, #9d9d9d); font-size: .92em; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 18px; }
  .btn {
    display: inline-flex; align-items: center; height: 26px; padding: 0 12px;
    border-radius: 4px; font-size: 12px; cursor: pointer;
    background: var(--vscode-button-secondaryBackground, #3a3d41);
    color: var(--vscode-button-secondaryForeground, #ffffff);
    border: 1px solid transparent;
  }
  .btn:hover { text-decoration: none; background: var(--vscode-button-secondaryHoverBackground, #45494e); }
  .btn.primary { background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #ffffff); }
  .btn.primary:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
  .btn.ghost { background: transparent; color: var(--vscode-textLink-foreground, #3794ff); border-color: var(--vscode-panel-border, rgba(128,128,128,.35)); }
  .btn.ghost:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.12)); }
  ol { margin: 0 0 4px; padding-left: 20px; color: var(--vscode-foreground, #cccccc); }
  ol li { margin: 6px 0; }
  .foot { margin-top: 22px; color: var(--vscode-descriptionForeground, #9d9d9d); font-size: 11.5px; }
  .foot code { font-size: 11px; }
</style>
</head>
<body>
<div class="wrap">
  <main class="card">
    <div class="mark">
      <svg viewBox="${WHALE_VIEWBOX}" fill="none" aria-hidden="true"><path d="${WHALE_PATH}" fill="currentColor"></path></svg>
      <span class="name">${escapeHtml(t('DSH Dock'))}</span>
    </div>
    <h1>${escapeHtml(t('QuickDock is not answering'))}</h1>
    <p class="lead">${escapeHtml(input.lead)}</p>
    <div class="facts">
      ${facts.join('\n      ')}
    </div>
    <ol>
      ${steps.map((step) => `<li>${step}</li>`).join('\n      ')}
    </ol>
    <div class="actions">
      ${actions.join('\n      ')}
    </div>
    <p class="foot">
      ${escapeHtml(t('The dock is a window onto QuickDock’s shell page; this extension never starts DSH itself.'))}<br>
      <code>${escapeHtml(input.pageUrl)}</code>
    </p>
  </main>
</div>
</body>
</html>`
}
