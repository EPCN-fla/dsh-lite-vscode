# DSH Lite — DeepSeek Harness for VS Code

Chat with the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) agent inside VS Code: sessions, streaming replies, tool-call cards, permission prompts, model/effort/preset pickers, change review, and `@`-mentions — built on the standard [Agent Client Protocol](https://agentclientprotocol.com) (ACP), like the Claude Code and Codex extensions.

## Features

- **Chat view** with markdown rendering, thought folds, tool cards (structured key/value args), and a sessions sidebar
- **Session management** — list / resume / rename / delete (rename & delete need the bridge plugin), local transcript cache
- **Model, reasoning-effort, agent-preset, and permission-mode pickers** in the composer rail
- **Change review** — files the agent touches are tracked live; open a native diff against `HEAD` per file
- **`@` file mentions** and editor-context attachment; **image attachments** (paste or picker, when the route supports them)
- **`@dsh` chat participant** in the native Chat view, and **DSH: Explain Selection** for one-shot code explanations
- **Import Web models and agent presets** with preview and confirmation (bridge ≥ 0.4.0)
- **Todo cards / plan-mode banner** streamed from the agent (bridge plugin)
- Cross-environment: run dsh on Windows, in WSL, or inside a Remote-WSL window (see [Topologies](#topologies))

## Requirements

- **Node.js ≥ 22.19** on the side where dsh runs (the dsh CLI requires `^22.19.0 || >=24.0.0`; nvm/volta/mise are picked up automatically)
- **DeepSeek Harness** — installed (`npm i -g @deepseek-ai/dsh`), used via `npx`, or from a repository checkout
- **dsh-vscode-bridge** dsh plugin (**required**) — the `DSH: Install/Repair Bridge Plugin` command wires it in (creates the default `acp-vscode` profile, registers the service rows, installs the plugin). It powers session titles, delete, presets, permission modes, workspace grouping, todo/plan push, native slash commands, skill catalog, and session-log export.

### Version matching

| dsh-lite-vscode | dsh-vscode-bridge |
|---|---|
| **0.3.1** | **^0.4.0** |
| 0.3.0 | ^0.3.0 |
| 0.2.2 | ^0.2.0 |
| ≤ 0.2.1 | 0.1.3 – 0.2.x |

The table lists recommended extension/bridge pairings, not hard minimums for every feature. Extension 0.3.1 retains existing features with older bridges; Web configuration import requires bridge **0.4.0+** advertising `configSync`.

For bridge-to-DSH host compatibility, see the [dsh-vscode-bridge compatibility matrix](https://github.com/EPCN-fla/dsh-vscode-bridge#安装). The installer probes the host version and selects the appropriate profile wiring and bridge package: `dsh-vscode-bridge@^0.4.0` for current hosts, or `^0.2.0` for legacy hosts outside the newer bridge's support corridor. It also repairs obsolete preset service rows when upgrading an older profile. Live extension-host verification of the newly recognized host versions is still required.

## Quick start

1. Install this extension (`.vsix` or build from source — see [Development](#development)).
2. On first run, the **DSH Lite Setup** page opens: pick where dsh runs and how to launch it. Reopen anytime with `DSH: Setup`.
3. Run **`DSH: Install/Repair Bridge Plugin`** (required): creates the default `acp-vscode` dsh profile, wires the services, and installs the bridge plugin.
4. Open the **DSH** view in the activity bar — the agent boots automatically, and a session is created for you.

## Settings

| Setting | Default | Description |
|---|---|---|
| `dsh.runtime` | `auto` | Where the agent process runs: `auto` (same side as the extension host), `wsl`, or `windows` |
| `dsh.command` | `npx -y @deepseek-ai/dsh` | Launch command on the target side; the extension appends `--profile <dsh.profile>` |
| `dsh.profile` | `acp-vscode` | dsh profile to boot; the default is created by the required bridge install. `acp` runs bridge-less |
| `dsh.wsl.distro` | `""` | WSL distribution name when `dsh.runtime` is `wsl` (empty = default) |
| `dsh.env` | `{}` | Extra environment variables for the dsh process (e.g. `DEEPSEEK_API_KEY`) |
| `dsh.mcpServers` | `[]` | MCP servers mounted on every new session (prefer `DSH: Configure MCP Servers`) |
| `dsh.autoAttachActiveFile` | `false` | Attach the active editor file/selection to every prompt |

## Topologies

| VS Code window | dsh runs | Setting |
|---|---|---|
| Windows | Windows | `auto` |
| Windows | WSL | `wsl` |
| Remote-WSL | WSL | `auto` |
| Remote-WSL | Windows | `windows` (best-effort: WSL-native files appear as slow `\\wsl$` UNC paths; the bridge channel is unavailable in this direction) |

Path translation between the VS Code side and the dsh side is automatic (`wslpath` probing + drvfs prefix mapping).

## Commands

| Command | What it does |
|---|---|
| `DSH: Setup` | Open the setup page (runtime/command/distro/profile) |
| `DSH: New Session` | New session (an untouched empty session is reused instead) |
| `DSH: Install/Repair Bridge Plugin` | Idempotent bridge installer/repairer on the target side |
| `DSH: Import Models and Presets from Web` | Preview and import Web profile models/presets into the connected bridge profile (bridge ≥ 0.4.0) |
| `DSH: Doctor` | Probe node/dsh availability **on the dsh side**, and report the bridge connection with its host dsh version |
| `DSH: Show Agent Changes` | QuickPick over agent-changed files → native diff |
| `DSH: Configure MCP Servers` | Add/remove MCP servers (stdio/HTTP) mounted on new sessions |
| `DSH: Explain Selection` | One-shot explanation of the selected code in a preview tab |
| `DSH: Run in Terminal` | Launch the dsh TUI in an integrated terminal (topology-aware) |
| `DSH: Focus Chat` / `DSH: Refresh Sessions` | View utilities |

## Import Web configuration

Run **DSH: Import Models and Presets from Web** (`dsh.importWebConfig`; Chinese title: **DSH: 从 Web 导入模型与预设**).

1. Connect DSH Chat to the target ACP profile with bridge **0.4.0+** advertising `configSync`. Older bridges remain usable for their existing features.
2. Choose models, agent presets, or both. Same-name target entries are **kept by default**; opt-in overwrite replaces the complete provider (including its model list) or preset definition.
3. Review the source/target profile, providers, presets, supporting service rows and skipped entries, then confirm. Cancellation or an unchanged preview writes nothing. The exact preview revision and options are sent to `config.import`; a stale preview requires running the command again, never an automatic retry. Preview/import requests have 30/60-second deadlines. A timeout or disconnection does not cancel host-side writes: check the target configuration and backups before previewing again.
4. The result shows the backup path **on the DSH host**. After active turns finish, restart the target ACP/bridge process. For the extension-managed process, use **Developer: Reload Window**. Existing sessions do not automatically switch models/presets; select the imported configuration in a new session as needed.

This is an explicit one-way import from `web` in the **same DSH_HOME** into the connected bridge profile, not background synchronization. File operations stay on the DSH host (including Windows → WSL); VS Code receives identifiers and a revision, not configuration bytes or secrets. Only the target `cordis.patch.yml` is rewritten, with a backup when the file already exists. To roll back, stop the target process first and restore that backup on the host.

Environment files, OAuth/credential stores and third-party packages are not copied. Environment/credential references must work on the target; custom preset dependencies may need manual installation/wiring. YAML formatting/comments can change. Shared home overrides, missing packages and unsupported profile structures can prevent import; resolve these on the host and preview again.

## Troubleshooting

Everything the agent process prints lands in the **DSH** output channel; bridge connection state is logged there too.

- **Chat stuck on “Initializing…”** → run `DSH: Doctor`. Common causes: nvm-managed node not on the non-interactive PATH (the extension sources nvm/volta/mise/asdf quietly; otherwise use an absolute node path in `dsh.command`), wrong distro, or a non-ACP profile (`web`/`tui`/`desktop` are rejected with a warning).
- **First `npx` run times out** → it downloads the package; install once (`npm i -g @deepseek-ai/dsh`) or point `dsh.command` at a checkout.
- **“no API key for provider route”** → configure the key once in the dsh Web UI Models page (shared via `$DSH_HOME`), or set `dsh.env.DEEPSEEK_API_KEY`.
- **Bridge features missing** (titles/delete/presets/permissions) → run `DSH: Install/Repair Bridge Plugin`; the bridge is required (see the [version table](#version-matching)).
- **“profile "acp-vscode" does not exist” on startup** → the default profile is created by the bridge installer; run `DSH: Install/Repair Bridge Plugin`.
- **Custom models gone / “no adapter registered for provider …” after a dsh 0.1.7-rc.1 upgrade** → 0.1.7-rc.1 made model providers per-profile (the global `settings.yaml` was folded into the profile that booted first and renamed to `settings.yaml.imported`). Use **DSH: Import Models and Presets from Web** with bridge 0.4.0+, or manually copy the `llm-pi-ai` section into the target profile's `cordis.patch.yml`.

## Development

```sh
npm install
npm run build       # bundle extension + webview into dist/
npm run watch       # incremental
npm test            # unit tests (node:test, esbuild-bundled)
npm run typecheck   # strict tsc
npm run smoke       # headless ACP contract test against a real dsh (DSH_COMMAND=… to override)
npm run package     # produce a .vsix

# publishing (needs a publisher PAT):
VSCE_PAT=<azure-devops-pat> npm run publish:marketplace   # VS Code Marketplace
OVSX_PAT=<open-vsx-pat>     npm run publish:ovsx          # Open VSX
```

CI in `.github/workflows/ci.yml` follows these rules:

- **Branch pushes** (including release branches and merges into `main`): no workflow run.
- **Pull requests** (opened, updated or reopened): Ubuntu + Windows validation with typecheck, build, unit tests and ACP contract smoke against the published DSH. Each platform writes step outcomes and unit-test totals to the Actions **Summary**, including when validation fails; one platform's failure does not cancel the other.
- **Tag pushes (`v*`)**: first verify the tag equals `v<package.json version>` and both lockfile versions match, then typecheck, build/package, GitHub Release and marketplace publishing only — no unit tests or ACP smoke. Publishing uses the locally built VSIX and does not depend on the PR test jobs. Enable `VSCE_PUBLISH` / `OVSX_PUBLISH` repository variables (`true`) and configure the corresponding `VSCE_PAT` / `OVSX_PAT` secrets; with neither enabled, the job still builds/packages and creates a GitHub Release with the VSIX attached and automatically generated release notes.
- **No Actions artifacts** are uploaded. PR test results are reported in Summary; only `v*` tag runs create GitHub Releases and upload the VSIX as a release asset.

Press `F5` for an Extension Development Host with this project opened.

```
src/launcher/   topology detection, process launch specs, WSL↔Windows path mapping
src/acp/        typed ACP client + shared service (vscode-free core)
src/bridge/     dsh-vscode-bridge client + centralized discovery (>=0.1.2)
src/chat/       chat view host: sessions, permissions, context, transcripts, changes
src/webview/    React chat UI (RailSelect, sessions sidebar, todo/plan, welcome)
src/setup/      first-run setup webview panel
src/shared/     host↔webview protocol + pure helpers
tests/          node:test suites (launcher matrix, session ordering, bridge protocol, …)
scripts/        smoke test + icon generator
```

## License

[MIT](LICENSE)
