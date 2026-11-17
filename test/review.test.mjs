import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import {
  decideReview,
  insideAny,
  isIgnoredReviewPath,
  matchesIgnorePattern,
  resolveReportedPath
} from '../out/review.js'

const BASE = {
  path: 'C:\\work\\proj\\src\\a.ts',
  folders: ['C:\\work\\proj'],
  paired: ['C:\\work\\proj'],
  dirty: false,
  hasBefore: true,
  bytes: 1200,
  maxBytes: 512 * 1024
}

test('review: generated, vendored and binary paths are skipped', () => {
  assert.equal(isIgnoredReviewPath('src/index.ts'), false)
  assert.equal(isIgnoredReviewPath('docs/readme.md'), false)
  assert.equal(isIgnoredReviewPath('node_modules/x/index.js'), true)
  assert.equal(isIgnoredReviewPath('out/extension.js'), true)
  assert.equal(isIgnoredReviewPath('dist/bundle.js'), true)
  assert.equal(isIgnoredReviewPath('.git/COMMIT_EDITMSG'), true)
  assert.equal(isIgnoredReviewPath('assets/logo.png'), true)
  assert.equal(isIgnoredReviewPath('src/app.min.js'), true)
  assert.equal(isIgnoredReviewPath(''), true)
})

test('review: build tools are skipped, their sources are not', () => {
  // What a Gradle / Maven / Kotlin / Android build writes next to the sources.
  assert.equal(isIgnoredReviewPath('.gradle/8.5/executionHistory/executionHistory.bin'), true)
  assert.equal(isIgnoredReviewPath('.gradle/configuration-cache/entry.properties'), true)
  assert.equal(isIgnoredReviewPath('build/tmp/compileJava/previous-compilation-data.bin'), true)
  assert.equal(isIgnoredReviewPath('app/build/outputs/apk/debug/app-debug.apk'), true)
  assert.equal(isIgnoredReviewPath('target/classes/com/example/App.class'), true)
  assert.equal(isIgnoredReviewPath('.kotlin/sessions/kotlin-compiler-1.salive'), true)
  assert.equal(isIgnoredReviewPath('local.properties'), true)
  assert.equal(isIgnoredReviewPath('gradle/libs.versions.toml'), false)
  assert.equal(isIgnoredReviewPath('app/src/main/java/com/example/App.kt'), false)
  assert.equal(isIgnoredReviewPath('buildSrc/src/main/kotlin/deps.kt'), false)
})

test('review: user globs skip what the built-in list does not know', () => {
  assert.equal(isIgnoredReviewPath('generated/api.ts', []), false)
  assert.equal(isIgnoredReviewPath('generated/api.ts', ['generated']), true)
  assert.equal(isIgnoredReviewPath('generated/api.ts', ['generated/**']), true)
  assert.equal(isIgnoredReviewPath('a/b/generated/api.ts', ['**/generated/**']), true)
  assert.equal(isIgnoredReviewPath('src/a.ts', ['generated']), false)
  // A pattern without a separator matches at any depth
  assert.equal(matchesIgnorePattern('logs/build.log', ['*.log']), true)
  assert.equal(matchesIgnorePattern('logs/build.log', ['logs/*.log']), true)
  assert.equal(matchesIgnorePattern('logs/build.log.txt', ['*.log']), false)
  assert.equal(matchesIgnorePattern('build/out/x.js', ['build/**']), true)
  assert.equal(matchesIgnorePattern('build/out/x.js', ['build/']), true)
  assert.equal(matchesIgnorePattern('src/x.js', ['?rc/x.js']), true)
  assert.equal(matchesIgnorePattern('a+b/x.js', ['a+b/x.js']), true)
  assert.equal(matchesIgnorePattern('src/x.js', ['']), false)
  assert.equal(matchesIgnorePattern('src/x.js', []), false)
})

test('review: a change DSH made between two states is reviewed', () => {
  assert.deepEqual(decideReview(BASE), { review: true })
})

test('review: needs a pairing, a covered folder and an earlier version', () => {
  assert.equal(decideReview({ ...BASE, paired: [] }).review, false)
  assert.equal(decideReview({ ...BASE, paired: ['C:\\other'] }).review, false)
  assert.equal(decideReview({ ...BASE, hasBefore: false }).review, false)
  assert.equal(decideReview({ ...BASE, dirty: true }).review, false)
  assert.equal(decideReview({ ...BASE, bytes: 2 * 1024 * 1024 }).review, false)
})

test('review: the reason says why nothing was shown', () => {
  const verdict = decideReview({ ...BASE, dirty: true })
  assert.equal(verdict.review, false)
  assert.match(verdict.reason, /unsaved/)
})

test('review: a reported path is resolved against the folder the dock edits', () => {
  assert.equal(resolveReportedPath('/work/proj/src/a.ts', ['/work/proj']), '/work/proj/src/a.ts')
  assert.equal(resolveReportedPath('src/a.ts', ['/work/proj']), join('/work/proj', 'src/a.ts'))
  assert.equal(resolveReportedPath('  ', ['/work/proj']), undefined)
  assert.equal(resolveReportedPath('src/a.ts', []), undefined)
  // A remote backend's URI is not something this editor can open.
  assert.equal(resolveReportedPath('ssh://host/work/a.ts', ['/work/proj']), undefined)
  assert.equal(resolveReportedPath('https://example.com/a.ts', ['/work/proj']), undefined)
  // A file URI is local after all.
  const local = join(process.cwd(), 'tmp', 'reported.ts')
  assert.equal(resolveReportedPath(pathToFileURL(local).href, []), local)
})

test('review: folder containment treats separators and case alike', () => {
  assert.equal(insideAny('C:\\Work\\Proj\\src\\a.ts', ['c:/work/proj']), true)
  assert.equal(insideAny('C:\\work\\proj2\\a.ts', ['C:\\work\\proj']), false)
  assert.equal(insideAny('C:\\work\\proj', ['C:\\work\\proj']), true)
  assert.equal(insideAny('C:\\work\\proj', []), false)
})
