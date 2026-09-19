/** Run a POSIX shell script on the TARGET side (where dsh runs). Best-effort utility. */
import { execFile } from 'node:child_process'
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
