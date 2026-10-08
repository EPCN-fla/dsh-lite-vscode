import * as vscode from 'vscode'
import type { DshConfig } from './launcher/types.js'

export function readConfig(): DshConfig {
  const c = vscode.workspace.getConfiguration('dsh')
  return {
    runtime: c.get<'auto' | 'wsl' | 'windows'>('runtime', 'auto'),
    profile: c.get<string>('profile', 'acp-vscode'),
    command: c.get<string>('command', 'npx -y @deepseek-ai/dsh'),
    wslDistro: c.get<string>('wsl.distro', ''),
    env: c.get<Record<string, string>>('env', {}),
  }
}

export function autoAttachActiveFile(): boolean {
  return vscode.workspace.getConfiguration('dsh').get<boolean>('autoAttachActiveFile', false)
}
