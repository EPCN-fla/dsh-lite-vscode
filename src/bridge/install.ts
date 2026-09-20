/**
 * One-shot bridge installer/repairer: prepares the acp-vscode profile on the
 * TARGET side (wherever dsh runs), then points dsh.profile at it.
 *
 * Steps (all idempotent):
 *   1. create profile from the acp template if missing
 *   2. ensure `@deepseek-ai/dsh-acp-app` is in the profile bundles
 *   3. write cordis.patch.yml per the dsh-vscode-bridge README (the untouched
 *      "[]" template is replaced; real user content gets the rows appended)
 *   4. ensure the bridge package is installed into the profile
 */
import * as vscode from 'vscode'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readConfig } from '../config.js'
import { detectHostSide } from '../launcher/detect.js'
import { buildPosixInstallScript } from './installScript.js'

const execFileP = promisify(execFile)

export async function installBridgeFlow(out: vscode.OutputChannel): Promise<void> {
  const pkg = await vscode.window.showInputBox({
    title: 'DSH: Install Bridge',
    prompt: 'Bridge package spec (npm name@version, tarball path, or directory). workspace.attach requires ≥ 0.1.2.',
    value: 'dsh-vscode-bridge@^0.1.2',
  })
  if (!pkg) return

  const host = detectHostSide(vscode.env.remoteName, process.platform, process.env)
  const cfg = readConfig()
  const target = cfg.runtime === 'auto' ? host : cfg.runtime

  out.show()
  out.appendLine(`[install] host=${host} target=${target} pkg=${pkg}`)

  if (target === 'windows') {
    void vscode.window.showWarningMessage('DSH: automatic bridge install currently supports POSIX targets (WSL/Linux) only.')
    return
  }

  const script = buildPosixInstallScript(cfg.command, pkg)
  // Run the script on the TARGET side: same-side via bash, WSL-from-Windows via wsl.exe.
  const spec = host === 'windows'
    ? { cmd: 'wsl.exe', args: [...(cfg.wslDistro ? ['-d', cfg.wslDistro] : []), '-e', 'bash', '-c', script] }
    : { cmd: '/bin/bash', args: ['-c', script] }

  try {
    const r = await execFileP(spec.cmd, spec.args, { timeout: 180_000, maxBuffer: 4 * 1024 * 1024 })
    out.append(r.stdout)
    if (r.stderr.trim()) out.appendLine(`[stderr] ${r.stderr.slice(-500)}`)
    await vscode.workspace.getConfiguration('dsh').update('profile', 'acp-vscode', vscode.ConfigurationTarget.Global)
    const pick = await vscode.window.showInformationMessage('DSH bridge installed; dsh.profile → acp-vscode.', 'Reload Window')
    if (pick) void vscode.commands.executeCommand('workbench.action.reloadWindow')
  } catch (e) {
    out.appendLine(`[install] FAILED: ${(e as Error).message}`)
    void vscode.window.showErrorMessage('DSH bridge install failed — see DSH output.')
  }
}
