import * as vscode from 'vscode'
import { readConfig } from './config.js'
import type { McpServer } from '@agentclientprotocol/sdk'
import { parseMcpServers, configureMcpFlow } from './mcp.js'
import { detectHostSide, resolveLauncher, LauncherConfigError } from './launcher/detect.js'
import type { Launcher } from './launcher/types.js'
import { AcpService } from './acp/service.js'
import { ChatViewProvider } from './chat/ChatViewProvider.js'
import { TranscriptStore } from './chat/TranscriptStore.js'
import { ChangedFilesTracker, BaselineContentProvider } from './chat/ChangedFilesTracker.js'
import { registerParticipant, explainSelection } from './chat/participant.js'
import { BridgeManager } from './bridge/manager.js'
import { installBridgeFlow } from './bridge/install.js'
import { SetupPanel } from './setup/SetupPanel.js'
import { friendlyModelName } from './shared/model.js'

let launcher: Launcher | undefined

function currentLauncher(): Launcher {
  if (launcher) return launcher
  const host = detectHostSide(vscode.env.remoteName, process.platform, process.env)
  launcher = resolveLauncher(host, readConfig())
  return launcher
}

/** 方案A fallback: run the dsh TUI in an integrated terminal, honoring topology. */
async function terminalText(): Promise<string> {
  const cfg = readConfig()
  const host = detectHostSide(vscode.env.remoteName, process.platform, process.env)
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  if (host === 'windows' && cfg.runtime === 'wsl') {
    const wslCwd = cwd ? await currentLauncher().paths.toDsh(cwd) : undefined
    const distro = cfg.wslDistro ? `-d ${cfg.wslDistro} ` : ''
    return `wsl.exe ${distro}${wslCwd ? `--cd "${wslCwd}" ` : ''}-e bash -lc "${cfg.command}"`
  }
  if (host === 'wsl' && cfg.runtime === 'windows') return `cmd.exe /c ${cfg.command}`
  return cfg.command
}

/** Raw read of dsh.mcpServers (kept here to avoid a config.ts shape change). */
function readConfigRaw(): unknown {
  return vscode.workspace.getConfiguration('dsh').get('mcpServers')
}

export function activate(context: vscode.ExtensionContext): void {
  const out = vscode.window.createOutputChannel('DSH')
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50)
  status.command = 'dsh.focusChat'
  status.text = '$(hubot) DSH'
  status.show()

  let service: AcpService
  try {
    service = new AcpService(currentLauncher, out)
  } catch (e) {
    if (e instanceof LauncherConfigError) void vscode.window.showErrorMessage(e.message)
    throw e
  }
  const transcripts = new TranscriptStore(context)
  const tracker = new ChangedFilesTracker(currentLauncher, out)
  const bridge = new BridgeManager(readConfig, () => currentLauncher().paths, out)
  bridge.start()
  service.mcpServers = parseMcpServers(readConfigRaw())
  const chat = new ChatViewProvider(context, service, transcripts, tracker, bridge, currentLauncher, out)

  const refreshStatus = (busy = false): void => {
    const model = friendlyModelName(chat.activeConfigOptions() ?? [])
    const usage = chat.usageText
    status.text = `$(hubot) ${model ?? 'DSH'}${usage ? ' · ' + usage : ''}${busy ? ' $(sync~spin)' : ''}`
    status.tooltip = `topology: ${currentLauncher().label}${chat.activeSessionId ? `\nsession: ${chat.activeSessionId}` : ''}`
  }
  refreshStatus()

  context.subscriptions.push(
    out, status, service, chat, bridge,
    vscode.workspace.registerTextDocumentContentProvider('dsh-baseline', new BaselineContentProvider(out)),
    vscode.commands.registerCommand('dsh.showChanges', async () => {
      const files = tracker.filesFor(chat.activeSessionId ?? '')
      if (files.length === 0) { void vscode.window.showInformationMessage('DSH: no agent changes tracked in this session yet.'); return }
      const pick = await vscode.window.showQuickPick(files.map(f => ({ label: f.label, description: '', f })), { placeHolder: 'Agent-changed files in this session' })
      if (pick) await tracker.openDiff(pick.f)
    }),
    vscode.window.registerWebviewViewProvider('dsh.chatView', chat, { webviewOptions: { retainContextWhenHidden: true } }),
    chat.onDidChangeSession(s => refreshStatus(s?.busy ?? false)),
    service.onState(e => {
      refreshStatus()
      if (e.state === 'ready') {
        void bridge.reconnect()
        // Bridge features need the acp-vscode profile + plugin; nudge once.
        if (readConfig().profile !== 'acp-vscode' && !context.globalState.get('dsh.bridgePrompt.dismissed')) {
          void vscode.window.showInformationMessage(
            'DSH: install the bridge plugin to unlock session titles, delete, presets, permission modes and workspace grouping.',
            '安装 Bridge', '不再提示',
          ).then(pick => {
            if (pick === '安装 Bridge') void vscode.commands.executeCommand('dsh.installBridge')
            else if (pick === '不再提示') void context.globalState.update('dsh.bridgePrompt.dismissed', true)
          })
        }
      }
    }),
    vscode.commands.registerCommand('dsh.newSession', () => chat.newSession()),
    vscode.commands.registerCommand('dsh.focusChat', () => vscode.commands.executeCommand('dsh.chatView.focus')),
    vscode.commands.registerCommand('dsh.refreshSessions', () => chat.pushSessions()),
    vscode.commands.registerCommand('dsh.resumeSession', async (sessionId: string) => {
      await chat.resume(sessionId)
      void vscode.commands.executeCommand('dsh.chatView.focus')
    }),
    vscode.commands.registerCommand('dsh.addContextFromEditor', () => {
      chat.addActiveEditorToContext()
      void vscode.commands.executeCommand('dsh.chatView.focus')
    }),
    vscode.commands.registerCommand('dsh.runInTerminal', async () => {
      const t = vscode.window.createTerminal({ name: 'DSH' })
      t.show()
      t.sendText(await terminalText())
    }),
    registerParticipant(service, currentLauncher, out, context.extensionUri),
    vscode.commands.registerCommand('dsh.explainSelection', () => explainSelection(service)),
    vscode.commands.registerCommand('dsh.configureMcp', async () => {
      await configureMcpFlow()
      service.mcpServers = parseMcpServers(readConfigRaw())
    }),
    vscode.commands.registerCommand('dsh.setup', () => SetupPanel.open(context)),
    vscode.commands.registerCommand('dsh.installBridge', () => installBridgeFlow(out)),
    vscode.commands.registerCommand('dsh.doctor', async () => {
      out.show()
      try {
        const l = currentLauncher()
        const spec = await l.buildDoctorSpec()
        out.appendLine(`[doctor] topology: ${l.label}`)
        out.appendLine(`[doctor] probe: ${spec.command} ${spec.args.join(' ')}`)
        const { execFile } = await import('node:child_process')
        const { promisify } = await import('node:util')
        const r = await promisify(execFile)(spec.command, spec.args, { timeout: 30_000, env: { ...process.env, ...spec.env }, shell: spec.shell ?? false })
        out.appendLine(r.stdout)
        if (r.stderr) out.appendLine(`[stderr] ${r.stderr}`)
        void vscode.window.showInformationMessage('DSH doctor finished — see the DSH output channel.')
      } catch (e) {
        out.appendLine(`[doctor] FAILED: ${(e as Error).message}`)
        void vscode.window.showErrorMessage(`DSH doctor failed: ${(e as Error).message}`)
      }
    }),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('dsh')) {
        launcher = undefined
        service.reset()
        service.mcpServers = parseMcpServers(readConfigRaw())
        chat.reset()
        refreshStatus()
      }
    }),
  )

  try { currentLauncher() } catch (e) {
    if (e instanceof LauncherConfigError) void vscode.window.showErrorMessage(String(e.message))
  }

  SetupPanel.maybeAutoOpen(context)

  // Guard against non-ACP profiles (web/desktop/tui serve entirely different surfaces).
  const profile = readConfig().profile
  if (['web', 'desktop', 'tui', 'headless'].includes(profile)) {
    void vscode.window.showWarningMessage(
      `DSH: profile "${profile}" does not speak ACP over stdio — the chat will fail to connect. Use "acp" or "acp-vscode".`,
    )
  }
}

export function deactivate(): void { /* subscriptions dispose everything */ }
