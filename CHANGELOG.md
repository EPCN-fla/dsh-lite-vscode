# Changelog

All notable changes to DSH Lite are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/), versioning follows [SemVer](https://semver.org/).

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
