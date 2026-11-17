/**
 * Bridge discovery v2: the dsh-vscode-bridge plugin (≥0.1.1) publishes one
 * file per process at `$DSH_HOME/vscode-bridge/<pid>.json`. Pure readers +
 * matching logic live here (vscode-free for testability).
 */
import { readdir, readFile } from 'node:fs/promises'

export interface DiscoveryEntry {
  port: number
  token: string
  pid: number
  protocolVersion?: number
  startedAt?: number | string
  /** Host DSH version (bridge ≥ 0.2.1); absent when the plugin cannot detect it. */
  dshVersion?: string
  directories: string[]
  filePath: string
}

/** Read and validate every entry in the discovery directory. Bad files are skipped. */
export async function readDiscoveryDir(dir: string): Promise<DiscoveryEntry[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const out: DiscoveryEntry[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const filePath = `${dir}/${name}`
      const parsed = JSON.parse(await readFile(filePath, 'utf8')) as Partial<DiscoveryEntry>
      if (typeof parsed.port !== 'number' || typeof parsed.token !== 'string' || !parsed.token) continue
      if (!Array.isArray(parsed.directories)) continue // legacy per-workspace entries are incompatible
      out.push({ ...(parsed as DiscoveryEntry), filePath })
    } catch { /* partial write / unreadable: skip */ }
  }
  return out
}

/** Millisecond timestamp for both legacy numeric and current ISO discovery dates. */
function startedAtMillis(value: DiscoveryEntry['startedAt']): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

/**
 * Rank every bridge instance serving `dshCwd` (already expressed in dsh-side
 * path form). Exact directory match; Windows-side comparisons are
 * case-insensitive. Newest valid `startedAt` wins; callers can try the next
 * candidate when a stale discovery file fails its handshake.
 */
export function rankEntries(entries: DiscoveryEntry[], dshCwd: string, caseInsensitive: boolean): DiscoveryEntry[] {
  const norm = (p: string): string => {
    const n = p.replace(/[\\/]+$/, '')
    return caseInsensitive ? n.toLowerCase() : n
  }
  const want = norm(dshCwd)
  return entries.filter(e => e.directories.some(d => norm(d) === want))
    .sort((a, b) => startedAtMillis(b.startedAt) - startedAtMillis(a.startedAt))
}

export function pickEntry(entries: DiscoveryEntry[], dshCwd: string, caseInsensitive: boolean): DiscoveryEntry | undefined {
  return rankEntries(entries, dshCwd, caseInsensitive)[0]
}
