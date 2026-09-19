/** Per-session JSON transcript cache: compensates ACP resume not replaying history. */
import * as vscode from 'vscode'
import type { ChatMessage } from '../shared/chat.js'

export class TranscriptStore {
  private dir: vscode.Uri
  private writes = new Map<string, Promise<void>>()

  constructor(ctx: vscode.ExtensionContext) {
    this.dir = vscode.Uri.joinPath(ctx.globalStorageUri, 'sessions')
  }

  private file(sessionId: string): vscode.Uri {
    return vscode.Uri.joinPath(this.dir, `${sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`)
  }

  async load(sessionId: string): Promise<ChatMessage[] | undefined> {
    try {
      const raw = await vscode.workspace.fs.readFile(this.file(sessionId))
      const parsed = JSON.parse(Buffer.from(raw).toString('utf8'))
      return Array.isArray(parsed) ? parsed as ChatMessage[] : undefined
    } catch {
      return undefined
    }
  }

  async delete(sessionId: string): Promise<void> {
    try { await vscode.workspace.fs.delete(this.file(sessionId)) } catch { /* never cached */ }
  }

  /** Serialized, fire-and-forget safe writes (latest wins per session). */
  save(sessionId: string, messages: ChatMessage[]): Promise<void> {
    const prev = this.writes.get(sessionId) ?? Promise.resolve()
    const next = prev.then(async () => {
      try {
        await vscode.workspace.fs.createDirectory(this.dir)
        await vscode.workspace.fs.writeFile(this.file(sessionId), Buffer.from(JSON.stringify(messages)))
      } catch (e) {
        console.error('[dsh] transcript save failed:', e)
      }
    })
    this.writes.set(sessionId, next)
    return next
  }
}
