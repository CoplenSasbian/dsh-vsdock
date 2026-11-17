import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'

import { qd } from './helpers.mjs'

function listen(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

function close(server) {
  return new Promise((resolve) => {
    server.closeAllConnections?.()
    server.close(() => resolve())
  })
}

/** The manifest a current dsh-quickdock reports. */
function manifest(extra = {}) {
  return JSON.stringify({
    name: 'dsh-quickdock',
    apiVersion: 2,
    version: '0.7.0',
    capabilities: ['dock-target', 'handoff', 'app-proxy'],
    views: ['electron', 'vscode', 'browser'],
    ...extra
  })
}

test('a listening QuickDock answers with its manifest', async () => {
  const { server, port } = await listen((request, response) => {
    assert.equal(request.url, '/quickdock/api/meta')
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(manifest())
  })
  try {
    const result = await qd.probeQuickDock(port)
    assert.equal(result.ok, true)
    assert.equal(result.failure, undefined)
    assert.equal(result.meta.name, 'dsh-quickdock')
    assert.equal(result.meta.version, '0.7.0')
    assert.ok(result.elapsed >= 0)
  } finally {
    await close(server)
  }
})

test('another server on the port is reported as foreign', async () => {
  const { server, port } = await listen((request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ name: 'something-else' }))
  })
  try {
    const result = await qd.probeQuickDock(port)
    assert.equal(result.ok, false)
    assert.equal(result.failure, 'foreign')
    assert.equal(result.detail, 'something-else')
  } finally {
    await close(server)
  }
})

test('a wrong status or body is not mistaken for QuickDock', async () => {
  const { server, port } = await listen((request, response) => {
    if (request.url === '/quickdock/api/meta') {
      response.writeHead(500, { 'Content-Type': 'text/plain' })
      response.end('boom')
      return
    }
    response.writeHead(404)
    response.end()
  })
  try {
    const result = await qd.probeQuickDock(port)
    assert.equal(result.ok, false)
    assert.equal(result.failure, 'http')
    assert.equal(result.detail, 'HTTP 500')
  } finally {
    await close(server)
  }
})

test('invalid JSON is reported, not thrown', async () => {
  const { server, port } = await listen((request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end('<html>not json</html>')
  })
  try {
    const result = await qd.probeQuickDock(port)
    assert.equal(result.ok, false)
    assert.equal(result.failure, 'json')
  } finally {
    await close(server)
  }
})

test('a closed port is connection-refused', async () => {
  const { server, port } = await listen(() => {})
  await close(server)
  const result = await qd.probeQuickDock(port, 800)
  assert.equal(result.ok, false)
  assert.equal(result.failure, 'refused')
})

test('a silent listener times out', async () => {
  // Accept the request and never answer.
  const { server, port } = await listen(() => {})
  try {
    const result = await qd.probeQuickDock(port, 150)
    assert.equal(result.ok, false)
    assert.equal(result.failure, 'timeout')
  } finally {
    await close(server)
  }
})

test('port 0 and invalid ports are disabled', async () => {
  for (const port of [0, 70000, -1, 1.5]) {
    const result = await qd.probeQuickDock(port)
    assert.equal(result.ok, false)
    assert.equal(result.failure, 'disabled')
  }
})

test('only a build that advertises app-proxy can serve an IDE tab', () => {
  assert.equal(qd.supportsEmbeddedView(undefined), false)
  assert.equal(qd.supportsEmbeddedView({ name: 'dsh-quickdock' }), false)
  assert.equal(qd.supportsEmbeddedView({ name: 'dsh-quickdock', capabilities: ['dock-target', 'handoff'] }), false)
  assert.equal(qd.supportsEmbeddedView({ name: 'dsh-quickdock', capabilities: ['app-proxy'] }), true)
  assert.equal(
    qd.supportsEmbeddedView({
      name: 'dsh-quickdock',
      capabilities: ['dock-target', 'handoff', 'app-proxy']
    }),
    true
  )
})
