# Changelog

All notable changes to this project are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow SemVer.

## [Unreleased]

### Fixed

- **A file only opens a review diff when DSH itself wrote it.** The automatic
  review used to watch the whole folder for writes that did not come from the
  editor, so a Gradle or Maven build - the files it generated *and* the
  dependencies it downloaded - opened a diff per file. It now reads QuickDock's
  `file-events` feed instead: DSH's filesystem service reports every mutation its
  own file tools complete (`fs/observed`), and a build tool, formatter or dev
  server started from a shell writes to the disk directly, so it is never
  reported and never opens a tab. Writes DSH made *before* the extension started
  following are reported on the first poll as a `dropped` count instead of a
  burst of tabs, and the old folder watcher, its 350 ms settle window and its
  burst cap are gone with the guesswork they existed for.
- **A QuickDock that cannot report writes is told so once.** An older
  `dsh-quickdock` build answers 404 for the feed; the extension logs that
  automatic diffs need the new build instead of showing diffs nobody asked for.

### Changed

- **The generated-path list is a cosmetic filter now, not an attribution rule.**
  `node_modules`, `out`, `dist`, `build`, `.gradle`, `target` and the rest still
  keep a review of a generated file off the screen, but they no longer decide
  *whether* a change was the agent's - that is the reported write alone.
- **Requires `dsh-quickdock` 0.6 or newer** for automatic review (its
  `file-events` capability). The editor tools and the dock itself are unaffected.

### Added

- `dshVsdock.reviewIgnore`: globs for paths that must never open a review diff
  (`generated/**`, `*.log`; a bare directory name covers everything below it).

## [0.7.0] - 2026-11-15

A change DSH makes now shows up as a diff on its own.

### Changed

- **The README is for users now**: what the extension gives you, how to install
  it, first-run steps, settings, commands and troubleshooting; the developer
  material (why `view=vscode`, how the pieces fit, pairing internals, tests) moved
  to [DEVELOPING.md](DEVELOPING.md).

### Added

- **The editor tool set grew from 6 to 18**: seven read-only additions -
  `vscode_search` (text/regex across the workspace), `vscode_list_files`,
  `vscode_definitions`, `vscode_references`, `vscode_hover`,
  `vscode_code_actions` and `vscode_reveal` - plus five behind the new
  `dshVsdock.mcpWriteTools` switch: `vscode_apply_edit` (an unsaved, undoable
  edit that also opens the review diff), `vscode_save_file`, `vscode_run_task`,
  `vscode_terminal_run` and `vscode_start_debug`. The write tools are opt-in
  because they reach past the DSH sandbox into the editor, tasks, terminal and
  debugger. Flipping the switch restarts the server and re-pairs by itself.
- **Start DSH from the editor** (`DSH Dock: Start DSH`): when nothing answers on
  QuickDock's port, the extension runs the configured `dsh` command in a VS Code
  terminal, waits for the listener, and reconnects the dock. The offline card
  offers the same action when nothing is listening at all.
  `dshVsdock.dshCommand` takes `dsh` (the PATH one) or an absolute path for a
  machine with several installs; `dshVsdock.dshProfile` pins `--profile <name>`,
  and when it is empty the command lists the profiles under `~/.dsh/profiles` in a
  picker; `dshVsdock.dshArgs` appends extra arguments. Installing a missing plugin
  into the chosen profile is deliberately not part of this: the bundle has to be
  published first.
- **A path clicked in the dock opens in this editor**: QuickDock's client half
  intercepts the click on a file path in the docked conversation (tool cards,
  edit entries) and relays it here, where the file opens in a preview tab. Only
  the VS Code dock does this - the desktop window and a browser tab keep DSH's own
  preview panel.
- **Automatic review of DSH's edits** (`dshVsdock.reviewEdits`, default on): the
  extension watches the open folders for writes that did not come from the editor.
  It keeps the last known text of each text file (cached at startup, bounded) and
  opens the same review diff as `vscode_open_diff` when a file changes behind its
  back - a preview tab that does not take focus, skips generated paths and
  binaries, and only runs while the editor tools are paired for that folder. The
  editor's own saves are recognised and never reviewed.
- **`vscode_open_diff` gained an internal `focus` option**: an agent asking for a
  diff gets the focus; the watcher never takes it.

## [0.6.0] - 2026-11-15

The agent can now put a change on screen for review, and an upgraded extension no
longer needs a DSH restart to publish new tools.

### Added

- **`vscode_open_diff`**: opens VS Code's diff editor for a file the agent changed.
  Pass `original` with the text from before the change and the left pane is a
  read-only virtual document (no temp file, nothing written); omit it and the file
  is compared with its **git HEAD** revision through the built-in git extension.
- **`DSH Dock: Open a Diff for the Active File`**: the same review for the file you
  are looking at, from the palette or a keybinding of your own.

### Changed

- **A new tool set remounts the pairing once**: DSH keeps the tool list a session
  connected with, so the extension now remembers a digest of the tools it last
  registered and re-registers when the build publishes different ones. Upgrading
  the extension is enough - no DSH restart, no manual re-pair.

## [0.5.0] - 2026-11-15

The editor tools are registered per working directory now, through QuickDock's
workspace MCP bridge. The `mcp.json` descriptor and its profile row are gone.

### Added

- **The editor-tools switch lives in the dock's title bar**: QuickDock's shell bar
  gets a plug (on/off, with the pairing state in its tooltip) once the build
  reports `mcpBridge`, and a click travels back through the webview page
  (`quickdock:mcp-toggle` → `dshVsdock.mcp-toggle`). The VS Code view-title buttons
  remain only for the offline card, where the dock page cannot render.
- **A warning icon when the session works elsewhere**: the dock tells QuickDock
  every open folder, which compares it with the session on screen
  (`dock-target.workspace`) and shows an amber triangle in the bar when the editor
  tools cannot be mounted there.

### Changed

- **Pairing goes through QuickDock's own port**
  (`POST /quickdock/api/mcp-register`): the extension no longer writes `mcp.json`
  into QuickDock's state directory and no `@deepseek-ai/dsh-mcp-client` profile row
  is spliced in. QuickDock forwards the registration to DSH's workspace-scoped
  bridge, so only sessions whose working directory is inside the open folder mount
  the tools (`mcp__vscode__*`); a session elsewhere never sees them.
- **The pairing is a 20-second beat instead of a heartbeat file**: it re-registers
  after a DSH restart (registrations live in DSH's memory), follows a moved
  QuickDock port or `mcpPort`, and unregisters folders you close. Returning to the
  window checks immediately.
- **`dshVsdock.mcpPort` is a preference**: a window whose port is taken falls back
  to an ephemeral one, and the pairing carries the real URL, so two editor windows
  no longer collide on `47920`.

### Removed

- `mcp.json`: the descriptor, its atomic write and the 15-second heartbeat. The
  QuickDock build this pairs with (`0.6.0` and later) no longer reads it.

### Fixed

- Enabling the tools while QuickDock is off no longer fails silently: the server
  keeps listening, the **DSH Dock** log says why nothing is mounted, and an
  explicit enable warns once with QuickDock's own refusal message.

## [0.4.0] - 2026-11-09

The extension can now hand the editor's language tools to DSH's agent.

### Added

- **A loopback MCP server** (`src/mcp.ts`, `dshVsdock.mcp`, default off) serving
  five read-only tools: `vscode_workspace_folders`, `vscode_selection`,
  `vscode_diagnostics`, `vscode_read_file`, `vscode_symbols`. Results are bounded;
  nothing writes.
- **Automatic pairing** (`src/mcp.ts` descriptor, consumed by `dsh-quickdock`):
  the extension publishes `mcp.json` in QuickDock's state directory and QuickDock
  keeps a `@deepseek-ai/dsh-mcp-client` row enabled in the DSH profile. The
  contract is `MCP-PAIRING.md` in the QuickDock repo.
- **A toggle button**: the dock view's title bar shows a plug icon when the
  server is off and a disconnect icon when it is on; clicking it starts or stops
  the server and persists the choice in `dshVsdock.mcp`. Commands **Enable editor
  tools for DSH** / **Disable editor tools for DSH** do the same from the palette.

## [0.3.0] - 2026-11-09

The dock is a side-bar view now, not an editor tab.

### Changed

- Contributed as a **webview view in the secondary side bar** — the column Copilot
  chat lives in: the dock sits beside the code instead of splitting the editor
  area, and VS Code lets you drag the *DSH Dock* container to the primary side bar
  or the activity bar. Requires VS Code 1.96+, where a contributed view container
  may target the secondary side bar.
- The editor-tab panel, its serializer and the editor title actions are gone; the
  view's own title bar carries Reload, Open in Browser and Connection Settings.
- **Open DSH Dock** now reveals the side bar (and reloads it only when the port
  moved); showing the view does not re-render a working app.

## [0.2.0] - 2026-11-08

The dock now uses QuickDock's own IDE contract instead of shipping a private
bridge. This needs a `dsh-quickdock` build that advertises `app-proxy`; an older
plugin is recognised and the tab asks you to update it.

### Changed

- The tab loads `/quickdock?view=vscode`: QuickDock renders the trimmed editor
  chrome and embeds the app through the **plugin's** loopback proxy (the token and
  the auth cookie stay in the plugin host). **Open in Browser** uses
  `view=browser`, where the app is embedded directly.
- The extension no longer runs a reverse proxy: `src/proxy.ts` and its tests are
  gone, the shell page is never fetched by the extension, and DSH's token never
  enters the extension host.
- Compatibility is checked through `GET /quickdock/api/meta`: a build without the
  `app-proxy` capability gets an upgrade card instead of the authentication page.

### Added

- A dedicated offline state for an older QuickDock build, with the update step
  spelled out.

## [0.1.0] - 2026-11-08

First release: QuickDock's simplified DSH UI in a VS Code tab.

### Added

- **The dock tab**: opens QuickDock's shell page in an editor tab, with Reload,
  Open in Browser and Connection Settings in the title bar, and a status bar entry
  that shows whether the listener is reachable.
- **Loopback bridge** (`src/proxy.ts`): DSH's Web UI page authentication cannot
  work from a VS Code webview (the auth cookie is `SameSite=Strict`, so a
  third-party context never sends it). The extension serves the shell page and
  the DSH app from one ephemeral loopback origin, keeps the launch token and the
  auth cookie on the extension-host side, and replays the token when the cookie
  goes stale. Neither secret reaches the webview.
- **Port resolution that follows QuickDock**: explicit `dshVsdock.port` wins,
  otherwise the extension reads QuickDock's `config.json` (`port`), then
  `host.log`, then falls back to the plugin default `47910`. The status bar names
  the source; **Use Port Detected from QuickDock** adopts it in one click, and an
  open tab follows a moved port, a restarted listener and a new launch token on
  its own.
- **A real offline card**: when nothing answers, the tab explains the port, the
  reason (refused / timeout / foreign server / listener off) and offers Retry,
  the detected port, the setting and the QuickDock log.
- Bilingual UI (English / 简体中文) through VS Code's `l10n`, matching the
  plugin's own two languages.

### Tests

- 29 unit and integration tests over port resolution, config/log discovery,
  HTTP probing, the bridge's routing/token/cookie handling, and the rendered
  pages.
