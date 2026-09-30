/** Pure target-side install script builder (unit-testable, no vscode imports). */
import { AGENT_PRESET_PATCH_YML } from './presetPatches.js'

/**
 * The `agent-presets` service row — valid only on DSH ≤ 0.1.6 hosts.
 * `@deepseek-ai/dsh-agent-presets` was removed in DSH 0.1.7, split into
 * `@deepseek-ai/dsh-agent-preset` + `@deepseek-ai/dsh-agent-preset-registry`
 * (DSH-0.1.7-J1-03); a profile still carrying this row refuses to compose at
 * all on a 0.1.7 host.
 */
const AGENT_PRESETS_ROW = `    - id: agent-presets
      name: '@deepseek-ai/dsh-agent-presets'
      config:
        default: standard
`

/**
 * Canonical cordis.patch.yml content for the acp-vscode profile, following the
 * dsh-vscode-bridge README ("接线 profile"): one insert list carrying the
 * service rows the acp composition lacks, plus the permission-preset display
 * metadata the base layer does not ship.
 */
function buildPatchYml(agentPresetsRow: string): string {
  return `# Service rows the acp composition does not carry.
- insert:
    - id: workspace
      name: '@deepseek-ai/dsh-workspace'
${agentPresetsRow}    # The subagent model routing reads this host row (the web bundle
    # ships it; the acp composition does not).
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
}

/**
 * DSH ≥ 0.1.7 variant: the removed `agent-presets` service row is replaced by
 * the declarative split — an `agent-preset-registry` row plus one
 * `dsh-agent-preset` declaration per shipped preset, vendored from the host
 * cohort by scripts/sync-presets.mjs (drift fails per-preset into a broken
 * roster entry, never into a composition failure). This restores the same
 * roster the 0.1.5 monolith shipped, so the preset picker keeps working.
 */
export const PATCH_YML_DSH_0_1_7 = buildPatchYml('') + '\n' + AGENT_PRESET_PATCH_YML

/** DSH ≤ 0.1.6 variant: adds the monolithic `agent-presets` service row. */
export const PATCH_YML_DSH_0_1_5 = buildPatchYml(AGENT_PRESETS_ROW)

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
# dsh-agent-presets was removed in DSH 0.1.7 (split into dsh-agent-preset +
# dsh-agent-preset-registry, DSH-0.1.7-J1-03): the old row cannot import on a
# 0.1.7 host (entry-level failure, agentPresets service missing), so the patch
# content is picked by host version. An unparseable or newer version takes the
# 0.1.7 variant — on a genuinely old host that only loses the preset picker,
# while the legacy row on a 0.1.7 host loses it for sure.
DSH_VER="$(${command} --version 2>/dev/null | grep -oE '[0-9]+\\.[0-9]+\\.[0-9]+' | head -n1)"
case "$DSH_VER" in
  0.0.* | 0.1.[0-6]) PATCH_VARIANT=legacy ;;
  *) PATCH_VARIANT=current ;;
esac
echo "[install] host dsh \${DSH_VER:-unknown} → cordis.patch.yml variant: $PATCH_VARIANT"

# Repair an existing file on a 0.1.7 host: the stale agent-presets row can
# never import again — drop it (block-deleted by id, only when the block
# actually references the removed package; backup kept at cordis.patch.yml.bak).
if [ "$PATCH_VARIANT" = "current" ] && [ -f "$PYML" ] && grep -q "@deepseek-ai/dsh-agent-presets" "$PYML"; then
  echo "[install] removing the stale agent-presets row from cordis.patch.yml…"
  cp "$PYML" "$PYML.bak"
  node -e '
const fs = require("fs")
const p = process.argv[1]
const lines = fs.readFileSync(p, "utf8").split("\\n")
const out = []
let removed = 0
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/^(\\s*)- id: agent-presets\\s*$/)
  if (m) {
    let j = i + 1
    while (j < lines.length && lines[j].trim() !== "" && lines[j].match(/^(\\s*)/)[1].length > m[1].length) j++
    if (lines.slice(i, j).join("\\n").includes("@deepseek-ai/dsh-agent-presets")) { removed++; i = j - 1; continue }
  }
  out.push(lines[i])
}
if (removed) { fs.writeFileSync(p, out.join("\\n")); console.log("[install]   removed (backup: cordis.patch.yml.bak)") }
else console.log("[install]   WARNING: row shape not recognized; left in place — edit " + p + " manually")
' "$PYML"
fi

if [ -f "$PYML" ] && grep -q dsh-vscode-bridge "$PYML"; then
  if [ "$PATCH_VARIANT" = "current" ] && ! grep -q agent-preset-registry "$PYML"; then
    # Pre-0.2.2 file whose rows are otherwise fine: add the 0.1.7 preset wiring.
    echo "[install] adding the agent-preset rows (registry + shipped presets)…"
    printf '\\n' >> "$PYML"
    cat >> "$PYML" << 'YML'
${AGENT_PRESET_PATCH_YML}YML
  else
    echo "[install] bridge rows already present in cordis.patch.yml"
  fi
else
  PATCH_TMP="$(mktemp)"
  if [ "$PATCH_VARIANT" = "legacy" ]; then
    cat > "$PATCH_TMP" << 'YML'
${PATCH_YML_DSH_0_1_5}YML
  else
    cat > "$PATCH_TMP" << 'YML'
${PATCH_YML_DSH_0_1_7}YML
  fi
  # A fresh profile ships a placeholder patch file whose only content is a bare
  # flow sequence ("[]"); appending block entries after it is invalid YAML, so
  # the placeholder is replaced. A file with real user content gets an append.
  stripped="$(grep -vE '^[[:space:]]*(#|$)' "$PYML" 2>/dev/null | tr -d '[:space:]')"
  if [ -z "$stripped" ] || [ "$stripped" = "[]" ]; then
    echo "[install] writing cordis.patch.yml (workspace + subagent route + bridge + permission metadata)…"
    cat "$PATCH_TMP" > "$PYML"
  else
    echo "[install] appending bridge rows to existing cordis.patch.yml…"
    printf '\\n' >> "$PYML"
    cat "$PATCH_TMP" >> "$PYML"
  fi
  rm -f "$PATCH_TMP"
fi
if ! grep -q dsh-vscode-bridge "$PROF/package.json" 2>/dev/null; then
  echo "[install] installing bridge package ${pkg}…"
  ${command} plugin --profile acp-vscode add "${pkg}"
else
  echo "[install] bridge package already installed"
fi
echo "[install] DONE"`
}
