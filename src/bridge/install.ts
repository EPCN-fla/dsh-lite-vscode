/**
 * One-shot bridge installer/repairer: prepares the acp-vscode profile on the
 * TARGET side (wherever dsh runs), then points dsh.profile at it.
 *
 * Steps (all idempotent):
 *   1. create profile from the acp template if missing
 *   2. ensure `@deepseek-ai/dsh-acp-app` is in the profile bundles
 *   3. write cordis.patch.yml rows per the host dsh version (the untouched
 *      "[]" template is replaced; real user content gets the rows appended) —
 *      on 0.1.7 hosts existing files are migrated instead: the stale
 *      `dsh-agent-presets` row is stripped (.bak kept) and the declarative
 *      preset rows are appended when missing
 *   4. ensure the bridge package is installed into the profile
 */
import * as vscode from 'vscode'
import { spawn } from 'node:child_process'
import { readConfig } from '../config.js'
import { detectHostSide } from '../launcher/detect.js'
import { buildPosixInstallScript } from './installScript.js'

/** Run a command with its script piped over stdin (not passed as an argv
 *  element): the vendored preset rows push the installer past the Windows
 *  CreateProcess command-line limit on the wsl.exe path (spawn ENAMETOOLONG). */
function runWithStdin(cmd: string, args: string[], input: string, timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    const timer = setTimeout(() => { child.kill(); reject(new Error(`install timed out after ${timeoutMs / 1000}s`)) }, timeoutMs)
    child.on('error', e => { clearTimeout(timer); reject(e) })
    child.on('close', code => {
      clearTimeout(timer)
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`exit code ${code}${stderr.trim() ? ` — ${stderr.trim().slice(-300)}` : ''}`))
    })
    child.stdin.on('error', () => undefined) // EPIPE when the child dies before reading
    child.stdin.end(input)
  })
}

export async function installBridgeFlow(out: vscode.OutputChannel): Promise<void> {
  const pkg = await vscode.window.showInputBox({
    title: 'DSH: Install Bridge',
    prompt: 'Bridge package spec (npm name@version, tarball path, or directory). DSH 0.1.7 hosts need ≥ 0.2.0 (the agent-presets split); native commands, skills and session export need ≥ 0.1.3.',
    value: 'dsh-vscode-bridge@^0.2.0',
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
  // Run the script on the TARGET side, fed over stdin (bash -s): same-side via
  // bash, WSL-from-Windows via wsl.exe. argv passing would cap the script at
  // 32 KiB on the Windows path — the preset rows alone are larger.
  const spec = host === 'windows'
    ? { cmd: 'wsl.exe', args: [...(cfg.wslDistro ? ['-d', cfg.wslDistro] : []), '-e', 'bash', '-s'] }
    : { cmd: '/bin/bash', args: ['-s'] }

  try {
    const r = await runWithStdin(spec.cmd, spec.args, script, 180_000)
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
