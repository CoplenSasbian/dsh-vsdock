import assert from 'node:assert/strict'
import test from 'node:test'

import { comparisonPath, isInsideDirectory, samePath } from '../out/paths.js'

test('paths: comparison strips separators and folds case on Windows only', () => {
  assert.equal(comparisonPath('C:\\Work\\Proj\\', 'win32'), 'c:/work/proj')
  assert.equal(comparisonPath('C:/Work/Proj', 'win32'), 'c:/work/proj')
  assert.equal(comparisonPath('/work/Proj/', 'linux'), '/work/Proj')
  assert.equal(comparisonPath('', 'win32'), '/')
})

test('paths: same path ignores case, separators and a trailing slash on Windows', () => {
  assert.equal(samePath('C:\\Work\\Proj', 'c:/work/proj/', 'win32'), true)
  assert.equal(samePath('/work/proj/', '/work/proj', 'linux'), true)
  assert.equal(samePath('/work/Proj', '/work/proj', 'linux'), false)
  assert.equal(samePath('', 'C:\\work', 'win32'), false)
  assert.equal(samePath(undefined, undefined, 'win32'), false)
})

test('paths: containment matches the bridge rule for registered folders', () => {
  // The directory itself and every descendant are inside it.
  assert.equal(isInsideDirectory('C:\\work\\proj', 'C:\\work\\proj', 'win32'), true)
  assert.equal(isInsideDirectory('C:\\work\\proj\\src\\a.ts', 'C:\\work\\proj', 'win32'), true)
  assert.equal(isInsideDirectory('c:/Work/Proj/src', 'C:\\work\\proj', 'win32'), true)
  // A sibling with the same prefix is not inside it.
  assert.equal(isInsideDirectory('C:\\work\\proj2', 'C:\\work\\proj', 'win32'), false)
  // A parent is not inside its own child (the tools need the session *below* it).
  assert.equal(isInsideDirectory('C:\\work', 'C:\\work\\proj', 'win32'), false)
  assert.equal(isInsideDirectory('/work/proj/a', '/work/proj', 'linux'), true)
  assert.equal(isInsideDirectory('', '/work/proj', 'linux'), false)
})

test('paths: a drive root still contains everything below it', () => {
  assert.equal(isInsideDirectory('C:\\work', 'C:\\', 'win32'), true)
  assert.equal(isInsideDirectory('C:\\work', 'C:', 'win32'), true)
})
