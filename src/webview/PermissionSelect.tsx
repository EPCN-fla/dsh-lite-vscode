/** Permission preset selector: shield trigger + popup menu (Codex/DSH-Web style). */
import React, { useEffect, useRef, useState } from 'react'
import { post } from './vscode.js'

const GLYPH: Record<string, string> = {
  'read-only': '🛈',
  'workspace-write': '✎',
  'danger-full-access': '⚠',
}

export function PermissionSelect(props: {
  options: { value: string; name: string; description?: string }[]
  current?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLSpanElement>(null)
  const current = props.options.find(o => o.value === props.current)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  return (
    <span className="permission-wrap" ref={wrapRef}>
      <button
        className="permission-trigger"
        title={`Permissions: ${current?.name ?? 'default'}`}
        onClick={() => setOpen(v => !v)}
      >
        🛡{current ? <span className="permission-glyph">{GLYPH[current.value] ?? ''}</span> : null}
      </button>
      {open && (
        <div className="permission-menu">
          {props.options.map(o => (
            <div key={o.value} className={`pm-item${o.value === props.current ? ' current' : ''}`}
              title={o.description ?? ''}
              onClick={() => { setOpen(false); post({ type: 'setPermission', name: o.value }) }}>
              <span className="pm-glyph">{GLYPH[o.value] ?? '•'}</span>
              <span>{o.name}</span>
              {o.value === props.current ? <span className="pm-check">✓</span> : null}
            </div>
          ))}
        </div>
      )}
    </span>
  )
}
