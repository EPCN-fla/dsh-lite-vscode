import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shellQuote } from '../src/launcher/local.ts'
import { resolveLauncher, detectHostSide, LauncherConfigError } from '../src/launcher/detect.ts'
import { WslLauncher } from '../src/launcher/wsl.ts'
import type { DshConfig } from '../src/launcher/types.ts'

const cfg = (runtime: DshConfig['runtime']): DshConfig => ({ runtime, profile: 'acp', command: 'dsh', wslDistro: '', env: {} })

test('shellQuote escapes single quotes', () => {
  assert.equal(shellQuote("a'b"), `'a'\\''b'`)
})

test('host detection', () => {
  assert.equal(detectHostSide(undefined, 'win32', {}), 'windows')
  assert.equal(detectHostSide('wsl', 'linux', {}), 'wsl')
  assert.equal(detectHostSide(undefined, 'linux', { WSL_DISTRO_NAME: 'Ubuntu' }), 'wsl')
  assert.equal(detectHostSide(undefined, 'linux', {}), 'linux')
  assert.equal(detectHostSide(undefined, 'darwin', {}), 'macos')
})

test('topology matrix resolves to the right launcher label', () => {
  assert.match(resolveLauncher('windows', cfg('auto')).label, /windows-host → windows/)
  assert.match(resolveLauncher('windows', cfg('wsl')).label, /windows-host → wsl/)
  assert.match(resolveLauncher('wsl', cfg('auto')).label, /wsl-host → wsl/)
  assert.match(resolveLauncher('wsl', cfg('windows')).label, /wsl-host → windows/)
})

test('unsupported combos raise a clear error', () => {
  assert.throws(() => resolveLauncher('linux', cfg('wsl')), LauncherConfigError)
  assert.throws(() => resolveLauncher('macos', cfg('windows')), LauncherConfigError)
})

test('WslLauncher spec: no --cd flag, bash login shell, bootstrap present', async () => {
  const spec = await new WslLauncher(cfg('wsl'), '/mnt').buildLaunchSpec('H:\\proj\\x')
  assert.equal(spec.command, 'wsl.exe')
  const joined = spec.args.join(' ')
  assert.ok(!spec.args.includes('--cd'), 'must not use wsl.exe --cd (older WSL rejects it)')
  assert.match(joined, /bash.*-lc/)
  assert.match(joined, /NVM_DIR/)
  assert.match(joined, /--profile acp/)
})

test('WindowsLocal spec: cmd.exe wrapper for .cmd shims', async () => {
  const spec = await resolveLauncher('windows', cfg('auto')).buildLaunchSpec('C:\\x')
  assert.equal(spec.command, 'cmd.exe')
  assert.deepEqual(spec.args.slice(0, 3), ['/d', '/s', '/c'])
  assert.equal(spec.cwd, 'C:\\x')
  assert.doesNotMatch(spec.args[3], /cd \/d/) // cmd.exe quoting landmine: cwd must ride on spawn, not the /c payload
})
