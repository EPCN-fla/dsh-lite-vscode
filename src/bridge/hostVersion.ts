/** Host dsh version helpers — pure and vscode-free for testability. */

/** Bridge package line matching the current corridor (DSH 0.1.7 / 0.2.0 hosts). */
export const BRIDGE_SPEC_CURRENT = 'dsh-vscode-bridge@^0.3.0'
/** Bridge package line for legacy hosts: bridge 0.3.0 moved DSH ≤ 0.1.6 out of
 *  its support corridor, so those hosts stay on the 0.2.x line. The boundary
 *  mirrors the installer's cordis.patch.yml variant dispatch (0.0.* / 0.1.0-6
 *  take the legacy rows). */
export const BRIDGE_SPEC_LEGACY = 'dsh-vscode-bridge@^0.2.0'

export interface DshVersion {
  readonly major: number
  readonly minor: number
  readonly patch: number
  readonly prerelease?: string
}

/** Extract the first semver (`0.2.0-rc.2`) from free text such as `dsh --version`
 *  output or the bridge's dshVersion field. Undefined when nothing parses. */
export function parseDshVersion(text: string | undefined): DshVersion | undefined {
  const m = text?.match(/(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/)
  if (!m) return undefined
  return { major: +m[1], minor: +m[2], patch: +m[3], ...(m[4] === undefined ? {} : { prerelease: m[4] }) }
}

/** The host cohorts the extension is tested against (see the README version matrix). */
export function isTestedHostVersion(v: DshVersion): boolean {
  return v.major === 0 && ((v.minor === 1 && (v.patch === 5 || v.patch === 7)) || (v.minor === 2 && v.patch === 0))
}

/** Bridge package spec to pre-fill in the install flow for a host dsh version.
 *  Unknown/unparseable versions take the current line — same default as a fresh
 *  install on a new host. */
export function bridgeSpecForHost(v: DshVersion | undefined): string {
  if (v && v.major === 0 && (v.minor === 0 || (v.minor === 1 && v.patch <= 6))) return BRIDGE_SPEC_LEGACY
  return BRIDGE_SPEC_CURRENT
}
