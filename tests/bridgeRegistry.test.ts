import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDshVersion } from '../src/bridge/hostVersion.ts'
import {
  BridgeRegistryError,
  compareDshVersions,
  parseBridgeRegistryResponse,
  selectLatestCompatibleBridge,
} from '../src/bridge/registry.ts'

const entries = parseBridgeRegistryResponse(JSON.stringify([
  { version: '0.1.1', 'devDependencies.@deepseek-ai/dsh-agent': '0.1.5-rc.2' },
  { version: '0.1.2', 'devDependencies.@deepseek-ai/dsh-agent': '^0.1.5-rc.2' },
  { version: '0.1.3', 'devDependencies.@deepseek-ai/dsh-agent': '0.1.5-rc.2' },
  { version: '0.2.0', 'devDependencies.@deepseek-ai/dsh-agent': '0.1.7-rc.1' },
  { version: '0.4.0', dshCompatibility: { '0.1.7-rc.1': {}, '0.2.0-rc.1': {}, '0.2.1-rc.2': {} } },
  { version: '0.4.2', dshCompatibility: { '0.1.7-rc.1': {}, '0.2.1-rc.2': {}, '0.2.1-rc.5': {}, '0.2.2-rc.1': {} } },
  { version: '0.5.0', dshCompatibility: { '0.2.2-rc.2': {} } },
  { version: '0.5.1', dshCompatibility: { '0.2.2-rc.2': {} } },
  { version: '0.5.2', dshCompatibility: { '0.2.2-rc.2': {}, '0.2.2-rc.3': {} } },
  { version: '0.5.3-alpha.1', dshCompatibility: { '0.2.2-rc.3': {} } },
  { version: '0.5.3', dshCompatibility: { '0.2.2-rc.4': {} } },
]))

function select(host: string): string {
  return selectLatestCompatibleBridge(parseDshVersion(host)!, entries)
}

test('online selection picks the highest compatible version, not a pinned historical mapping', () => {
  assert.equal(select('0.2.2-rc.2'), 'dsh-vscode-bridge@0.5.2', '0.5.2 supports rc.2 as well as rc.3')
  assert.equal(select('0.2.2-rc.3'), 'dsh-vscode-bridge@0.5.2')
  assert.equal(select('0.2.2-rc.1'), 'dsh-vscode-bridge@0.4.2')
  assert.equal(select('0.2.1-rc.2'), 'dsh-vscode-bridge@0.4.2')
})

test('stable compatible releases outrank prereleases and incompatible newer releases', () => {
  assert.equal(select('0.2.2-rc.3'), 'dsh-vscode-bridge@0.5.2', 'alpha and incompatible 0.5.3 do not win')
  assert.equal(selectLatestCompatibleBridge(parseDshVersion('0.2.2-rc.4')!, entries), 'dsh-vscode-bridge@0.5.3')
  assert.equal(selectLatestCompatibleBridge(parseDshVersion('0.2.2-rc.4')!, [
    { version: '0.6.0-alpha.1', dshCompatibility: { '0.2.2-rc.4': {} } },
  ]), 'dsh-vscode-bridge@0.6.0-alpha.1', 'prerelease is used only when no stable candidate exists')
})

test('legacy development dependency metadata supports exact and caret ranges', () => {
  assert.equal(select('0.1.5-rc.2'), 'dsh-vscode-bridge@0.1.3')
  assert.equal(select('0.1.6'), 'dsh-vscode-bridge@0.1.2', 'only the caret legacy range includes 0.1.6')
  assert.equal(select('0.1.7-rc.1'), 'dsh-vscode-bridge@0.4.2')
})

test('no compatible release and malformed registry responses fail closed', () => {
  assert.throws(() => select('0.3.0'), (error: unknown) => error instanceof BridgeRegistryError && error.code === 'registry/no-compatible')
  assert.throws(() => parseBridgeRegistryResponse('not json'), (error: unknown) => error instanceof BridgeRegistryError && error.code === 'registry/invalid')
  assert.deepEqual(parseBridgeRegistryResponse('[{"version":"not a version"}]'), [])
})

test('SemVer comparison handles release and numeric prerelease precedence', () => {
  const v = (text: string) => parseDshVersion(text)!
  assert.ok(compareDshVersions(v('0.5.2'), v('0.5.2-rc.10')) > 0)
  assert.ok(compareDshVersions(v('0.5.2-rc.10'), v('0.5.2-rc.2')) > 0)
  assert.ok(compareDshVersions(v('0.5.2-rc.1'), v('0.5.2-alpha.9')) > 0)
  assert.equal(compareDshVersions(v('0.5.2-rc.1'), v('0.5.2-rc.1')), 0)
})
