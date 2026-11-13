/** Direct subagents of the current main session; opening one is read-only. */
import React from 'react'
import type { SessionRow } from '../shared/sessions.js'
import { shortSessionId } from './sessionOrder.js'

export function SubagentsPanel(props: {
  rows: SessionRow[]
  onOpen: (row: SessionRow) => void
}): React.JSX.Element {
  return (
    <aside className="sessions subagents-panel">
      <div className="sessions-head">
        <span>子代理</span>
        <span className="spacer" />
        <span className="subagent-count">{props.rows.length}</span>
      </div>
      <div className="sessions-list">
        {props.rows.length === 0 && <div className="hint">No subagents</div>}
        {props.rows.map(row => (
          <button
            key={row.sessionId}
            className="session-row subagent-row"
            title={`${row.title ?? shortSessionId(row.sessionId)}\n${row.sessionId}\n只读查看`}
            onClick={() => props.onOpen(row)}
          >
            <span className="session-title">{row.title ?? shortSessionId(row.sessionId)}</span>
            <span className="subagent-live">{row.live ? '●' : '○'}</span>
          </button>
        ))}
      </div>
    </aside>
  )
}
