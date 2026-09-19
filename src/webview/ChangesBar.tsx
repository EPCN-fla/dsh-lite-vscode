/** Collapsible "agent changed files" strip above the composer. */
import React, { useState } from 'react'
import { post } from './vscode.js'

export function ChangesBar({ files }: { files: { path: string; label: string; kind: 'created' | 'modified' }[] }): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  if (files.length === 0) return null
  return (
    <div className="changes">
      <button className="changes-toggle" onClick={() => setOpen(v => !v)}>
        📝 {files.length} file{files.length > 1 ? 's' : ''} changed {open ? '▾' : '▸'}
      </button>
      {open && (
        <div className="changes-list">
          {files.map(f => (
            <div key={f.path} className="changes-row" title={f.path}
              onClick={() => post({ type: 'openDiff', path: f.path })}>
              <span className={`changes-kind ${f.kind}`}>{f.kind === 'created' ? 'A' : 'M'}</span>
              <span className="changes-label">{f.label}</span>
              <span className="changes-open">diff ⇗</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
