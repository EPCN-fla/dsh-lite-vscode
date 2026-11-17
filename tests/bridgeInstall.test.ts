import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as vscode from 'vscode'
import { installBridgeFlow } from '../src/bridge/install.ts'
import type { BridgeManager } from '../src/bridge/manager.ts'

test('bridge install automatically uses online lookup without a version prompt', { skip: process.platform === 'win32' }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-auto-install-'))
  const home = join(root, 'dsh-home')
  const cli = join(root, 'fake-dsh.sh')
  writeFileSync(cli, `#!/bin/bash
PROF="$DSH_HOME/profiles/acp-vscode"
case "$1" in
  --profile)
    mkdir -p "$PROF"
    [ -f "$PROF/package.json" ] || printf '{ "dsh": { "profile": { "bundles": [] } } }\\n' > "$PROF/package.json"
    [ -f "$PROF/cordis.patch.yml" ] || printf '[]\\n' > "$PROF/cordis.patch.yml"
    ;;
  plugin)
    node -e '
const fs = require("fs")
const p = process.argv[1] + "/package.json"
const d = JSON.parse(fs.readFileSync(p, "utf8"))
d.dependencies = { ...d.dependencies, "dsh-vscode-bridge": process.argv[2].slice(process.argv[2].lastIndexOf("@") + 1) }
fs.writeFileSync(p, JSON.stringify(d, null, 2) + "\\n")
' "$PROF" "$5"
    ;;
esac
`)
  chmodSync(cli, 0o755)
  await vscode.workspace.getConfiguration('dsh').update('command', cli)
  t.after(async () => { await vscode.workspace.getConfiguration('dsh').update('command', 'dsh') })
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => { if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome })
  t.mock.method(vscode.window, 'showInputBox', async () => { throw new Error('version prompt must not be shown') })
  let output = ''
  const out = {
    show: () => undefined,
    append: (text: string) => { output += text },
    appendLine: (text: string) => { output += `${text}\n` },
  } as unknown as import('vscode').OutputChannel
  const bridge = { hostDshVersion: '0.2.2-rc.3' } as BridgeManager
  let queriedHost = ''
  let imports = 0

  await installBridgeFlow(out, bridge, async host => {
    queriedHost = `${host.major}.${host.minor}.${host.patch}-${host.prerelease}`
    return 'dsh-vscode-bridge@0.5.2'
  }, async () => { imports++ })

  const manifest = JSON.parse(readFileSync(join(home, 'profiles', 'acp-vscode', 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>
  }
  assert.equal(queriedHost, '0.2.2-rc.3')
  assert.equal(imports, 1, 'successful installation opens the source-profile import flow')
  assert.equal(manifest.dependencies['dsh-vscode-bridge'], '0.5.2')
  assert.match(output, /selected bridge spec: dsh-vscode-bridge@0\.5\.2/)
  assert.match(output, /opening the source-profile import flow/)
})


test('registry lookup failure stops before creating or repairing a profile', async t => {
  // Native Windows targets return before lookup; WSL reaches the registry path on every host OS.
  const config = vscode.workspace.getConfiguration('dsh')
  const previousRuntime = config.get('runtime', 'auto')
  await config.update('runtime', 'wsl')
  t.after(async () => { await config.update('runtime', previousRuntime) })
  let output = ''
  let error = ''
  const out = {
    show: () => undefined,
    append: (text: string) => { output += text },
    appendLine: (text: string) => { output += `${text}\n` },
  } as unknown as import('vscode').OutputChannel
  t.mock.method(vscode.window, 'showErrorMessage', async (message: string) => { error = message })
  const bridge = { hostDshVersion: '0.2.2-rc.3' } as BridgeManager
  await installBridgeFlow(out, bridge, async () => { throw new Error('offline') })
  assert.match(error, /could not query bridge compatibility/)
  assert.match(output, /registry\/unavailable/)
})
