/**
 * First-run setup panel: one-time environment configuration (runtime topology,
 * dsh command, distro, profile). Reopenable anytime via `DSH: Setup`.
 */
import * as vscode from 'vscode'

export class SetupPanel {
  /** Re-open focuses the existing panel instead of stacking duplicates. */
  private static current?: vscode.WebviewPanel

  static open(context: vscode.ExtensionContext): void {
    if (this.current) { this.current.reveal(); return }
    const panel = vscode.window.createWebviewPanel('dsh.setup', 'DSH Lite Setup', vscode.ViewColumn.One, { enableScripts: true })
    this.current = panel
    panel.onDidDispose(() => { this.current = undefined })
    const cfg = vscode.workspace.getConfiguration('dsh')
    const state = {
      runtime: cfg.get('runtime', 'auto'),
      command: cfg.get('command', 'npx -y @deepseek-ai/dsh'),
      wslDistro: cfg.get('wsl.distro', ''),
      profile: cfg.get('profile', 'acp-vscode'),
      remoteName: vscode.env.remoteName ?? 'local',
      platform: process.platform,
    }
    panel.webview.html = html(state)
    panel.webview.onDidReceiveMessage(async m => {
      if (m.type === 'save') {
        // Only write non-empty values — an empty string would still land in settings.json.
        const put = async (key: string, value: string): Promise<void> => {
          if (typeof value === 'string' && value.trim() !== '') await cfg.update(key, value.trim(), vscode.ConfigurationTarget.Global)
        }
        await put('runtime', m.values.runtime)
        await put('command', m.values.command)
        await put('wsl.distro', m.values.wslDistro)
        await put('profile', m.values.profile)
        await context.globalState.update('dsh.setupDone', true)
        const pick = await vscode.window.showInformationMessage('DSH Lite: setup saved.', 'Reload Window')
        if (pick) void vscode.commands.executeCommand('workbench.action.reloadWindow')
        panel.dispose()
      } else if (m.type === 'doctor') {
        void vscode.commands.executeCommand('dsh.doctor')
      } else if (m.type === 'installBridge') {
        void vscode.commands.executeCommand('dsh.installBridge')
      }
    })
  }

  static maybeAutoOpen(context: vscode.ExtensionContext): void {
    if (context.globalState.get('dsh.setupDone')) return
    // Cancellable: a window reload within the delay must not open the panel
    // into a tearing-down extension host.
    const timer = setTimeout(() => SetupPanel.open(context), 800)
    context.subscriptions.push({ dispose: () => clearTimeout(timer) })
  }
}

function esc(s: string): string { return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;') }

function html(state: { runtime: string; command: string; wslDistro: string; profile: string; remoteName: string; platform: string }): string {
  const sel = (v: string): string => (state.runtime === v ? 'selected' : '')
  // Lock the panel down to its one inline script (acquireVsCodeApi handlers).
  const nonce = Math.random().toString(36).slice(2)
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'">
<style>
body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 24px 32px; max-width: 560px; margin: 0 auto; }
h1 { font-size: 1.4em; } h2 { font-size: 1em; color: var(--vscode-descriptionForeground); font-weight: 400; margin-top: 0; }
label { display: block; margin: 14px 0 4px; font-weight: 600; }
input, select { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px; padding: 5px 8px; }
.hint { color: var(--vscode-descriptionForeground); font-size: 0.88em; margin-top: 3px; }
.row { display: flex; gap: 8px; margin-top: 22px; }
button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px; padding: 6px 16px; cursor: pointer; }
button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
.env { border-left: 3px solid var(--vscode-textLink-foreground, #3794ff); padding: 2px 12px; font-size: 0.9em; color: var(--vscode-descriptionForeground); }
</style></head><body>
<h1>Welcome to DSH Lite</h1>
<h2>One-time environment setup</h2>
<div class="env">Detected: extension host <b>${esc(state.remoteName)}</b> · platform <b>${esc(state.platform)}</b></div>

<label>Where should the dsh agent run? (dsh.runtime)</label>
<select id="runtime">
  <option value="auto" ${sel('auto')}>auto — same side as the extension host</option>
  <option value="wsl" ${sel('wsl')}>wsl — inside WSL (for Windows VS Code)</option>
  <option value="windows" ${sel('windows')}>windows — on Windows (for Remote-WSL windows)</option>
</select>

<label>dsh launch command (dsh.command)</label>
<input id="command" value="${esc(state.command)}" />
<div class="hint">Examples: <code>npx -y @deepseek-ai/dsh</code> · <code>dsh</code> · <code>node ~/deepseek-harness/apps/cli/lib/bin.js</code></div>

<label>WSL distro (dsh.wsl.distro, optional)</label>
<input id="wslDistro" value="${esc(state.wslDistro)}" placeholder="empty = default distro" />

<label>dsh profile (dsh.profile)</label>
<input id="profile" value="${esc(state.profile)}" />
<div class="hint">Default <code>acp-vscode</code> is created by the required bridge plugin install (button below); <code>acp</code> runs bridge-less.</div>

<div class="row">
  <button id="save">Save &amp; Continue</button>
  <button id="doctor" class="secondary">Run Doctor</button>
  <button id="bridge" class="secondary">Install/Repair Bridge…</button>
</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi()
document.getElementById('save').onclick = () => vscode.postMessage({ type: 'save', values: {
  runtime: document.getElementById('runtime').value,
  command: document.getElementById('command').value,
  wslDistro: document.getElementById('wslDistro').value,
  profile: document.getElementById('profile').value,
} })
document.getElementById('doctor').onclick = () => vscode.postMessage({ type: 'doctor' })
document.getElementById('bridge').onclick = () => vscode.postMessage({ type: 'installBridge' })
</script>
</body></html>`
}
