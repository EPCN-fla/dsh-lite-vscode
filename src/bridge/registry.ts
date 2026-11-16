/** Online bridge-registry metadata parsing and compatible-version selection. */
import { parseDshVersion, type DshVersion } from './hostVersion.js'

export interface BridgeRegistryEntry {
  version: string
  dshCompatibility?: Record<string, unknown>
  'devDependencies.@deepseek-ai/dsh-agent'?: string
}

export class BridgeRegistryError extends Error {
  constructor(readonly code: 'registry/invalid' | 'registry/no-compatible', message: string) { super(message) }
}

export function formatDshVersion(v: DshVersion): string {
  return `${v.major}.${v.minor}.${v.patch}${v.prerelease ? `-${v.prerelease}` : ''}`
}

/** SemVer precedence, including numeric/string prerelease identifiers. */
export function compareDshVersions(a: DshVersion, b: DshVersion): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
  }
  if (a.prerelease === b.prerelease) return 0
  if (a.prerelease === undefined) return 1
  if (b.prerelease === undefined) return -1
  const left = a.prerelease.split('.')
  const right = b.prerelease.split('.')
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if (left[i] === undefined) return -1
    if (right[i] === undefined) return 1
    if (left[i] === right[i]) continue
    const ln = /^\d+$/.test(left[i])
    const rn = /^\d+$/.test(right[i])
    if (ln && rn) return Number(left[i]) < Number(right[i]) ? -1 : 1
    if (ln !== rn) return ln ? -1 : 1
    return left[i] < right[i] ? -1 : 1
  }
  return 0
}

export function parseBridgeRegistryResponse(text: string): BridgeRegistryEntry[] {
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new BridgeRegistryError('registry/invalid', 'Registry returned malformed JSON') }
  const rows = Array.isArray(value) ? value : [value]
  return rows.filter((row): row is BridgeRegistryEntry => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return false
    const version = (row as { version?: unknown }).version
    return typeof version === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)
  })
}

/** Match the explicit cohort key first. Older packages expose only their DSH
 * development dependency, so exact/caret/tilde/>= specs act as a legacy hint. */
function compatibleWith(host: DshVersion, entry: BridgeRegistryEntry): boolean {
  const hostName = formatDshVersion(host)
  if (entry.dshCompatibility && Object.hasOwn(entry.dshCompatibility, hostName)) return true
  const spec = entry['devDependencies.@deepseek-ai/dsh-agent']?.trim()
  if (!spec) return false
  if (spec === hostName) return true
  const lower = parseDshVersion(spec)
  if (!lower) return false
  if (spec.startsWith('>=')) return compareDshVersions(host, lower) >= 0
  if (spec.startsWith('^') || spec.startsWith('~')) {
    if (compareDshVersions(host, lower) < 0) return false
    const upper: DshVersion = spec.startsWith('^')
      ? lower.major > 0 ? { major: lower.major + 1, minor: 0, patch: 0 }
        : lower.minor > 0 ? { major: 0, minor: lower.minor + 1, patch: 0 }
        : { major: 0, minor: 0, patch: lower.patch + 1 }
      : { major: lower.major, minor: lower.minor + 1, patch: 0 }
    return compareDshVersions(host, upper) < 0
  }
  return false
}

/** Highest compatible SemVer. Stable releases win over prereleases; the
 * highest prerelease is used only when no stable compatible release exists. */
export function selectLatestCompatibleBridge(host: DshVersion, entries: BridgeRegistryEntry[]): string {
  const compatible = entries.filter(entry => compatibleWith(host, entry))
  const stable = compatible.filter(entry => parseDshVersion(entry.version)?.prerelease === undefined)
  const candidates = stable.length > 0 ? stable : compatible
  const sorted = [...candidates].sort((a, b) => {
    const av = parseDshVersion(a.version)
    const bv = parseDshVersion(b.version)
    if (!av || !bv) throw new BridgeRegistryError('registry/invalid', 'Registry returned an invalid bridge version')
    return compareDshVersions(av, bv)
  })
  const selected = sorted.at(-1)
  if (!selected) {
    throw new BridgeRegistryError('registry/no-compatible', `No published bridge declares compatibility with DSH ${formatDshVersion(host)}`)
  }
  const version = parseDshVersion(selected.version)
  if (!version) throw new BridgeRegistryError('registry/invalid', 'Registry returned an invalid bridge version')
  return `dsh-vscode-bridge@${formatDshVersion(version)}`
}
