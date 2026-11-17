/** Online bridge-registry metadata parsing and compatible-version selection. */
import semver from 'semver'
import { isTestedHostVersion, parseDshVersion, type DshVersion } from './hostVersion.js'

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

/** A stable host already covered by hostVersion's tested cohorts may use the
 * matching `x.y.z-rc.N` metadata. Unknown stable versions never get this alias. */
function sameTestedReleaseCohort(host: DshVersion, candidate: DshVersion): boolean {
  return host.prerelease === undefined
    && candidate.major === host.major && candidate.minor === host.minor && candidate.patch === host.patch
    && /^rc\.\d+$/.test(candidate.prerelease ?? '')
    && isTestedHostVersion(host)
}

/** Match the explicit cohort key first. Older packages expose only their DSH
 * development dependency, evaluated with node-semver's prerelease semantics. */
function compatibleWith(host: DshVersion, entry: BridgeRegistryEntry): boolean {
  const hostName = formatDshVersion(host)
  if (entry.dshCompatibility) {
    if (Object.hasOwn(entry.dshCompatibility, hostName)) return true
    return Object.keys(entry.dshCompatibility).some(key => {
      const candidate = parseDshVersion(key)
      return candidate !== undefined && sameTestedReleaseCohort(host, candidate)
    })
  }
  const spec = entry['devDependencies.@deepseek-ai/dsh-agent']?.trim()
  if (!spec) return false
  if (spec === hostName) return true
  const specVersion = parseDshVersion(spec)
  if (specVersion && sameTestedReleaseCohort(host, specVersion)) return true
  try { return semver.satisfies(hostName, spec, { includePrerelease: false }) } catch { return false }
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
