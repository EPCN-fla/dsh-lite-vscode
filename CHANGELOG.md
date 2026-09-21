# Changelog

All notable changes to DSH Lite are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/), versioning follows [SemVer](https://semver.org/).

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
