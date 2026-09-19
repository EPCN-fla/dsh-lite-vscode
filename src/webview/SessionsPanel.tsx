/** In-webview sessions sidebar: click to resume; rename/delete appear when the
 *  dsh-vscode-bridge plugin reports the corresponding capabilities. */
import React, { useState } from 'react'
import { post } from './vscode.js'

export interface SessionRow { sessionId: string; cwd?: string; title?: string; updatedAt?: string }

export function SessionsPanel(props: {
  rows: (SessionRow & { active: boolean })[]
  canRename?: boolean
  canDelete?: boolean
}): React.JSX.Element {
  const [renaming, setRenaming] = useState<string | undefined>(undefined)
  const [draft, setDraft] = useState('')
  const [confirming, setConfirming] = useState<string | undefined>(undefined)

  const commitRename = (id: string): void => {
    post({ type: 'renameSession', sessionId: id, title: draft })
    setRenaming(undefined)
  }
  const onDelete = (id: string): void => {
    if (confirming === id) { post({ type: 'deleteSession', sessionId: id }); setConfirming(undefined) }
    else { setConfirming(id); setTimeout(() => setConfirming(c => (c === id ? undefined : c)), 3000) }
  }
  const { rows } = props
  return (
    <aside className="sessions">
      <div className="sessions-head">
        <span>Sessions</span>
        <span className="spacer" />
        <button className="icon-btn" title="Refresh" onClick={() => post({ type: 'listSessions' })}>⟳</button>
      </div>
      <div className="sessions-list">
        {rows.length === 0 && <div className="hint">No sessions yet</div>}
        {rows.map(r => (
          <div key={r.sessionId} className={`session-row${r.active ? ' active' : ''}`}
            title={`${r.sessionId}${r.updatedAt ? `\n${r.updatedAt}` : ''}`}
            onClick={() => !r.active && post({ type: 'resumeSession', sessionId: r.sessionId })}>
            {renaming === r.sessionId ? (
              <input
                className="session-rename" autoFocus value={draft}
                onChange={e => setDraft(e.target.value)}
                onBlur={() => commitRename(r.sessionId)}
                onKeyDown={e => { if (e.key === 'Enter') commitRename(r.sessionId); if (e.key === 'Escape') setRenaming(undefined) }}
                onClick={e => e.stopPropagation()}
              />
            ) : (
              <span className="session-title"
                onDoubleClick={e => { if (props.canRename) { e.stopPropagation(); setRenaming(r.sessionId); setDraft(r.title ?? '') } }}>
                {r.active ? '● ' : ''}{r.title ?? r.sessionId.slice(0, 8)}
              </span>
            )}
            {(props.canRename || props.canDelete) && (
              <span className="session-actions" onClick={e => e.stopPropagation()}>
                {props.canRename && <button className="icon-btn" title="Rename" onClick={() => { setRenaming(r.sessionId); setDraft(r.title ?? '') }}>✎</button>}
                {props.canDelete && (
                  <button className={`icon-btn${confirming === r.sessionId ? ' danger' : ''}`}
                    title={confirming === r.sessionId ? 'Click again to confirm archival' : 'Delete (archive)'}
                    onClick={() => onDelete(r.sessionId)}>
                    {confirming === r.sessionId ? 'sure?' : '🗑'}
                  </button>
                )}
              </span>
            )}
          </div>
        ))}
      </div>
    </aside>
  )
}
