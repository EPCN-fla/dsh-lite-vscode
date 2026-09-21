/** Pure target-side install script builder (unit-testable, no vscode imports). */

/**
 * Canonical cordis.patch.yml content for the acp-vscode profile, following the
 * dsh-vscode-bridge README ("接线 profile"): one insert list carrying the
 * service rows the acp composition lacks, plus the permission-preset display
 * metadata the base layer does not ship.
 */
export const PATCH_YML = `# Service rows the acp composition does not carry.
- insert:
    - id: workspace
      name: '@deepseek-ai/dsh-workspace'
    - id: agent-presets
      name: '@deepseek-ai/dsh-agent-presets'
      config:
        default: standard
    # The standard preset's subagent model routing reads this host row
    # (the web bundle ships it; the acp composition does not).
    - id: subagent-model-selection-settings
      name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings'
    - id: dsh-vscode-bridge
      name: 'dsh-vscode-bridge'
      # config: { portStart: 7310, portEnd: 7319 }   # optional override

# Display metadata for the three permission presets (base only ships
# sandbox/approval, no name/description).
- id: permission
  config:
    presets:
      read-only:
        sandbox: read-only
        approval: ask
        name: read-only
        description: 只读；写入与更大范围的重试需要批准。
      workspace-write:
        sandbox: workspace-write
        approval: ask
        name: workspace-write
        description: 允许在工作区内写入；更大范围的重试需要批准。
      danger-full-access:
        sandbox: danger-full-access
        approval: never
        name: danger-full-access
        description: 完全文件访问，不再弹出批准。
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
if (!b.includes("@deepseek-ai/dsh-acp-app")) { b.push("@deepseek-ai/dsh-acp-app"); fs.writeFileSync(p, JSON.stringify(d, null, 2) + "\\n"); console.log("[install]   added") }
else console.log("[install]   already present")
' "$PROF"
PYML="$PROF/cordis.patch.yml"
if [ -f "$PYML" ] && grep -q dsh-vscode-bridge "$PYML"; then
  echo "[install] bridge rows already present in cordis.patch.yml"
else
  # A fresh profile ships a placeholder patch file whose only content is a bare
  # flow sequence ("[]"); appending block entries after it is invalid YAML, so
  # the placeholder is replaced. A file with real user content gets an append.
  stripped="$(grep -vE '^[[:space:]]*(#|$)' "$PYML" 2>/dev/null | tr -d '[:space:]')"
  if [ -z "$stripped" ] || [ "$stripped" = "[]" ]; then
    echo "[install] writing cordis.patch.yml (workspace + agent-presets + subagent route + bridge + permission metadata)…"
    cat > "$PYML" << 'YML'
${PATCH_YML}YML
  else
    echo "[install] appending bridge rows to existing cordis.patch.yml…"
    printf '\\n' >> "$PYML"
    cat >> "$PYML" << 'YML'
${PATCH_YML}YML
  fi
fi
if ! grep -q dsh-vscode-bridge "$PROF/package.json" 2>/dev/null; then
  echo "[install] installing bridge package ${pkg}…"
  ${command} plugin --profile acp-vscode add "${pkg}"
else
  echo "[install] bridge package already installed"
fi
echo "[install] DONE"`
}
