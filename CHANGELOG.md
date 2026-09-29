# Changelog

All notable changes to DSH Lite are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/), versioning follows [SemVer](https://semver.org/).

## [0.2.1] — 2026-09-29

### Fixed

- **Blank-session model/effort reset on the first send**: the startup session was stamped with the client generation read *before* the agent finished starting, so the first prompt took the restart re-attach path, hit "already active", and silently recreated the session at the deployment default (DeepSeek-V4-Flash). The generation is now stamped after the await, an "already active" answer is adopted instead of recreated, and `ensureSession` is serialized so prompts can no longer race a re-attach
- **Switching to a session owned by another dsh instance (e.g. still open in the Web UI) no longer breaks the chat**: the switch now resumes the target *before* closing the current session, lock contention surfaces a clear "session busy in another instance" explanation instead of a raw internal error, and a failed request no longer paints the connection indicator red — it reflects the service's actual state
- **No way back from a dropped connection**: the red status dot is now a reconnect button, and the empty state offers a reconnect action (the `.reconnect` style existed but nothing rendered it)
- **A session the server forgot without a connection drop** (e.g. a plugin hot-reload disposed it) is now marked stale and transparently re-attached from persistence on the next prompt, instead of failing with "unknown session" forever
- **Restart re-attach restores the pre-restart model/effort**: a resumed session only knows its last *logged* route, so a blank session (or a model switch after the last prompt) used to come back at the default; the picks are now replayed when they diverge
- **Sessions created outside the client (e.g. in the Web UI) rendered as empty chats**: ACP resume does not replay history and the local transcript cache only knows home-grown sessions. On switch, the transcript is now rebuilt once from the durable dsh log via the bridge's `session.exportZip` (user prompts, assistant text/reasoning, tool calls and results) and cached locally
- **`preset.current` echo after `preset.select`** no longer errors when the session was switched or closed mid-select

### Added

- **Remembered model + reasoning effort for new sessions**: the last selection (`dsh.lastModelSelection`) is replayed onto every freshly created session — no more DeepSeek-V4-Flash by default. Values that disappeared from the catalog fall back to the provider default gracefully
- `scripts/verify-fixes.ts` (`npm run verify:fixes`): end-to-end harness that drives the real `ChatViewProvider` against a live dsh through the blank-session switch/send flow, the lock-contention switch, and a kill+reconnect recovery
- Headless regression tests for the three fixes (vscode API mocked, ACP service faked)

## [0.2.0] — 2026-09-21

### Added

- **Slash-command menu** in the composer (Web-UI style): typing `/` opens grouped 指令/技能 sections with substring filtering, arrow-key navigation that scrolls the selection into view, and IME-safe key handling
  - Extension commands: `/file`, `/image`, `/model`, `/effort`, `/permission`, `/new`, `/export`
  - With **dsh-vscode-bridge ≥ 0.1.3**: native dsh commands via `command.list`/`command.run` (compact, plan, goal, …), the skill catalog via `skill.list`, and session-log ZIP export via `session.exportZip` (path mapped back to the host, reveal/copy actions)
  - Typed `/name args` lines are intercepted and executed instead of reaching the model; commands taking input and all skills only fill the composer so a prompt can be appended (`请使用 <name> 技能：<args>`)
  - Long-running commands show a `Running /compact…` indicator; results land as ✓/✖ system messages routed to the originating session; pre-0.1.3 bridges get an in-transcript upgrade hint
  - The native command list refetches when the agent preset changes (the registry is agent-scoped); known commands carry the Web UI's Chinese labels
- **Tool-call cards**: Web-UI-style subtitles distilled from raw input (per-call description first), plus labeled input/result/output sections in the expanded fold
- **Copy buttons**: icon-only, hover-revealed — below user bubbles and at the bottom of assistant output
- **Pinned, collapsible task card** with a done/total counter and a background tint
- **Token usage in the VS Code status bar**: orca icon 🐳, model name, and per-session context usage persisted across window reloads
- **Bridge v0.1.2 support**: new sessions are filed into their workspace via `workspace.attach` right after ACP `newSession`

### Fixed

- **Startup session stacking**: the previous session (empty ones included) is resumed first and a new one created only when nothing resumes; the persisted id now survives window reloads, and first prompts are serialized behind the restore
- **`dsh.installBridge`**: writes a valid `cordis.patch.yml` per the bridge README (untouched-template replacement, single insert list, permission metadata)
- **Empty tool folds** always show at least the call's raw input
- **Select menus** size to their content; the composer rail wraps instead of overflowing
- **"session-" rows**: untitled sessions strip the id prefix before slicing
- Resuming a session without local history shows the welcome screen instead of a synthetic "Session resumed" notice
- Tool detail text renders in a CJK-friendly font stack (no more 宋体 fallback)
- Composer keys during IME composition no longer trigger menu picks or sends

### Changed

- Recommended bridge minimum: **dsh-vscode-bridge ≥ 0.1.3** (installer default and README updated)

## [0.1.0] — 2026-09-19

Initial public release.

### Features

- **Chat view** with markdown rendering, thought folds, structured tool-call cards, and a sessions sidebar (stable ordering, click to resume)
- **Four runtime topologies** — Windows, Windows→WSL, Remote-WSL, and Remote-WSL→Windows (best-effort) — with automatic path translation and a shell environment bootstrap (nvm/volta/mise/asdf)
- **Composer rail**: agent preset, model, and reasoning-effort pickers plus permission modes; `@` file mentions; image attachments (paste or picker, capability-gated)
- **Change review**: files touched by the agent are tracked live (file watcher + git fallback) with native diff against `HEAD`
- **`@dsh` chat participant** in the native Chat view; **DSH: Explain Selection** one-shot explanations
- **Bridge plugin integration** ([dsh-vscode-bridge](https://www.npmjs.com/package/dsh-vscode-bridge) ≥ 0.1.1): native session titles, rename/delete, agent presets, permission modes, todo cards, plan-mode banner, and workspace grouping in the DSH Web UI — discovered via the centralized `$DSH_HOME/vscode-bridge/<pid>.json` registry
- **First-run setup page**, environment doctor, one-shot bridge installer/repairer
- Chinese and English UI strings; dark/light theme-aware throughout
