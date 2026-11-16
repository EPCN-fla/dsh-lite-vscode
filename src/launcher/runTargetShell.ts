/** Run a POSIX shell script on the TARGET side (where dsh runs). Best-effort utility. */
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import * as vscode from 'vscode'
import { readConfig } from '../config.js'
import { detectHostSide } from './detect.js'

const execFileP = promisify(execFile)

export async function runTargetShell(script: string, timeoutMs = 30_000): Promise<{ stdout: string; stderr: string }> {
  const host = detectHostSide(vscode.env.remoteName, process.platform, process.env)
  const cfg = readConfig()
  const target = cfg.runtime === 'auto' ? host : cfg.runtime
  if (target === 'windows') throw new Error('target-side shell not supported for Windows targets')
  const spec = host === 'windows'
    ? { cmd: 'wsl.exe', args: [...(cfg.wslDistro ? ['-d', cfg.wslDistro] : []), '-e', 'bash', '-c', script] }
    : { cmd: '/bin/bash', args: ['-c', script] }
  const r = await execFileP(spec.cmd, spec.args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 })
  return { stdout: r.stdout, stderr: r.stderr }
}


/** Run a longer script on the TARGET side through bash stdin, avoiding the
 * Windows CreateProcess argv limit on the wsl.exe path. */
export async function runTargetShellStdin(script: string, timeoutMs = 30_000): Promise<{ stdout: string; stderr: string }> {
  const host = detectHostSide(vscode.env.remoteName, process.platform, process.env)
  const cfg = readConfig()
  const target = cfg.runtime === 'auto' ? host : cfg.runtime
  if (target === 'windows') throw new Error('target-side shell not supported for Windows targets')
  const spec = host === 'windows'
    ? { cmd: 'wsl.exe', args: [...(cfg.wslDistro ? ['-d', cfg.wslDistro] : []), '-e', 'bash', '-s'] }
    : { cmd: '/bin/bash', args: ['-s'] }
  return await new Promise((resolve, reject) => {
    const child = spawn(spec.cmd, spec.args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error(`target script timed out after ${timeoutMs / 1000}s`)) }, timeoutMs)
    child.stdout.on('data', data => { stdout += data })
    child.stderr.on('data', data => { stderr += data })
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('close', code => {
      clearTimeout(timer)
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`target script exited with code ${code}`))
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end(script)
  })
}

/** Physically delete a session's persisted data under $DSH_HOME/sessions (post-archive). */
export async function deleteSessionData(sessionId: string): Promise<string> {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error('invalid session id')
  const script = `
DSH_HOME="\${DSH_HOME:-$HOME/.dsh}"
root="$DSH_HOME/sessions"
[ -d "$root" ] || exit 0
find "$root" -mindepth 2 -maxdepth 2 \\( -name "session-${sessionId}" -o -name "${sessionId}" \\) -print -exec rm -rf {} +
`
  const r = await runTargetShell(script)
  return r.stdout
}
