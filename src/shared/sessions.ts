/** Session discovery rows shared by the host and webview. */
export interface SessionRow {
  sessionId: string
  cwd?: string
  title?: string
  updatedAt?: string
  createdAt?: number
  live?: boolean
  origin?: 'subagent'
  parentSession?: string
}

export interface SessionGroups {
  /** Root sessions and ordinary forks, including historical forks with parentSession. */
  sessions: SessionRow[]
  /** Durable subagent sessions; these are never ACP-resumable through the ordinary list. */
  subagents: SessionRow[]
}

/** Split by the explicit origin marker, never by parentSession alone. */
export function partitionSessions(rows: readonly SessionRow[]): SessionGroups {
  return {
    sessions: rows.filter(row => row.origin !== 'subagent'),
    subagents: rows.filter(row => row.origin === 'subagent'),
  }
}

/** Direct children of one main session; nested and foreign-parent rows are excluded. */
export function directSubagents(rows: readonly SessionRow[], parentSessionId: string | undefined): SessionRow[] {
  if (!parentSessionId) return []
  return rows.filter(row => row.origin === 'subagent' && row.parentSession === parentSessionId)
}

export interface SubagentRequestIdentity {
  parentSessionId: string
  sessionId: string
  requestId: number
}

/** Guard async transcript responses against another child, parent, or viewer request. */
export function matchesSubagentRequest(
  expected: SubagentRequestIdentity | undefined,
  actual: SubagentRequestIdentity,
): boolean {
  return expected !== undefined
    && expected.parentSessionId === actual.parentSessionId
    && expected.sessionId === actual.sessionId
    && expected.requestId === actual.requestId
}
