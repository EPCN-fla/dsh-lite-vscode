/**
 * MCP server configuration: settings parsing + a native QuickPick/InputBox flow.
 * Servers are stored in the `dsh.mcpServers` setting and mounted on every NEW
 * session (ACP session/new mcpServers; existing sessions are unaffected).
 */
import * as vscode from 'vscode'
import type { McpServer } from '@agentclientprotocol/sdk'

/** Parse the dsh.mcpServers setting into ACP McpServer entries, dropping invalid rows. */
export function parseMcpServers(raw: unknown): McpServer[] {
  if (!Array.isArray(raw)) return []
  const out: McpServer[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const it = item as Record<string, unknown>
    if (typeof it.name !== 'string' || !it.name) continue
    if (it.type === 'http' && typeof it.url === 'string') {
      const headers = Array.isArray(it.headers)
        ? (it.headers as unknown[]).filter((h): h is { name: string; value: string } =>
            typeof h === 'object' && h !== null
            && typeof (h as { name?: unknown }).name === 'string'
            && typeof (h as { value?: unknown }).value === 'string')
        : []
      out.push({ type: 'http', name: it.name, url: it.url, headers } as McpServer)
    } else if (typeof it.command === 'string') {
      const env: { name: string; value: string }[] = []
      if (typeof it.env === 'object' && it.env !== null) {
        for (const [k, v] of Object.entries(it.env as Record<string, unknown>)) {
          if (typeof v === 'string') env.push({ name: k, value: v })
        }
      }
      out.push({
        name: it.name,
        command: it.command,
        args: Array.isArray(it.args) ? it.args.filter((a): a is string => typeof a === 'string') : [],
        env,
      } as McpServer)
    }
  }
  return out
}

/** Interactive native flow: list / add stdio / add HTTP / remove. */
export async function configureMcpFlow(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('dsh')
  const current = (): unknown[] => cfg.get<unknown[]>('mcpServers', [])

  for (;;) {
    const list = current()
    const items: (vscode.QuickPickItem & { action?: string; index?: number })[] = [
      { label: '$(add) Add stdio server…', action: 'add-stdio' },
      { label: '$(add) Add HTTP server…', action: 'add-http' },
      ...list.map((srv, i) => {
        const r = srv as Record<string, unknown>
        return {
          label: `$(plug) ${String(r.name ?? '?')} — ${r.type === 'http' ? String(r.url ?? '') : String(r.command ?? '')}`,
          description: '',
          action: 'remove',
          index: i,
        }
      }),
    ]
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'dsh MCP servers (mounted on new sessions)' })
    if (!pick) return

    if (pick.action === 'remove' && pick.index !== undefined) {
      const next = list.filter((_, i) => i !== pick.index)
      await cfg.update('mcpServers', next, vscode.ConfigurationTarget.Global)
      continue
    }
    if (pick.action === 'add-stdio') {
      const name = await vscode.window.showInputBox({ prompt: 'Server name', placeHolder: 'e.g. filesystem' })
      if (!name) continue
      const command = await vscode.window.showInputBox({ prompt: 'Command (absolute path for stdio servers)', placeHolder: 'e.g. npx' })
      if (!command) continue
      const argsRaw = await vscode.window.showInputBox({ prompt: 'Arguments (space-separated, optional)', placeHolder: '-y @modelcontextprotocol/server-filesystem /path' })
      const args = argsRaw?.trim() ? argsRaw.trim().split(/\s+/) : []
      await cfg.update('mcpServers', [...list, { name, command, args }], vscode.ConfigurationTarget.Global)
      void vscode.window.showInformationMessage(`DSH: MCP server "${name}" added — it attaches to NEW sessions.`)
      continue
    }
    if (pick.action === 'add-http') {
      const name = await vscode.window.showInputBox({ prompt: 'Server name', placeHolder: 'e.g. remote-tools' })
      if (!name) continue
      const url = await vscode.window.showInputBox({ prompt: 'HTTP(S) URL', placeHolder: 'https://example.com/mcp' })
      if (!url) continue
      await cfg.update('mcpServers', [...list, { name, type: 'http', url, headers: [] }], vscode.ConfigurationTarget.Global)
      void vscode.window.showInformationMessage(`DSH: MCP server "${name}" added — it attaches to NEW sessions.`)
      continue
    }
  }
}
