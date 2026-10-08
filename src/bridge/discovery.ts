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
  startedAt?: number
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

/**
 * Pick the bridge instance serving `dshCwd` (already expressed in dsh-side
 * path form). Exact directory match; Windows-side comparisons are
 * case-insensitive. Multiple hits → newest `startedAt` wins.
 */
export function pickEntry(entries: DiscoveryEntry[], dshCwd: string, caseInsensitive: boolean): DiscoveryEntry | undefined {
  const norm = (p: string): string => {
    const n = p.replace(/[\\/]+$/, '')
    return caseInsensitive ? n.toLowerCase() : n
  }
  const want = norm(dshCwd)
  const hits = entries.filter(e => e.directories.some(d => norm(d) === want))
  hits.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
  return hits[0]
}
