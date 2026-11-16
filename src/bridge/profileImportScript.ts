/** Pure bash launcher builder for the target-side profile import host. */
import { posixBootstrap } from '../launcher/shellenv.js'
import type { ProfileImportRequest } from './profileImport.js'

/** POSIX single-quote quoting, including embedded quotes, newlines and command characters. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

/** A quoted heredoc delimiter which cannot terminate the embedded host program early. */
function heredocMarker(code: string): string {
  let marker = 'DSH_PROFILE_IMPORT_HOST'
  const lines = code.split('\n')
  while (lines.some(line => line === marker || line === `${marker}\r`)) marker += '_X'
  return marker
}

const UNAVAILABLE = '{"ok":false,"code":"config/unavailable"}'
const NODE_UNAVAILABLE = '{"ok":false,"code":"config/node-unavailable"}'

/**
 * Build a bash -s program. `dshCommand` is a trusted user-configured command,
 * exactly as in the installer; request JSON and generated code are data, never shell syntax.
 */
export function buildProfileImportScript(hostCode: string, dshCommand: string, request: ProfileImportRequest): string {
  const marker = heredocMarker(hostCode)
  const hostBody = hostCode.endsWith('\n') ? hostCode : `${hostCode}\n`
  return `# DSH profile import host launcher
${posixBootstrap()}
if ! command -v node >/dev/null 2>&1; then
  printf '%s\\n' '${NODE_UNAVAILABLE}'
  exit 0
fi
DSH_HOME="\${DSH_HOME:-$HOME/.dsh}"
export DSH_HOME
DSH_IMPORT_REQUEST=${shellQuote(JSON.stringify(request))}
export DSH_IMPORT_REQUEST
DSH_WORK="$(mktemp -d "\${TMPDIR:-/tmp}/dsh-profile-import.XXXXXXXXXX" 2>/dev/null)" || DSH_WORK=
if [ -z "$DSH_WORK" ]; then
  printf '%s\\n' '${UNAVAILABLE}'
  exit 0
fi
trap 'rm -rf -- "$DSH_WORK"' EXIT
trap 'exit 0' HUP INT TERM

cat > "$DSH_WORK/host.mjs" <<'${marker}'
${hostBody}${marker}
if [ "$?" -ne 0 ]; then
  printf '%s\\n' '${UNAVAILABLE}'
  exit 0
fi

# The shared profile fallback is the cheapest and most stable installation anchor.
DSH_IMPORT_ANCHOR="$DSH_HOME/profiles/node_modules/@deepseek-ai/dsh/package.json"
if [ ! -f "$DSH_IMPORT_ANCHOR" ]; then
  DSH_IMPORT_ANCHOR=
  cat > "$DSH_WORK/probe.cjs" <<'DSH_PROFILE_IMPORT_PROBE'
const fs = require('node:fs')
const path = require('node:path')
try {
  const output = process.env.DSH_IMPORT_ANCHOR_FILE
  if (output && process.argv[1]) {
    let dir = path.dirname(path.resolve(process.argv[1]))
    for (;;) {
      const candidate = path.join(dir, 'package.json')
      try {
        const manifest = JSON.parse(fs.readFileSync(candidate, 'utf8'))
        if (manifest && manifest.name === '@deepseek-ai/dsh') {
          try { fs.writeFileSync(output, candidate + '\\n', { flag: 'wx' }) } catch (error) {
            if (!error || error.code !== 'EEXIST') throw error
          }
          break
        }
      } catch {}
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
} catch {}
DSH_PROFILE_IMPORT_PROBE
  if [ "$?" -ne 0 ]; then
    printf '%s\\n' '${UNAVAILABLE}'
    exit 0
  fi
  # Preserve the caller's options and scope the probe solely to the version command.
  DSH_PROBE_NODE_OPTIONS="\${NODE_OPTIONS:+\${NODE_OPTIONS} }--require \\"$DSH_WORK/probe.cjs\\""
  NODE_OPTIONS="$DSH_PROBE_NODE_OPTIONS" DSH_IMPORT_ANCHOR_FILE="$DSH_WORK/anchor" ${dshCommand} --version >/dev/null 2>/dev/null || :
  if [ -f "$DSH_WORK/anchor" ]; then
    IFS= read -r DSH_IMPORT_ANCHOR < "$DSH_WORK/anchor" || :
  fi
fi

if [ -z "$DSH_IMPORT_ANCHOR" ] || [ ! -f "$DSH_IMPORT_ANCHOR" ]; then
  printf '%s\\n' '${UNAVAILABLE}'
  exit 0
fi
export DSH_IMPORT_ANCHOR
DSH_HOST_OUTPUT="$(node "$DSH_WORK/host.mjs" 2>/dev/null)"
DSH_HOST_STATUS=$?
if [ "$DSH_HOST_STATUS" -ne 0 ] || [ -z "$DSH_HOST_OUTPUT" ]; then
  printf '%s\\n' '${UNAVAILABLE}'
else
  printf '%s\\n' "$DSH_HOST_OUTPUT"
fi
exit 0
`
}
