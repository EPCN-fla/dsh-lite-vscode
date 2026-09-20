/** Welcome screen: orca logo + recent sessions of this workspace (click to switch). */
import React from 'react'
import { post } from './vscode.js'
import type { SessionRow } from './SessionsPanel.js'
import { shortSessionId } from './sessionOrder.js'

export function Welcome(props: {
  logoUri?: string
  workspaceName?: string
  sessions: SessionRow[]
}): React.JSX.Element {
  return (
    <div className="welcome">
      {props.logoUri
        ? <span className="welcome-logo" role="img" aria-label="dsh"
            style={{ WebkitMaskImage: `url(${props.logoUri})`, maskImage: `url(${props.logoUri})` }} />
        : null}
      <div className="welcome-sub">{props.workspaceName ?? 'DeepSeek Harness'}</div>
      {props.sessions.length > 0 && (
        <div className="welcome-sessions">
          {props.sessions.slice(0, 4).map(r => (
            <button key={r.sessionId} className="welcome-chip"
              title={r.sessionId}
              onClick={() => post({ type: 'resumeSession', sessionId: r.sessionId })}>
              💬 {r.title ?? shortSessionId(r.sessionId)}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
