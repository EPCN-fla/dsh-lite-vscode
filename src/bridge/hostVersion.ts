/** Host dsh version helpers — pure and vscode-free for testability. */

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

/** Recognized host cohorts (historical extension tests + bridge 0.4/0.5 host matrix). */
export function isTestedHostVersion(v: DshVersion): boolean {
  if (v.major !== 0) return false
  if (v.minor === 1) return v.patch === 5 || v.patch === 7
  if (v.minor !== 2) return false
  if (v.patch === 0) return true
  if (v.patch === 1) return /^rc\.\d+$/.test(v.prerelease ?? '')
  return v.patch === 2 && (v.prerelease === 'rc.1' || v.prerelease === 'rc.2' || v.prerelease === 'rc.3')
}
