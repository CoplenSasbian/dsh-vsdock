import assert from 'node:assert/strict'
import test from 'node:test'

import { page, t } from './helpers.mjs'

const { renderConnecting, renderFrame, renderOffline, escapeHtml } = page

test('escapeHtml neutralises markup in both text and attributes', () => {
  assert.equal(escapeHtml('<b>"x" & \'y\'</b>'), '&lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/b&gt;')
})

test('the frame page embeds the shell page behind a tight CSP', () => {
  const html = renderFrame({
    pageUrl: 'http://127.0.0.1:4791/quickdock?view=vscode',
    lang: 'zh-cn',
    dockId: 'vscode-abc123',
    workspaceFolders: ['C:\\work'],
    mcp: true
  })
  assert.match(html, /<iframe src="http:\/\/127\.0\.0\.1:4791\/quickdock\?view=vscode&amp;dock=vscode-abc123/)
  assert.match(html, /frame-src http:\/\/127\.0\.0\.1:4791;/)
  assert.match(html, /default-src 'none'/)
  assert.match(html, /style-src 'nonce-/)
  assert.match(html, /script-src 'nonce-/)
  assert.match(html, /allow="clipboard-read; clipboard-write"/)
  assert.match(html, /lang="zh-cn"/)
  assert.equal((html.match(/<script /g) ?? []).length, 1, 'one relay script, and nothing else')
})

test('the frame page tells the dock which folders and tool state to show', () => {
  const html = renderFrame({
    pageUrl: 'http://127.0.0.1:4791/quickdock?view=vscode',
    lang: 'en',
    dockId: 'vscode-1',
    workspaceFolders: ['C:\\work\\one', 'D:\\work\\two'],
    mcp: false
  })
  assert.match(html, /dock=vscode-1/)
  assert.match(html, /mcp=0/)
  assert.match(html, /workspace=C%3A%5Cwork%5Cone/)
  assert.match(html, /workspace=D%3A%5Cwork%5Ctwo/)
  // The relay is the only channel between the dock bar and the extension, and it
  // translates both message namespaces.
  assert.match(html, /quickdock:mcp-toggle/)
  assert.match(html, /dshVsdock\.mcp-toggle/)
  assert.match(html, /dshVsdock\.mcp-state/)
  assert.match(html, /type: 'quickdock:mcp-state'/, 'the host type is translated for the shell')
  assert.match(html, /acquireVsCodeApi/)
})

test('the frame page escapes a URL that carries a query string', () => {
  const html = renderFrame({
    pageUrl: 'http://127.0.0.1:4791/quickdock?view=frame&token=a"b',
    lang: 'en',
    dockId: 'vscode-1',
    workspaceFolders: [],
    mcp: false
  })
  assert.match(html, /view=frame&amp;token=a%22b/)
  assert.doesNotMatch(html, /<\/iframe><script>[^<]*"b/, 'no raw quote reaches the attribute')
})

test('the connecting page names the port', () => {
  const html = renderConnecting({ port: 4791, lang: 'en', t })
  assert.match(html, /127\.0\.0\.1:4791/)
  assert.match(html, /Connecting to QuickDock on 127\.0\.0\.1:4791/)
})

test('the offline page offers the fix for a refused connection', () => {
  const html = renderOffline({
    port: 47910,
    pageUrl: 'http://127.0.0.1:47910/quickdock?view=frame',
    lead: 'Nothing answered at http://127.0.0.1:47910/quickdock.',
    reason: 'connection refused — nothing is listening on that port',
    detail: 'ECONNREFUSED',
    detectedPort: 4791,
    detectedFile: 'C:/Local/dsh-quickdock/config.json',
    detectedDiffers: true,
    disabled: false,
    hasLog: true,
    stateDir: 'C:/Local/dsh-quickdock',
    lang: 'en',
    t
  })
  assert.match(html, /QuickDock is not answering/)
  assert.match(html, /Nothing answered at/)
  assert.match(html, /command:dshVsdock\.retry/)
  assert.match(html, /command:dshVsdock\.useDetectedPort/)
  assert.match(html, /Use port 4791/)
  assert.match(html, /command:dshVsdock\.openPortSettings/)
  assert.match(html, /command:dshVsdock\.openLog/)
  assert.match(html, /C:\/Local\/dsh-quickdock\/config\.json/)
  assert.match(html, /DSH → Settings → QuickDock → Connection/)
})

test('the offline page says the listener is off when port 0 is configured', () => {
  const html = renderOffline({
    port: 0,
    pageUrl: 'http://127.0.0.1/quickdock',
    lead: 'The QuickDock listener is switched off.',
    reason: 'the listener is switched off (port 0)',
    detail: '0',
    detectedPort: 0,
    detectedDiffers: true,
    disabled: true,
    hasLog: false,
    stateDir: 'C:/Local/dsh-quickdock',
    lang: 'en',
    t
  })
  assert.match(html, /The QuickDock listener is switched off\./)
  assert.match(html, /port 0/)
  // No "Use port 0" button: 0 is not a port.
  assert.doesNotMatch(html, /Use port 0/)
  assert.match(html, /command:dshVsdock\.openPortSettings/)
})

test('the offline page shows no detector button when the port already matches', () => {
  const html = renderOffline({
    port: 47910,
    pageUrl: 'http://127.0.0.1:47910/quickdock?view=frame',
    lead: 'Nothing answered at http://127.0.0.1:47910/quickdock.',
    reason: 'no answer in time',
    detail: 'timeout',
    detectedPort: 47910,
    detectedDiffers: false,
    disabled: false,
    hasLog: false,
    stateDir: 'C:/Local/dsh-quickdock',
    lang: 'en',
    t
  })
  assert.doesNotMatch(html, /useDetectedPort/)
  assert.match(html, /no config\.json|port 47910/)
})

test('the offline page escapes technical detail instead of rendering it', () => {
  const html = renderOffline({
    port: 4791,
    pageUrl: 'http://127.0.0.1:4791/quickdock?view=frame',
    lead: 'QuickDock is running.',
    reason: 'the connection failed',
    detail: '<img src=x onerror=alert(1)>',
    detectedDiffers: false,
    disabled: false,
    hasLog: false,
    stateDir: 'C:/Local',
    lang: 'en',
    t
  })
  assert.doesNotMatch(html, /<img src=x onerror=alert\(1\)>/)
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/)
})

test('the offline page explains a QuickDock build without app-proxy', () => {
  const html = renderOffline({
    port: 47910,
    pageUrl: 'http://127.0.0.1:47910/quickdock?view=browser',
    lead: 'QuickDock is running, but this build cannot serve an IDE tab.',
    reason: 'the installed QuickDock does not advertise app-proxy (view=vscode)',
    detail: 'apiVersion 1',
    detectedPort: 47910,
    detectedDiffers: false,
    disabled: false,
    stale: true,
    hasLog: false,
    stateDir: 'C:/Local',
    lang: 'en',
    t
  })
  assert.match(html, /app-proxy/)
  assert.match(html, /view=vscode/)
  assert.match(html, /Update the/)
  // Updating the plugin is the fix; no port action applies.
  assert.doesNotMatch(html, /Use port/)
})
