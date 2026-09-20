/** Renderable chat message model shared by the webview renderer and the host-side transcript store. */
export type ChatMessage =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'thought'; text: string }
  | { kind: 'tool'; id: string; title: string; subtitle?: string; toolKind?: string; status?: string; detail?: string }
  | { kind: 'system'; text: string }
  | { kind: 'todo'; items: { content: string; status: string }[] }
  | { kind: 'error'; text: string }
