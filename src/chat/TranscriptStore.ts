/** Per-session JSON transcript cache: compensates ACP resume not replaying history. */
import * as vscode from 'vscode'
import type { ChatMessage } from '../shared/chat.js'

export class TranscriptStore {
  private dir: vscode.Uri
  private writes = new Map<string, Promise<void>>()
  private deleted = new Set<string>()

  constructor(ctx: vscode.ExtensionContext) {
    this.dir = vscode.Uri.joinPath(ctx.globalStorageUri, 'sessions')
  }

  private file(sessionId: string): vscode.Uri {
    return vscode.Uri.joinPath(this.dir, `${sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`)
  }

  async load(sessionId: string): Promise<ChatMessage[] | undefined> {
    if (this.deleted.has(sessionId)) return undefined
    try {
      const raw = await vscode.workspace.fs.readFile(this.file(sessionId))
      const parsed = JSON.parse(Buffer.from(raw).toString('utf8'))
      return Array.isArray(parsed) ? parsed as ChatMessage[] : undefined
    } catch {
      return undefined
    }
  }

  async delete(sessionId: string): Promise<void> {
    this.deleted.add(sessionId)
    const previous = this.writes.get(sessionId) ?? Promise.resolve()
    const next = previous.then(async () => {
      try { await vscode.workspace.fs.delete(this.file(sessionId)) } catch { /* never cached */ }
    })
    this.writes.set(sessionId, next)
    await next
  }

  /** Serialized writes; a delete tombstones every earlier or later writer. */
  save(sessionId: string, messages: ChatMessage[]): Promise<void> {
    if (this.deleted.has(sessionId)) return Promise.resolve()
    const prev = this.writes.get(sessionId) ?? Promise.resolve()
    const next = prev.then(async () => {
      if (this.deleted.has(sessionId)) return
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
