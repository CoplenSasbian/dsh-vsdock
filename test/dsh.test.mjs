import assert from 'node:assert/strict'
import test from 'node:test'

import { dshCommandLine, listProfiles, looksLikePath, quoteExecutable } from '../out/dsh.js'

test('dsh: the default launch is the bare command', () => {
  assert.equal(dshCommandLine({ command: 'dsh', platform: 'win32' }), 'dsh')
  assert.equal(dshCommandLine({ command: 'dsh', platform: 'linux' }), 'dsh')
})

test('dsh: an absolute path with spaces survives the shell', () => {
  const line = dshCommandLine({
    command: 'C:\\Program Files\\DSH\\dsh.cmd',
    platform: 'win32'
  })
  assert.equal(line, '"C:\\Program Files\\DSH\\dsh.cmd"')
})

test('dsh: a profile is passed as the launcher flag', () => {
  assert.equal(
    dshCommandLine({ command: 'dsh', profile: 'desktop', platform: 'win32' }),
    'dsh --profile desktop'
  )
  assert.equal(
    dshCommandLine({ command: 'dsh', profile: '  web  ', platform: 'win32' }),
    'dsh --profile web'
  )
  assert.equal(dshCommandLine({ command: 'dsh', profile: '', platform: 'win32' }), 'dsh')
})

test('dsh: a profile name that would break the shell is refused', () => {
  assert.throws(() => dshCommandLine({ command: 'dsh', profile: 'a b' }), /invalid DSH profile/)
  assert.throws(() => dshCommandLine({ command: 'dsh', profile: 'x&calc' }), /invalid DSH profile/)
})

test('dsh: extra arguments are appended verbatim', () => {
  assert.equal(
    dshCommandLine({ command: 'dsh', profile: 'web', args: '--port 8080 --verbose', platform: 'win32' }),
    'dsh --profile web --port 8080 --verbose'
  )
})

test('dsh: POSIX quoting keeps a single quote in the path', () => {
  assert.equal(quoteExecutable("/opt/my tools/dsh", 'linux'), "'/opt/my tools/dsh'")
  assert.equal(quoteExecutable("/opt/it's/dsh", 'linux'), "'/opt/it'\\''s/dsh'")
  assert.equal(quoteExecutable('dsh', 'linux'), 'dsh')
})

test('dsh: a configured command is only treated as a path when it looks like one', () => {
  assert.equal(looksLikePath('C:\\tools\\dsh.cmd'), true)
  assert.equal(looksLikePath('\\\\server\\share\\dsh.exe'), true)
  assert.equal(looksLikePath('/usr/local/bin/dsh'), true)
  assert.equal(looksLikePath('dsh'), false)
  assert.equal(looksLikePath('dsh-next'), false)
})

/** A fake profile tree: `{ 'profiles/name/package.json': '' }`. */
function fakeFs(files) {
  return {
    existsSync: (path) => Object.prototype.hasOwnProperty.call(files, path.replace(/\\/g, '/')),
    readdirSync: (dir) => {
      const prefix = dir.replace(/\\/g, '/') + '/'
      const names = new Set()
      for (const path of Object.keys(files)) {
        if (!path.startsWith(prefix)) continue
        const rest = path.slice(prefix.length)
        const name = rest.split('/')[0]
        if (name.length > 0) names.add(name)
      }
      return [...names]
    }
  }
}

test('dsh: profiles are the directories that carry a package.json', () => {
  const fs = fakeFs({
    '/home/.dsh/profiles/desktop/package.json': '',
    '/home/.dsh/profiles/web/package.json': '',
    '/home/.dsh/profiles/node_modules/x/package.json': '',
    '/home/.dsh/profiles/.cache/x': '',
    '/home/.dsh/profiles/empty/readme.md': ''
  })
  assert.deepEqual(listProfiles('/home/.dsh', fs), ['desktop', 'web'])
})

test('dsh: a missing profiles directory is not an error', () => {
  const fs = fakeFs({})
  assert.deepEqual(listProfiles('/home/.dsh', fs), [])
})
