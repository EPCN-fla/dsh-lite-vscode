/**
 * VS Code Chat participant: `@dsh <prompt>` in the native Chat view.
 * Owns a dedicated long-lived ACP session (server-side history = multi-turn),
 * pinned to the service generation so agent restarts transparently re-open it.
 */
import * as vscode from 'vscode'
import type { ContentBlock } from '@agentclientprotocol/sdk'
import type { AcpService } from '../acp/service.js'
import type { Launcher } from '../launcher/types.js'
import { autoAttachActiveFile } from '../config.js'

export function registerParticipant(
  service: AcpService,
  getLauncher: () => Launcher,
  out: vscode.OutputChannel,
  extensionUri: vscode.Uri,
): vscode.Disposable {
  let sessionId: string | undefined
  let generation = -1
  let mutex: Promise<unknown> = Promise.resolve()

  const handler: vscode.ChatRequestHandler = async (request, _ctx, stream, token) => {
    // Serialize turns: one prompt in flight per participant session.
    const run = mutex.then(() => turn(request, stream, token)).catch(e => {
      stream.markdown(`\n\n⚠️ ${(e as Error).message.split('\n')[0]}`)
      out.appendLine(`[participant] ${(e as Error).message}`)
    })
    mutex = run
    await run
    return {}
  }

  async function turn(request: vscode.ChatRequest, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<void> {
    await service.ensureClient()

    if (!sessionId || generation !== service.generation) {
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
      if (!cwd) throw new Error('Open a workspace folder first.')
      const res = await service.newSession()
      sessionId = res.sessionId
      generation = service.generation
      out.appendLine(`[participant] session ${sessionId.slice(0, 8)}`)
    }

    const blocks: ContentBlock[] = []
    if (autoAttachActiveFile()) {
      const ed = vscode.window.activeTextEditor
      if (ed?.document.uri.scheme === 'file') {
        const dshPath = await getLauncher().paths.toDsh(ed.document.uri.fsPath)
        blocks.push({ type: 'resource_link', uri: `file://${dshPath}`, name: ed.document.fileName.split(/[\\/]/).pop() ?? 'file' })
      }
    }
    for (const ref of request.references ?? []) {
      const v = ref.value
      if (v instanceof vscode.Uri && v.scheme === 'file') {
        const dshPath = await getLauncher().paths.toDsh(v.fsPath)
        blocks.push({ type: 'resource_link', uri: `file://${dshPath}`, name: v.path.split('/').pop() ?? 'file' })
      }
    }
    blocks.push({ type: 'text', text: request.prompt })

    const sub = service.onUpdate(n => {
      if (n.sessionId !== sessionId) return
      const u = n.update
      if (u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text') stream.markdown(u.content.text)
      else if (u.sessionUpdate === 'tool_call') stream.progress(`🔧 ${u.title ?? 'tool'}`)
    })
    const cancelSub = token.onCancellationRequested(() => { if (sessionId) void service.cancel(sessionId) })
    try {
      await service.prompt(sessionId, blocks)
    } finally {
      sub.dispose()
      cancelSub.dispose()
    }
  }

  const participant = vscode.chat.createChatParticipant('dsh', handler)
  participant.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'icon.svg')
  return participant
}

/** One-shot explain: a fresh ACP session, then closed — works on every topology. */
export async function explainSelection(service: AcpService): Promise<void> {
  const ed = vscode.window.activeTextEditor
  if (!ed || ed.selection.isEmpty) { void vscode.window.showInformationMessage('Select some code first.'); return }
  const text = ed.document.getText(ed.selection)
  const rel = vscode.workspace.asRelativePath(ed.document.uri)
  const prompt = `Explain the following code from ${rel} (lines ${ed.selection.start.line + 1}-${ed.selection.end.line + 1}). Be concise; use markdown.\n\n\`\`\`${ed.document.languageId}\n${text}\n\`\`\``

  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'DSH: explaining selection…', cancellable: false },
    async () => {
      const res = await service.newSession()
      let acc = ''
      const sub = service.onUpdate(n => {
        if (n.sessionId === res.sessionId && n.update.sessionUpdate === 'agent_message_chunk' && n.update.content.type === 'text') acc += n.update.content.text
      })
      try {
        await service.prompt(res.sessionId, [{ type: 'text', text: prompt }])
      } finally {
        sub.dispose()
        await service.closeSession(res.sessionId).catch(() => undefined)
      }
      return acc
    },
  )
  const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: result || '(no explanation returned)' })
  await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside })
}
