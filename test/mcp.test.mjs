import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'

import mcp from '../out/mcp.js'

const TOKEN = 'test-token'

function send(handle, body, options = {}) {
  const headers = { 'content-type': 'application/json' }
  if (options.token !== false) headers.authorization = `Bearer ${options.token ?? TOKEN}`
  return fetch(handle.url, {
    method: options.method ?? 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  })
}

const echoTool = {
  name: 'echo',
  description: 'Echo the supplied value.',
  inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
  call: (args) => ({ echo: args.value ?? null })
}

test('mcp: initialize, list and call a tool', async () => {
  const handle = await mcp.startMcpServer({
    port: 0,
    token: TOKEN,
    version: '0.3.0',
    tools: [echoTool]
  })
  try {
    const initialize = await send(handle, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' }
      }
    })
    assert.equal(initialize.status, 200)
    assert.ok(initialize.headers.get('mcp-session-id'))
    const initialized = await initialize.json()
    assert.equal(initialized.result.protocolVersion, '2025-06-18')
    assert.equal(initialized.result.serverInfo.name, 'dsh-vsdock')
    assert.ok(initialized.result.capabilities.tools)

    const listed = await (await send(handle, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json()
    assert.deepEqual(
      listed.result.tools.map((tool) => tool.name),
      ['echo']
    )
    assert.equal(listed.result.tools[0].inputSchema.type, 'object')

    const called = await (
      await send(handle, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'echo', arguments: { value: 'hi' } }
      })
    ).json()
    assert.equal(called.result.content[0].type, 'text')
    assert.match(called.result.content[0].text, /hi/)
    assert.equal(called.result.isError, undefined)

    const unknown = await (
      await send(handle, {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'nope', arguments: {} }
      })
    ).json()
    assert.equal(unknown.error.code, -32602)

    const notification = await send(handle, { jsonrpc: '2.0', method: 'notifications/initialized' })
    assert.equal(notification.status, 202)

    const unauthorized = await send(handle, { jsonrpc: '2.0', id: 5, method: 'tools/list' }, { token: false })
    assert.equal(unauthorized.status, 401)

    const health = await fetch(handle.healthUrl, { headers: { authorization: `Bearer ${TOKEN}` } })
    assert.equal(health.status, 200)
    assert.deepEqual(await health.json(), { ok: true, version: '0.3.0', tools: 1 })

    const stream = await fetch(handle.url, { headers: { authorization: `Bearer ${TOKEN}` } })
    assert.equal(stream.status, 405)
  } finally {
    await handle.close()
  }
})

test('mcp: a failing tool is reported as a tool error, not a connection error', async () => {
  const handle = await mcp.startMcpServer({
    port: 0,
    token: TOKEN,
    version: '0.3.0',
    tools: [
      {
        name: 'boom',
        description: 'Always fails.',
        inputSchema: { type: 'object', properties: {} },
        call: () => {
          throw new Error('kaboom')
        }
      }
    ]
  })
  try {
    const response = await send(handle, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'boom', arguments: {} }
    })
    const body = await response.json()
    assert.equal(body.result.isError, true)
    assert.match(body.result.content[0].text, /kaboom/)
  } finally {
    await handle.close()
  }
})

/** A stand-in for QuickDock's listener: records requests, answers from a queue. */
async function fakeDock(answers) {
  const seen = []
  const queue = answers.slice()
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      seen.push({ method: req.method, url: req.url, body: text ? JSON.parse(text) : undefined })
      const answer = queue.length > 1 ? queue.shift() : queue[0]
      res.writeHead(answer?.status ?? 200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(answer?.body ?? { ok: true }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    port: address.port,
    seen,
    close: () => new Promise((resolve) => server.close(resolve))
  }
}

test('dock: list, register and unregister speak to QuickDock’s own listener', async () => {
  const dock = await fakeDock([
    { body: { ok: true, workspaces: [{ workspace: 'C:\\work', servers: [{ name: 'vscode', url: 'http://127.0.0.1:47920/mcp' }] }] } },
    {
      body: {
        ok: true,
        registered: { name: 'vscode', workspace: 'C:\\work' },
        replaced: false,
        sessions: [{ sessionId: 's-1', state: 'connected' }]
      }
    },
    { body: { ok: true, removed: ['vscode'] } }
  ])
  try {
    const registration = {
      workspace: 'C:\\work',
      url: 'http://127.0.0.1:47920/mcp',
      name: mcp.TOOL_NAMESPACE,
      headers: { Authorization: 'Bearer ' + TOKEN },
      waitMs: 0
    }

    const listed = await mcp.listEditorServers(dock.port, registration.workspace)
    assert.equal(listed.ok, true)
    assert.equal(mcp.findRegistration(listed.body, registration.workspace)?.name, 'vscode')
    assert.equal(mcp.needsRegistration(listed.body, registration), false)
    assert.equal(dock.seen[0].method, 'GET')
    assert.equal(dock.seen[0].url, '/quickdock/api/mcp-list?workspace=C%3A%5Cwork')

    assert.equal(mcp.needsRegistration({ ok: true, workspaces: [] }, registration), true)
    assert.equal(
      mcp.needsRegistration(
        { ok: true, workspaces: [{ workspace: 'C:\\work', servers: [{ name: 'vscode', url: 'http://127.0.0.1:1/mcp' }] }] },
        registration
      ),
      true,
      'another endpoint for the same folder is a re-registration'
    )

    const paired = await mcp.registerEditorServer(dock.port, registration)
    assert.equal(paired.ok, true)
    assert.deepEqual(paired.body.sessions, [{ sessionId: 's-1', state: 'connected' }])
    assert.equal(dock.seen[1].method, 'POST')
    assert.equal(dock.seen[1].url, '/quickdock/api/mcp-register')
    assert.deepEqual(dock.seen[1].body, registration)

    const dropped = await mcp.unregisterEditorServer(dock.port, registration.workspace)
    assert.equal(dropped.ok, true)
    assert.deepEqual(dropped.body.removed, ['vscode'])
    assert.equal(dock.seen[2].url, '/quickdock/api/mcp-unregister')
    assert.deepEqual(dock.seen[2].body, { workspace: 'C:\\work', name: 'vscode' })
  } finally {
    await dock.close()
  }
})

test('dock: a refusal keeps QuickDock’s message', async () => {
  const dock = await fakeDock([
    { status: 400, body: { ok: false, error: 'the workspace MCP bridge is disabled (mcpBridge: false)' } }
  ])
  try {
    const answer = await mcp.registerEditorServer(dock.port, {
      workspace: 'C:\\work',
      url: 'http://127.0.0.1:47920/mcp'
    })
    assert.equal(answer.ok, false)
    assert.equal(answer.status, 400)
    assert.match(answer.error, /mcpBridge: false/)
  } finally {
    await dock.close()
  }
})

test('dock: an unreachable QuickDock is an answer, not an exception', async () => {
  const listener = await fakeDock([{ body: { ok: true } }])
  const port = listener.port
  await listener.close()
  const answer = await mcp.listEditorServers(port, 'C:\\work')
  assert.equal(answer.ok, false)
  assert.equal(answer.status, 0)
  assert.ok(answer.error)
})

test('dock: the file-events feed carries DSH writes from a cursor', async () => {
  const dock = await fakeDock([
    {
      body: {
        ok: true,
        seq: 2,
        events: [
          { seq: 1, path: 'C:\\work\\src\\a.ts', kind: 'write', at: 1_700_000_000_000 },
          { seq: 2, path: 'C:\\work\\src\\gone.ts', kind: 'delete', at: 1_700_000_000_500 }
        ],
        dropped: 0
      }
    }
  ])
  try {
    const answer = await mcp.listFileEvents(dock.port, 0, 5_000)
    assert.equal(answer.ok, true)
    assert.equal(answer.body.seq, 2)
    assert.deepEqual(answer.body.events.map((event) => event.kind), ['write', 'delete'])
    assert.equal(dock.seen[0].method, 'GET')
    assert.equal(dock.seen[0].url, '/quickdock/api/file-events?since=0&wait=5000')
  } finally {
    await dock.close()
  }
})

test('dock: an older QuickDock without the feed answers 404, and that is an answer', async () => {
  const dock = await fakeDock([{ status: 404, body: { error: 'not found' } }])
  try {
    const answer = await mcp.listFileEvents(dock.port, 7, 0)
    assert.equal(answer.ok, false)
    assert.equal(answer.status, 404)
    assert.equal(dock.seen[0].url, '/quickdock/api/file-events?since=7&wait=0')
  } finally {
    await dock.close()
  }
})

test('pairing: the tool namespace and the default MCP port are the contract', () => {
  assert.equal(mcp.TOOL_NAMESPACE, 'vscode')
  assert.equal(mcp.DEFAULT_MCP_PORT, 47920)
  assert.equal(mcp.dockApiUrl(47910, 'mcp-list'), 'http://127.0.0.1:47910/quickdock/api/mcp-list')
})

test('pairing: paths compare the way each platform does', () => {
  assert.equal(mcp.samePath('C:\\Work\\Proj', 'c:\\work\\proj\\', 'win32'), true)
  assert.equal(mcp.samePath('/work/proj/', '/work/proj', 'linux'), true)
  assert.equal(mcp.samePath('/work/Proj', '/work/proj', 'linux'), false)
  assert.equal(mcp.samePath('', 'C:\\work', 'win32'), false)
  assert.equal(mcp.samePath(undefined, undefined, 'win32'), false)
})

test('mcp: a new token is long, printable and unique', () => {
  const first = mcp.newToken()
  const second = mcp.newToken()
  assert.match(first, /^[A-Za-z0-9_-]+$/)
  assert.ok(first.length >= 32)
  assert.notEqual(first, second)
})
