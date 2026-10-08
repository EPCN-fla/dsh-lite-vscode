import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDshVersion, isTestedHostVersion, bridgeSpecForHost, BRIDGE_SPEC_CURRENT, BRIDGE_SPEC_LEGACY } from '../src/bridge/hostVersion.ts'

test('parseDshVersion extracts the first semver, prerelease included', () => {
  assert.deepEqual(parseDshVersion('0.2.0-rc.2'), { major: 0, minor: 2, patch: 0, prerelease: 'rc.2' })
  assert.deepEqual(parseDshVersion('dsh/0.1.7-rc.1 linux-x64 node-v22.19.0'), { major: 0, minor: 1, patch: 7, prerelease: 'rc.1' })
  assert.deepEqual(parseDshVersion('0.1.5'), { major: 0, minor: 1, patch: 5 })
  assert.equal(parseDshVersion(''), undefined)
  assert.equal(parseDshVersion(undefined), undefined)
  assert.equal(parseDshVersion('no version here'), undefined)
})

test('isTestedHostVersion matches the README corridor', () => {
  for (const ok of ['0.1.5-rc.2', '0.1.7-rc.1', '0.1.7-rc.2', '0.2.0-rc.1', '0.2.0-rc.2', '0.2.0']) {
    assert.ok(isTestedHostVersion(parseDshVersion(ok)!), ok)
  }
  for (const nope of ['0.1.6-alpha.2', '0.2.1-alpha.1', '0.3.0', '1.0.0']) {
    assert.ok(!isTestedHostVersion(parseDshVersion(nope)!), nope)
  }
})

test('bridgeSpecForHost maps the cohort boundary like the install script', () => {
  assert.equal(bridgeSpecForHost(parseDshVersion('0.1.5-rc.2')), BRIDGE_SPEC_LEGACY)
  assert.equal(bridgeSpecForHost(parseDshVersion('0.1.6-alpha.1')), BRIDGE_SPEC_LEGACY)
  assert.equal(bridgeSpecForHost(parseDshVersion('0.1.7-rc.2')), BRIDGE_SPEC_CURRENT)
  assert.equal(bridgeSpecForHost(parseDshVersion('0.2.0-rc.2')), BRIDGE_SPEC_CURRENT)
  assert.equal(bridgeSpecForHost(undefined), BRIDGE_SPEC_CURRENT) // unknown → current line
})
