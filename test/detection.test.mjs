import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import { qd, fakeFs, readSiblingPluginFile } from './helpers.mjs'

test('the default port matches dsh-quickdock', () => {
  assert.equal(qd.DEFAULT_PORT, 47910)
  const constants = readSiblingPluginFile(join('host', 'constants.js'))
  if (constants) {
    const match = /DEFAULT_PORT\s*=\s*(\d+)/.exec(constants)
    assert.ok(match, 'host/constants.js must declare DEFAULT_PORT')
    assert.equal(
      Number(match[1]),
      qd.DEFAULT_PORT,
      'the extension default must match the plugin default'
    )
  }
})

test('stateDir follows the plugin', () => {
  assert.equal(qd.stateDir({ LOCALAPPDATA: 'C:/Local' }), join('C:/Local', 'dsh-quickdock'))
  assert.equal(qd.stateDir({ TEMP: 'C:/Temp' }), join('C:/Temp', 'dsh-quickdock'))
  assert.equal(
    qd.stateDir({ DSH_QUICKDOCK_STATE_DIR: ' D:/state ', LOCALAPPDATA: 'C:/Local' }),
    'D:/state'
  )
  assert.equal(qd.configFile({ LOCALAPPDATA: 'C:/Local' }), join('C:/Local', 'dsh-quickdock', 'config.json'))
  assert.equal(qd.hostLogFile({ LOCALAPPDATA: 'C:/Local' }), join('C:/Local', 'dsh-quickdock', 'host.log'))
})

test('readPortFromConfig accepts only real ports', () => {
  assert.equal(qd.readPortFromConfig('{"port":4791}'), 4791)
  assert.equal(qd.readPortFromConfig('{"port":"4791"}'), 4791)
  assert.equal(qd.readPortFromConfig('{"port":0}'), 0)
  assert.equal(qd.readPortFromConfig('{"port":65535}'), 65535)
  assert.equal(qd.readPortFromConfig('{"port":65536}'), undefined)
  assert.equal(qd.readPortFromConfig('{"port":-1}'), undefined)
  assert.equal(qd.readPortFromConfig('{"port":4791.5}'), undefined)
  assert.equal(qd.readPortFromConfig('{"port":"abc"}'), undefined)
  assert.equal(qd.readPortFromConfig('{"other":1}'), undefined)
  assert.equal(qd.readPortFromConfig('[]'), undefined)
  assert.equal(qd.readPortFromConfig('not json'), undefined)
})

test('readPortFromLog takes the last listening line', () => {
  const log = [
    '[t] host half loaded: version=0.6.0',
    '[t] server listening on http://127.0.0.1:47910',
    '[t] theme -> shell: dark (41 tokens)',
    '[t] server listening on http://127.0.0.1:4791'
  ].join('\n')
  assert.equal(qd.readPortFromLog(log), 4791)
  assert.equal(qd.readPortFromLog(''), undefined)
  assert.equal(qd.readPortFromLog('server listening on http://127.0.0.1:0'), 0)
})

test('detection prefers config.json, then host.log', () => {
  const env = { LOCALAPPDATA: 'C:/Local' }
  const config = join('C:/Local', 'dsh-quickdock', 'config.json')
  const log = join('C:/Local', 'dsh-quickdock', 'host.log')

  const both = fakeFs({
    [config]: '{"port":4791}',
    [log]: 'server listening on http://127.0.0.1:5000'
  })
  assert.deepEqual(qd.detectQuickDockPort(env, both), {
    port: 4791,
    source: 'config-file',
    file: config
  })

  const logOnly = fakeFs({ [log]: 'server listening on http://127.0.0.1:5000' })
  assert.deepEqual(qd.detectQuickDockPort(env, logOnly), { port: 5000, source: 'log', file: log })

  assert.equal(qd.detectQuickDockPort(env, fakeFs({})), undefined)
  // A config without a port falls through to the log.
  const noPort = fakeFs({ [config]: '{"other":1}', [log]: 'server listening on http://127.0.0.1:4791' })
  assert.equal(qd.detectQuickDockPort(env, noPort)?.port, 4791)
  // An unreadable file must not throw.
  const broken = {
    existsSync: () => true,
    readFileSync: () => {
      throw new Error('EACCES')
    }
  }
  assert.equal(qd.detectQuickDockPort(env, broken), undefined)
})

test('resolvePort precedence: setting, then QuickDock config, then default', () => {
  const detection = { port: 4791, source: 'config-file', file: 'C:/Local/dsh-quickdock/config.json' }
  assert.deepEqual(qd.resolvePort({ setting: 6000, follow: true, detected: detection }), {
    port: 6000,
    source: 'setting'
  })
  assert.deepEqual(qd.resolvePort({ follow: true, detected: detection }), {
    port: 4791,
    source: 'config-file',
    file: detection.file
  })
  assert.deepEqual(qd.resolvePort({ follow: false, detected: detection }), {
    port: 47910,
    source: 'default'
  })
  assert.deepEqual(qd.resolvePort({ follow: true, detected: { port: 0, source: 'config-file', file: 'x' } }), {
    port: 0,
    source: 'config-file',
    file: 'x'
  })
  // A setting of 0 is not a port; it must not win over detection.
  assert.equal(qd.resolvePort({ setting: 0, follow: true, detected: detection }).port, 4791)
})

test('URLs point at the shell page and the manifest', () => {
  assert.equal(qd.baseUrl(4791), 'http://127.0.0.1:4791')
  assert.equal(qd.pageUrl(4791), 'http://127.0.0.1:4791/quickdock?view=vscode')
  assert.equal(qd.pageUrl(4791, 'browser'), 'http://127.0.0.1:4791/quickdock?view=browser')
  assert.equal(qd.metaUrl(4791), 'http://127.0.0.1:4791/quickdock/api/meta')
})

test('port helpers reject non-ports', () => {
  assert.equal(qd.isValidPort(0), true)
  assert.equal(qd.isValidPort(65535), true)
  assert.equal(qd.isValidPort(65536), false)
  assert.equal(qd.isValidPort(-1), false)
  assert.equal(qd.isValidPort(1.5), false)
  assert.equal(qd.isValidPort('4791'), false)
  assert.equal(qd.isUsablePort(0), false)
  assert.equal(qd.isUsablePort(4791), true)
})
