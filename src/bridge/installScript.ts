/** Pure target-side install script builder (unit-testable, no vscode imports). */
export const PATCH_YML = `- insert:
    - id: workspace
      name: '@deepseek-ai/dsh-workspace'
    - id: agent-presets
      name: '@deepseek-ai/dsh-agent-presets'
      config:
        default: standard
    - id: dsh-vscode-bridge
      name: 'dsh-vscode-bridge'
`

/** Posix target-side installer script (WSL / Linux). Placeholders: __CMD__, __PKG__. */
export function buildPosixInstallScript(command: string, pkg: string): string {
  return `set -e
export NVM_DIR="\${NVM_DIR:-$HOME/.nvm}"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
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
if (!b.includes("@deepseek-ai/dsh-acp-app")) { b.push("@deepseek-ai/dsh-acp-app"); fs.writeFileSync(p, JSON.stringify(d, null, 2)); console.log("[install]   added") }
else console.log("[install]   already present")
' "$PROF"
touch "$PROF/cordis.patch.yml"
if ! grep -q dsh-vscode-bridge "$PROF/cordis.patch.yml"; then
  echo "[install] adding workspace + agent-presets + bridge rows…"
  cat >> "$PROF/cordis.patch.yml" << 'YML'
${PATCH_YML}YML
else
  echo "[install] bridge rows already present"
fi
if ! grep -q model-selection-settings "$PROF/cordis.patch.yml"; then
  echo "[install] adding subagent model-selection-settings host row (required by the standard preset)…"
  cat >> "$PROF/cordis.patch.yml" << 'YML'
- insert:
    - id: subagent-model-selection-settings
      name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings'
YML
fi
if ! grep -q dsh-vscode-bridge "$PROF/package.json" 2>/dev/null; then
  echo "[install] installing bridge package ${pkg}…"
  ${command} plugin --profile acp-vscode add "${pkg}"
else
  echo "[install] bridge package already installed"
fi
echo "[install] DONE"`
}

