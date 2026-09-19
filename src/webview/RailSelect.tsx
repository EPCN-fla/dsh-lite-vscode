/** Rail select: text-button trigger + pop-up menu (same look as the permission picker).
 *  Replaces native <select>: width follows the current label, groups/disabled supported. */
import React, { useEffect, useRef, useState } from 'react'
import type { SelectOption } from '../shared/model.js'

export function RailSelect(props: {
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  title?: string
  align?: 'left' | 'right'
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLSpanElement>(null)
  const current = props.options.find(o => o.value === props.value)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const groups = new Map<string, SelectOption[]>()
  for (const o of props.options) groups.set(o.group ?? '', [...(groups.get(o.group ?? '') ?? []), o])

  return (
    <span className="rail-select-wrap" ref={wrapRef}>
      <button className="rail-select" title={props.title} onClick={() => setOpen(v => !v)}>
        <span className="rail-select-label">{current?.label ?? '—'}</span>
        <span className="rail-select-chev">▾</span>
      </button>
      {open && (
        <div className={`rail-menu ${props.align === 'right' ? 'right' : 'left'}`}>
          {[...groups.entries()].map(([g, opts]) => (
            <div key={g} className="rail-menu-group">
              {g && <div className="rail-menu-group-title">{g}</div>}
              {opts.map(o => (
                <div key={o.value}
                  className={`rail-menu-item${o.value === props.value ? ' current' : ''}${o.disabled ? ' disabled' : ''}`}
                  title={o.hint ?? o.description ?? ''}
                  onClick={() => { if (o.disabled) return; setOpen(false); props.onChange(o.value) }}>
                  <span className="rail-menu-check">{o.value === props.value ? '✓' : ''}</span>
                  <span className="rail-menu-label">{o.label}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </span>
  )
}
