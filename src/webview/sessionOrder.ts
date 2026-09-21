/** Stable session ordering for the sidebar.
 *
 *  dsh's session/list is newest-first and excludes the ACTIVE session.
 *  Two operations are kept separate (an earlier version merged them and the
 *  render-time merge with an empty server list wiped every row but the active):
 *
 *  - mergeSessions(): fold a fresh server list into the remembered order.
 *    Server rows keep positions; unseen ids prepend (newest-first); the active
 *    id is never evicted even though the server omits it.
 *  - ensureActive(): when the active session id changes (new/resume), insert it
 *    if missing — brand-new sessions land on top.
 */
import type { SessionRow } from './SessionsPanel.js'

/** dsh session ids are `session-<uuid>`; a bare slice shows the literal
 *  "session-" header, so the id fallback displays the meaningful slice. */
export function shortSessionId(id: string): string {
  const stripped = id.replace(/^session-/, '')
  // Degenerate ids (literally "session-") keep the raw form over an empty label.
  return stripped ? stripped.slice(0, 8) : id
}

export interface SessionOrdering {
  order: string[]
  byId: Map<string, SessionRow>
}

export function mergeSessions(prev: SessionOrdering, incoming: SessionRow[], activeId: string | undefined): SessionOrdering {
  const byId = new Map(prev.byId)
  for (const r of incoming) {
    const prev = byId.get(r.sessionId)
    // Stored rows arrive title-less; never let that erase a title we already know.
    byId.set(r.sessionId, { ...r, title: r.title ?? prev?.title })
  }

  const incomingIds = new Set(incoming.map(r => r.sessionId))
  const kept = prev.order.filter(id => incomingIds.has(id) || id === activeId)
  const fresh = incoming.filter(r => !kept.includes(r.sessionId)).map(r => r.sessionId)
  // A brand-new active session sits at the head and is absent from the server
  // list (it is active); keep it at the head instead of letting fresh server
  // rows push it down. Once persisted it appears in incoming on its own.
  if (activeId && !incomingIds.has(activeId) && kept[0] === activeId) {
    return { order: [activeId, ...fresh, ...kept.slice(1)], byId }
  }
  return { order: [...fresh, ...kept], byId }
}

export function ensureActive(prev: SessionOrdering, activeId: string | undefined): SessionOrdering {
  if (!activeId || prev.order.includes(activeId)) return prev
  return { order: [activeId, ...prev.order], byId: prev.byId }
}

export function toRows(o: SessionOrdering, activeId: string | undefined): (SessionRow & { active: boolean })[] {
  return o.order
    .map(id => o.byId.get(id) ?? { sessionId: id })
    .map(r => ({ ...r, active: r.sessionId === activeId }))
}
