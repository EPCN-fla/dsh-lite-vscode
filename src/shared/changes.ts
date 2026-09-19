/** Pure helpers for change tracking (unit-testable, no vscode imports). */
import type { SessionUpdate } from '@agentclientprotocol/sdk'

/** Extract dsh-side absolute file paths from tool_call / tool_call_update diff payloads. */
export function extractDiffPaths(u: SessionUpdate): string[] {
  if (u.sessionUpdate !== 'tool_call' && u.sessionUpdate !== 'tool_call_update') return []
  const content = u.content
  if (!Array.isArray(content)) return []
  const paths: string[] = []
  for (const c of content) {
    if (c.type === 'diff' && typeof c.path === 'string' && c.path.length > 0) paths.push(c.path)
  }
  return paths
}

export interface PorcelainEntry { path: string; created: boolean }

/** Parse `git status --porcelain=v1 -z` output.
 *  With -z, a rename/copy arrives as TWO NUL fields: "XY <new-path>" then "<orig-path>". */
export function parsePorcelainZ(out: string): PorcelainEntry[] {
  const fields = out.split('\0').filter(Boolean)
  const entries: PorcelainEntry[] = []
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]
    if (f.length < 4) continue
    const [x, y] = [f[0], f[1]]
    entries.push({ path: f.slice(3), created: x === '?' || x === 'A' || y === 'A' })
    if ('RC'.includes(x) || 'RC'.includes(y)) i++ // consume the orig-path field
  }
  return entries
}

/** Workspace-relative ignores for the file watcher / git channels. */
export function isIgnoredPath(p: string): boolean {
  return /[/\\](\.git|node_modules|dist|out|\.vscode-test)[/\\]/.test(p)
}
