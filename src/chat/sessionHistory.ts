/**
 * Rebuild a session's display transcript from its durable dsh log, exported
 * through the bridge's `session.exportZip` (v0.1.3+). ACP `session/resume`
 * does not replay history and the local transcript cache only knows sessions
 * this client created — without this import, switching to a session built in
 * the Web UI renders as an empty chat ("unreadable").
 *
 * The export archive carries the root log as canonical JSONL (one header
 * line, then one event per line) plus attachments; only the root
 * `session[.vN].jsonl` is this session's own transcript.
 */
import { unzipSync, strFromU8 } from 'fflate'
import type { ChatMessage } from '../shared/chat.js'
import type { BridgeClient } from '../bridge/client.js'
import type { PathMapper } from '../launcher/types.js'
import { toolSubtitle } from '../webview/state.js'

/** Skip pathological exports instead of blowing up the webview cache. */
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024
/** Bound one tool result's rendered text (live updates stream these too, but
 *  history imports them all at once). */
const MAX_RESULT_CHARS = 100_000

interface LogEvent { type?: string; data?: Record<string, unknown> }
interface Block { type?: string; text?: string; [k: string]: unknown }

function textOf(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  return (blocks as Block[]).filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text as string).join('')
}

/**
 * Convert the canonical JSONL of one session log into renderable messages.
 * Pure and format-tolerant: unknown lines (the header, request markers,
 * turn/step boundaries, future event types) are skipped.
 */
export function parseSessionLog(jsonl: string): ChatMessage[] {
  const messages: ChatMessage[] = []
  const tools = new Map<string, Extract<ChatMessage, { kind: 'tool' }>>()
  for (const raw of jsonl.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    let ev: LogEvent
    try { ev = JSON.parse(line) as LogEvent } catch { continue }
    if (!ev || typeof ev.type !== 'string' || !ev.data) continue
    switch (ev.type) {
      case 'user/message': {
        const msg = ev.data as { content?: Block[]; source?: { kind?: string } }
        // Injected/plugin context (file notices, skill payloads, model-switch
        // notices) is model-facing only — the user never typed it, and the
        // live ACP stream never projects it either.
        if (msg.source?.kind !== 'user') continue
        const parts: string[] = []
        for (const b of msg.content ?? []) {
          if (b?.type === 'text' && typeof b.text === 'string') parts.push(b.text)
          else if (b?.type === 'image') parts.push('🖼 image')
          else if (b?.type === 'file') {
            const name = (b.attachment as { name?: string; fileName?: string } | undefined)?.name
              ?? (b.attachment as { fileName?: string } | undefined)?.fileName ?? 'file'
            parts.push(`📄 ${name}`)
          }
        }
        const text = parts.join('\n').trim()
        if (text) messages.push({ kind: 'user', text })
        continue
      }
      case 'assistant/message': {
        const content = (ev.data as { message?: { content?: Block[] } }).message?.content ?? []
        for (const b of content) {
          if (b?.type === 'reasoning' && typeof b.text === 'string' && b.text) messages.push({ kind: 'thought', text: b.text })
          else if (b?.type === 'text' && typeof b.text === 'string' && b.text) messages.push({ kind: 'assistant', text: b.text })
        }
        continue
      }
      case 'tool/call': {
        const d = ev.data as { callId?: string; name?: string; arguments?: string }
        if (!d.callId) continue
        let input: unknown = d.arguments
        try { input = JSON.parse(d.arguments ?? '') } catch { /* keep the raw string */ }
        const tool: Extract<ChatMessage, { kind: 'tool' }> = {
          kind: 'tool',
          id: d.callId,
          title: d.name ?? 'tool',
          subtitle: toolSubtitle(input),
          status: 'in_progress',
          input,
        }
        tools.set(d.callId, tool)
        messages.push(tool)
        continue
      }
      case 'tool/result': {
        const block = (ev.data as { message?: { content?: Block[] } }).message?.content?.[0] as
          | { type?: string; toolCallId?: string; content?: Block[]; isError?: boolean }
          | undefined
        if (block?.type !== 'tool-result' || !block.toolCallId) continue
        const tool = tools.get(block.toolCallId)
        if (!tool) continue
        tool.status = block.isError === true ? 'failed' : 'completed'
        const detail = textOf(block.content)
        if (detail) tool.detail = detail.length > MAX_RESULT_CHARS ? `${detail.slice(0, MAX_RESULT_CHARS)}\n… (truncated)` : detail
        continue
      }
      default:
        continue
    }
  }
  return messages
}

/**
 * Export one session's log through the bridge and convert it. Returns
 * undefined when the archive is unreadable, oversized, or has no root log —
 * the caller then keeps its current (empty) transcript.
 */
export async function importDshTranscript(
  sessionId: string,
  bridge: BridgeClient,
  paths: PathMapper,
  readFile: (path: string) => Promise<Uint8Array>,
): Promise<ChatMessage[] | undefined> {
  const res = await bridge.request<{ path: string; fileName: string; bytes: number }>(
    'session.exportZip', { sessionId },
  )
  if (typeof res.path !== 'string' || typeof res.bytes !== 'number' || res.bytes > MAX_ARCHIVE_BYTES) return undefined
  const hostPath = await paths.fromDsh(res.path).catch(() => res.path)
  const entries = unzipSync(await readFile(hostPath))
  const rootName = Object.keys(entries).find(n => /^session(?:\.v\d+)?\.jsonl$/.test(n))
  if (!rootName) return undefined
  return parseSessionLog(strFromU8(entries[rootName]))
}
