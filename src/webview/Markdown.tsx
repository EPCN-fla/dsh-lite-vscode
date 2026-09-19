/** Minimal safe markdown rendering for assistant messages. */
import React, { useMemo } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

marked.setOptions({ gfm: true, breaks: true })

export function Markdown({ text }: { text: string }): React.JSX.Element {
  const html = useMemo(() => {
    const raw = marked.parse(text, { async: false })
    return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } })
  }, [text])
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />
}
