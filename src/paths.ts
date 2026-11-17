/**
 * Path helpers, shared by everything that has to decide whether two directories
 * are "the same place".
 *
 * The extension compares directories in three spots — the MCP pairing (which
 * folder a registration belongs to), the dock bar's workspace warning, and the
 * diff tool's git lookup — and all three must agree with the bridge's rule:
 * Windows compares case-insensitively, and both separators are equivalent.
 *
 * No `vscode` import: these rules are exercised by plain Node tests.
 */

/**
 * A path in the shape comparisons use: forward slashes, no trailing separator,
 * lower-cased on Windows. A bare root collapses to `c:` or `/`, which is enough
 * for both equality and containment (`c:` + `/work` is still a prefix match).
 * @param value path to normalise.
 * @param platform `process.platform` by default.
 */
export function comparisonPath(value: string, platform: NodeJS.Platform = process.platform): string {
  let text = value.replace(/\\/g, '/').replace(/\/+$/, '')
  if (text.length === 0) text = '/'
  return platform === 'win32' ? text.toLowerCase() : text
}

/**
 * Whether two paths name the same file or directory.
 * @param left one path.
 * @param right the other.
 * @param platform `process.platform` by default.
 */
export function samePath(left?: string, right?: string, platform: NodeJS.Platform = process.platform): boolean {
  if (!left || !right) return false
  return comparisonPath(left, platform) === comparisonPath(right, platform)
}

/**
 * Whether `path` is `directory` itself or sits below it.
 * @param path the path to test (a file or a directory).
 * @param directory the directory that should contain it.
 * @param platform `process.platform` by default.
 */
export function isInsideDirectory(path: string, directory: string, platform: NodeJS.Platform = process.platform): boolean {
  if (!path || !directory) return false
  const child = comparisonPath(path, platform)
  const parent = comparisonPath(directory, platform)
  if (child === parent) return true
  return child.startsWith(parent + '/')
}
