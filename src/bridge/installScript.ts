/** Pure target-side install script builder (unit-testable, no vscode imports). */
import { posixBootstrap } from '../launcher/shellenv.js'

/**
 * Target-side host-version probe for the install flow: prints the first
 * semver `dsh --version` mentions (empty output when undetectable, e.g. dsh
 * not installed yet). The bootstrap makes version-manager node/npx visible
 * to the non-login shell, exactly like the installer's own probe.
 */
export function buildVersionProbeScript(command: string): string {
  return `${posixBootstrap()}; ${command} --version 2>/dev/null | grep -oE '[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.-]+)?' | head -n1`
}

/** One registry request carrying both modern compatibility metadata and the
 * legacy DSH development dependency used by pre-dshCompatibility packages. */
export function buildBridgeRegistryQueryScript(): string {
  return `${posixBootstrap()}; npm view 'dsh-vscode-bridge@>=0.1.1' version dshCompatibility devDependencies.@deepseek-ai/dsh-agent --json --fetch-retries=1 --fetch-retry-mintimeout=1000 --fetch-retry-maxtimeout=3000 --fetch-timeout=15000`
}

/**
 * The installer owns only the two stable rows needed to mount the bridge.
 * Models, presets and their support services come from the user's chosen
 * source profile after installation; copying a generated snapshot of those
 * rows would pin package names and preset definitions to an old DSH release.
 */
export const BRIDGE_BOOTSTRAP_ROWS = [
  { id: 'workspace', name: '@deepseek-ai/dsh-workspace' },
  { id: 'dsh-vscode-bridge', name: 'dsh-vscode-bridge' },
] as const

/** Posix target-side installer script (WSL / Linux). `command`/`pkg` are interpolated into the script text. */
export function buildPosixInstallScript(command: string, pkg: string): string {
  return `set -e
${posixBootstrap()}
DSH_HOME="\${DSH_HOME:-$HOME/.dsh}"
PROF="$DSH_HOME/profiles/acp-vscode"
if [ ! -d "$PROF" ]; then
  echo "[install] creating profile from acp template…"
  ${command} --profile acp-vscode --from-default-profile acp --dump-config >/dev/null
fi
echo "[install] ensuring dsh-acp-app bundle…"
node -e '
const fs = require("fs")
const p = process.argv[1] + "/package.json"
const d = JSON.parse(fs.readFileSync(p, "utf8"))
const b = d.dsh.profile.bundles
if (!b.includes("@deepseek-ai/dsh-acp-app")) { b.push("@deepseek-ai/dsh-acp-app"); fs.writeFileSync(p, JSON.stringify(d, null, 2) + "\\n"); console.log("[install]   added") }
else console.log("[install]   already present")
' "$PROF"

# Always forward the selected spec: a package-name check would skip upgrades.
# The plugin add command delegates to pnpm, which converges repeat installs of
# the same spec without changing the resolved dependency.
echo "[install] installing/repairing bridge package ${pkg}…"
${command} plugin --profile acp-vscode add "${pkg}"

PYML="$PROF/cordis.patch.yml"
[ -f "$PYML" ] || printf '[]\\n' > "$PYML"
has_row() {
  grep -Eq "^[[:space:]]*name:[[:space:]]*['\\\"]?$1['\\\"]?[[:space:]]*$" "$PYML"
}
ROWS=''
if ! has_row '@deepseek-ai/dsh-workspace'; then
  ROWS="    - id: workspace
      name: '@deepseek-ai/dsh-workspace'
"
fi
if ! has_row 'dsh-vscode-bridge'; then
  ROWS="\${ROWS}    - id: dsh-vscode-bridge
      name: 'dsh-vscode-bridge'
"
fi
if [ -n "$ROWS" ]; then
  echo "[install] adding only the missing workspace/bridge activation rows…"
  PATCH_TMP="$(mktemp "$PROF/.cordis.patch.yml.bridge-install.XXXXXX")"
  trap 'rm -f -- "$PATCH_TMP"' EXIT
  stripped="$(grep -vE '^[[:space:]]*(#|$)' "$PYML" | tr -d '[:space:]')"
  {
    if [ -n "$stripped" ] && [ "$stripped" != "[]" ]; then
      cat "$PYML"
      printf '\\n'
    fi
    printf '%s\\n' '- insert:'
    printf '%s' "$ROWS"
  } > "$PATCH_TMP"
  chmod 600 "$PATCH_TMP"
  mv "$PATCH_TMP" "$PYML"
  trap - EXIT
else
  echo "[install] workspace/bridge activation rows already present"
fi
echo "[install] DONE"`
}
