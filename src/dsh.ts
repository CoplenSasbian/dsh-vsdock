/**
 * Starting DSH from the editor.
 *
 * When nothing answers on QuickDock's port, the extension can boot DSH in a
 * terminal instead of telling the user to do it by hand. Everything here is pure
 * so the command line and the profile list can be exercised by plain Node tests:
 * the terminal, the picker and the waiting loop live in `extension.ts`.
 */

import { join } from 'node:path'

/** Profile names the DSH launcher accepts (`dsh --profile <name>`). */
const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** The two filesystem calls the profile listing needs, injectable for tests. */
export interface FsLike {
  existsSync(path: string): boolean
  readdirSync(path: string): string[]
}

/** The command line to send to a terminal. */
export interface DshLaunch {
  /** `dsh`, or an absolute path when the PATH one is not the wanted one. */
  command: string
  /** Profile name; empty lets DSH pick its own default. */
  profile?: string
  /** Extra arguments, appended verbatim (e.g. `--port 8080`). */
  args?: string
  /** For deterministic tests. */
  platform?: NodeJS.Platform
}

/**
 * Quote one executable path for the terminal's shell.
 *
 * Only a path with spaces needs quoting; Windows gets double quotes (the `cmd`
 * convention) and POSIX single quotes, so a path like
 * `C:\Users\me\my tools\dsh.cmd` survives the shell.
 * @param command the executable (or a bare command name).
 * @param platform `process.platform` by default.
 * @returns the executable as the shell should see it.
 */
export function quoteExecutable(command: string, platform: NodeJS.Platform = process.platform): string {
  const text = command.trim()
  if (text.length === 0) return ''
  // Anything outside this set has a meaning to a shell, so it must be quoted.
  if (/^[\w@%+=:,./\\-]+$/.test(text)) return text
  if (platform === 'win32') return '"' + text.replace(/"/g, '""') + '"'
  return "'" + text.replace(/'/g, "'\\''") + "'"
}

/**
 * Whether a configured command is a path rather than a bare name.
 *
 * A path that does not exist is worth reporting before DSH is started; a name is
 * looked up by the shell, where failing is also visible in the terminal.
 * @param command configured command.
 */
export function looksLikePath(command: string): boolean {
  const text = command.trim()
  return /^[A-Za-z]:[\\/]/.test(text) || text.startsWith('\\\\') || text.startsWith('/')
}

/**
 * Build the line one terminal receives.
 * @param launch command, profile and extra arguments.
 * @returns the shell line.
 * @throws when the profile name would not survive the shell unchanged.
 */
export function dshCommandLine(launch: DshLaunch): string {
  const platform = launch.platform ?? process.platform
  const command = quoteExecutable(launch.command.length > 0 ? launch.command : 'dsh', platform)
  const parts = [command]
  const profile = String(launch.profile ?? '').trim()
  if (profile.length > 0) {
    if (!PROFILE_PATTERN.test(profile)) throw new Error(`invalid DSH profile name: ${profile}`)
    parts.push('--profile', profile)
  }
  const args = String(launch.args ?? '').trim()
  if (args.length > 0) parts.push(args)
  return parts.join(' ')
}

/**
 * Profile names under a DSH home directory, sorted.
 *
 * `dsh --profile <name>` boots `$DSH_HOME/profiles/<name>`, so the picker offers
 * exactly the directories that carry a `package.json` (the shared `node_modules`
 * and dot directories are not profiles).
 * @param homeDir the DSH home (usually `~/.dsh`).
 * @param fs filesystem access.
 * @returns profile names, possibly empty.
 */
export function listProfiles(homeDir: string, fs: FsLike): string[] {
  const profilesDir = join(homeDir, 'profiles')
  let entries: string[]
  try {
    entries = fs.readdirSync(profilesDir)
  } catch (_) {
    return []
  }
  return entries
    .filter((name) => name.length > 0 && !name.startsWith('.') && name !== 'node_modules')
    .filter((name) => {
      try {
        return fs.existsSync(join(profilesDir, name, 'package.json'))
      } catch (_) {
        return false
      }
    })
    .sort()
}
