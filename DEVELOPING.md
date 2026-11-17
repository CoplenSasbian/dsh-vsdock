# Developing DSH Dock

Everything needed to build, test, package and reason about this extension. If you
just want to use it, read [README.md](README.md) instead.

## Setup

```bash
npm install
npm run compile   # tsc → out/
npm test          # node --test over test/*.test.mjs
npm run check     # tsc --noEmit + translation/manifest parity
npm run verify    # both
npm run watch     # tsc in watch mode
```

`npm run test:inline` runs the same tests without the runner's per-file child
processes. Use it where spawning them is refused (a sandboxed agent session, a
hardened CI): `node --test` alone dies with `spawn EPERM` there.

`F5` starts an Extension Development Host with the extension loaded. The
extension's own log is the **DSH Dock** output channel; QuickDock's logs are
`%LOCALAPPDATA%\dsh-quickdock\host.log` and `dock.log`.

Packaging:

```bash
npm run package                     # → dsh-vsdock-<version>.vsix
code --install-extension dsh-vsdock-<version>.vsix
```

`npm run package` passes `--allow-missing-repository --no-rewrite-relative-links`
because `package.json` has no `repository` yet. Once this lives in a git repo,

- add `"repository": { "type": "git", "url": "https://github.com/<owner>/dsh-vsdock" }`,
- and you can drop both flags: relative links in README/CHANGELOG get rewritten to
  that repository, which is what the Marketplace page needs.

The README's hero image is `docs/dock.png` — a capture of the dock cropped to the
two title bars plus a new session (292 × 340), so it reads as a card instead of a
6:1 strip.

## Why `view=vscode`

DSH hands out its Web UI page through a one-shot `?token=` link and then
authenticates every later request with an httpOnly, `SameSite=Strict` cookie
(`dsh-auth-…`). A VS Code webview is a **third-party context** for `127.0.0.1`, so
that cookie is never stored or sent, and the app lands on *“dsh web authentication
required”* — the same URL opens fine in a browser tab only because there it is the
top-level document.

QuickDock solves that once, in its Host: `view=vscode` serves the app from an
ephemeral loopback origin owned by the plugin, which adds the launch token, keeps
the auth cookie and forwards API calls and WebSockets. The token and the cookie
never reach the webview. This extension is therefore a thin loader — and so is
every future IDE client, which uses the same one URL.

```
VS Code secondary side bar (webview view)
   └─ http://127.0.0.1:<port>/quickdock?view=vscode   ← QuickDock's IDE view
         └─ <app proxy>/?dock=1                        ← the DSH Web UI, same origin
```

## How the pieces fit

| File | Responsibility |
|---|---|
| `src/extension.ts` | activation, commands, status bar, the side-bar view, the pairing lifecycle |
| `src/mcp.ts` | the loopback MCP server, the QuickDock pairing client, the token |
| `src/tools.ts` | the editor tools (search, symbols, providers, diffs, and the optional write set) |
| `src/dsh.ts` | the `dsh` launch line and profile discovery (pure, unit-tested) |
| `src/diff.ts` | the review diff editor: read-only "before" document, git HEAD fallback |
| `src/review.ts`, `src/review-watcher.ts` | what counts as a reviewable write, and the feed reader that opens it |
| `src/paths.ts` | path comparison shared by the pairing, the dock bar and the diff tool |
| `src/quickdock.ts` | port resolution (setting → config.json → host.log → default), manifest probe, `view=` URLs |
| `src/html.ts` | the two webview pages (the dock frame, and the offline card) |

Everything the extension knows about DSH comes from QuickDock: the port from its
configuration, the contract from `GET /quickdock/api/meta` (`app-proxy`, and
`mcpBridge`), and the UI from the shell page it loads. The editor tools are
registered through that same listener, never against DSH's own port or profile.

## Port resolution

1. `dshVsdock.port`, when set explicitly (workspace or user settings);
2. otherwise the port in QuickDock's `config.json` (then `host.log`, then
   `DSH_QUICKDOCK_STATE_DIR`);
3. otherwise the plugin's default `47910`.

The status bar tooltip names the source. When the two drift, the offline card
offers **Use port \<detected\>** (which writes the setting in one click), and an
open view follows a moved port on its own.

## The editor-tools pairing

The extension posts its endpoint to QuickDock's listener
(`POST /quickdock/api/mcp-register`, with the open workspace folder and this
server's bearer token). QuickDock forwards that to DSH's **workspace-scoped MCP
bridge**, so only sessions whose working directory is inside the folder mount the
tools (`mcp__vscode__*`). The contract is in the QuickDock repository's
`MCP-BRIDGE.md`.

The pairing is a 20-second beat: it notices a DSH restart (registrations live in
memory), a moved QuickDock port, a new `mcpPort`, and folders you open or close. If
QuickDock is not running yet, the server keeps listening and the tools appear on the
first beat after it is.

After an upgrade the tool set can change. DSH keeps the tool list a session
connected with, so the extension stores a digest of what it last registered
(`dshVsdock.mcpTools` in global state) and re-pairs once when the build publishes
different tools — no DSH restart, no manual re-pair.

Two editor windows need no coordination: the pairing carries the real endpoint, so
a window whose `mcpPort` is taken falls back to a free port. Two windows on the
*same* folder share the namespace `vscode`; the last one to pair wins until the
other's next beat.

## Editor tools

`src/tools.ts` returns the read-only set, plus the write set when
`dshVsdock.mcpWriteTools` is on. Results are bounded (`MAX_*` constants) and carry
`truncated` flags so a model can ask for a narrower read.

`vscode_open_diff` uses a `TextDocumentContentProvider` on the `dsh-diff` scheme for
its left pane (32-entry ring buffer, 2 MB cap) and falls back to
`gitExtension.repository.diffWithHEAD` when no `original` is given.

A review is opened for exactly one thing: a write DSH reported. QuickDock serves
`GET /quickdock/api/file-events?since=&wait=` from the filesystem service's
`fs/observed` event, which fires when one of DSH's own file tools finishes a
mutation; a build tool or shell command writes to the disk directly and never
appears in it. `src/review-watcher.ts` long-polls that feed (15 s per poll, with
backoff and a one-line warning when the dock build is too old), resolves each
reported path against the folder this editor owns, and opens the diff as a preview
tab. Baseline text is cached at start and refreshed by the editor's own saves, so
the diff shows the user's version, not a stale one.

`src/review.ts` still holds the pure decisions and is unit-tested:
`resolveReportedPath`, `isIgnoredReviewPath` (generated folders, binaries, the
user's globs), `matchesIgnorePattern` and `decideReview`. None of them decides
what was the agent's - that is the reported write alone, which is why a build
cannot open a tab.

## Tests

`test/*.test.mjs` runs on plain Node with no VS Code: the pure modules (`dsh`,
`paths`, `review`, `quickdock` probing, `html` rendering, the MCP server's HTTP
surface) are tested directly.

```bash
npm test                     # 57 tests today
node --test test/dsh.test.mjs   # one file
```

`scripts/check-strings.mjs` keeps `package.nls*.json` and
`l10n/bundle.l10n.*.json` in parity with the code: every runtime string needs a
translation, every manifest key needs a user, no key may be dead.

## Traits worth keeping

- The view is a **viewer**: anything changed in it goes to the same DSH instance
  the desktop window uses.
- Loopback only, like QuickDock itself; there is no remote mode.
- The title bar carries no pin/collapse/close here: those are desktop-window
  actions, and QuickDock's `vscode` view does not render them.
