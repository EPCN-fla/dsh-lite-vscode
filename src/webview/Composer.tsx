/** Composer with @-mention file completion and a Web-UI-style slash-command
 *  menu: typing "/" opens the command picker, typing "@query" the file picker. */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { post } from './vscode.js'
import { filterSlashCommands, type SlashCommand } from './slash.js'

export interface FilePick { path: string; label: string }

export function Composer(props: {
  busy: boolean
  sessionStarted: boolean
  results: FilePick[]
  slashCommands: SlashCommand[]
  railLeft?: React.ReactNode
  railRightExtra?: React.ReactNode
  onQueryFiles: (reqId: number, query: string) => void
  onSend: (text: string) => void
}): React.JSX.Element {
  const [input, setInput] = useState('')
  const [atState, setAtState] = useState<{ start: number; query: string; reqId: number } | undefined>(undefined)
  const [sel, setSel] = useState(0)
  const [slash, setSlash] = useState<{ query: string } | undefined>(undefined)
  const [slashSel, setSlashSel] = useState(0)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const reqSeq = useRef(0)
  const debounce = useRef<ReturnType<typeof setTimeout>>(undefined)

  const closeAt = useCallback(() => setAtState(undefined), [])
  const closeSlash = useCallback(() => setSlash(undefined), [])

  const detectAt = (text: string, caret: number): void => {
    if (text.startsWith('/')) { closeAt(); return } // slash menu owns the leading token
    const before = text.slice(0, caret)
    const m = /(^|\s)@([^\s@]*)$/.exec(before)
    if (!m) { closeAt(); return }
    const query = m[2]
    const start = caret - query.length - 1
    setAtState({ start, query, reqId: -1 })
    clearTimeout(debounce.current)
    debounce.current = setTimeout(() => {
      const reqId = ++reqSeq.current
      setAtState(st => (st && st.query === query ? { ...st, reqId } : st))
      props.onQueryFiles(reqId, query)
    }, 150)
  }

  /** Slash menu: open while the whole input is a single "/token" (no space yet). */
  const detectSlash = (text: string): void => {
    const m = /^\/(\S*)$/.exec(text)
    setSlash(m ? { query: m[1] } : undefined)
  }

  const slashItems = slash ? filterSlashCommands(props.slashCommands, slash.query) : []

  const pick = (f: FilePick): void => {
    if (!atState) return
    // Remove the `@query` text; the chip carries the reference.
    const next = input.slice(0, atState.start) + input.slice(atState.start + atState.query.length + 1)
    setInput(next)
    post({ type: 'addChip', path: f.path, label: f.label })
    closeAt()
    taRef.current?.focus()
  }

  const runSlash = (cmd: SlashCommand): void => {
    closeSlash()
    switch (cmd.name) {
      case 'file':
        setInput('@')
        detectAt('@', 1)
        taRef.current?.focus()
        return
      case 'image':
        setInput('')
        post({ type: 'pickImages' })
        return
      case 'model':
      case 'effort':
      case 'permission':
        setInput('')
        post({ type: 'commandPicker', kind: cmd.name })
        return
      case 'new':
        setInput('')
        post({ type: 'newSession' })
        return
    }
  }

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = Array.from(e.clipboardData?.files ?? []).filter(f => f.type.startsWith('image/'))
    if (files.length === 0) return
    e.preventDefault()
    for (const f of files) {
      const reader = new FileReader()
      reader.onload = () => {
        const dataUrl = String(reader.result)
        post({ type: 'pasteImage', name: f.name || 'pasted-image.png', mimeType: f.type, data: dataUrl.split(',')[1] ?? '' })
      }
      reader.readAsDataURL(f)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (slash) {
      if (slashItems.length > 0) {
        if (e.key === 'ArrowDown') { e.preventDefault(); setSlashSel(i => (i + 1) % slashItems.length); return }
        if (e.key === 'ArrowUp') { e.preventDefault(); setSlashSel(i => (i - 1 + slashItems.length) % slashItems.length); return }
        if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); runSlash(slashItems[Math.min(slashSel, slashItems.length - 1)]); return }
      }
      if (e.key === 'Escape') { e.preventDefault(); closeSlash(); return }
    }
    if (atState && props.results.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSel(i => (i + 1) % props.results.length); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSel(i => (i - 1 + props.results.length) % props.results.length); return }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(props.results[Math.min(sel, props.results.length - 1)]); return }
      if (e.key === 'Escape') { e.preventDefault(); closeAt(); return }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      const text = input.trim()
      if (text && !props.busy) { setInput(''); props.onSend(text) }
    }
  }

  useEffect(() => setSel(0), [props.results])
  useEffect(() => setSlashSel(0), [slash?.query])

  return (
    <footer className="composer">
      {atState && props.results.length > 0 && (
        <div className="at-dropdown">
          {props.results.map((f, i) => (
            <div key={f.path} className={`at-item${i === sel ? ' sel' : ''}`}
              onMouseDown={e => { e.preventDefault(); pick(f) }}
              onMouseEnter={() => setSel(i)}>
              📄 {f.label}
            </div>
          ))}
        </div>
      )}
      {slash && slashItems.length > 0 && (
        <div className="at-dropdown slash-dropdown">
          {slashItems.map((c, i) => (
            <div key={c.name} className={`at-item slash-item${i === slashSel ? ' sel' : ''}`}
              onMouseDown={e => { e.preventDefault(); runSlash(c) }}
              onMouseEnter={() => setSlashSel(i)}>
              <span className="slash-icon">{c.icon}</span>
              <span className="slash-label">{c.label}</span>
              <span className="slash-name">{c.name}</span>
              <span className="slash-desc">{c.description}</span>
            </div>
          ))}
        </div>
      )}
      <textarea
        ref={taRef}
        value={input}
        placeholder={props.sessionStarted ? 'Ask dsh…  (@ files, / commands, Enter to send)' : 'Ask dsh to start a session…'}
        onChange={e => { setInput(e.target.value); detectAt(e.target.value, e.target.selectionStart ?? e.target.value.length); detectSlash(e.target.value) }}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onBlur={() => setTimeout(() => { closeAt(); closeSlash() }, 150)}
        rows={Math.min(8, input.split('\n').length + 1)}
      />
      <div className="rail">
        {props.railLeft}
        <span className="spacer" />
        {props.railRightExtra}
        {props.busy
          ? <button className="send stop" title="Stop" onClick={() => post({ type: 'cancel' })}>■</button>
          : <button className="send" title="Send" disabled={!input.trim()} onClick={() => { const t = input.trim(); if (t) { setInput(''); props.onSend(t) } }}>➤</button>}
      </div>
    </footer>
  )
}
