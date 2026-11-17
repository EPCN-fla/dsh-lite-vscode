import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import * as vscode from 'vscode'
import { AcpClient } from '../src/acp/client.ts'
import { AcpService } from '../src/acp/service.ts'
import type { Launcher } from '../src/launcher/types.ts'

type Handlers = Parameters<typeof AcpClient.start>[1]
type Spec = Parameters<typeof AcpClient.start>[0]

function fakeClient(): AcpClient {
  const client = { isClosed: false, agentInfo: { name: 'fake-acp', version: '1.0.0' } }
  return Object.assign(client, { dispose: () => { client.isClosed = true } }) as unknown as AcpClient
}

function harness(t: TestContext) {
  const starts: Handlers[] = []
  t.mock.method(AcpClient, 'start', async (_spec: Spec, handlers: Handlers) => {
    starts.push(handlers)
    return fakeClient()
  })
  const launcher = {
    label: 'fake', paths: { toDsh: async (p: string) => p, fromDsh: async (p: string) => p },
    buildLaunchSpec: async () => ({ command: '/bin/true', args: [] }),
    buildDoctorSpec: async () => ({ command: '/bin/true', args: [] }),
  } as Launcher
  const out = { appendLine: () => undefined, append: () => undefined } as unknown as vscode.OutputChannel
  const service = new AcpService(() => launcher, out)
  t.after(() => service.dispose())
  return { service, starts }
}

test('a late exit from an old client cannot clear the replacement client', async t => {
  const { service, starts } = harness(t)
  await service.ensureClient()
  service.reset()
  await service.ensureClient()
  const generation = service.generation
  const states: string[] = []
  service.onState(event => { states.push(event.state) })

  starts[0]!.onExit!({ code: 0, signal: null, stderrTail: '' })

  assert.equal(service.isReady, true)
  assert.equal(service.generation, generation)
  assert.deepEqual(states, [])
})

test('reset invalidates an in-flight start and disposes its late client', async t => {
  const pending: { handlers: Handlers; resolve: (client: AcpClient) => void }[] = []
  t.mock.method(AcpClient, 'start', (_spec: Spec, handlers: Handlers) => new Promise<AcpClient>(resolve => {
    pending.push({ handlers, resolve })
  }))
  const launcher = {
    label: 'fake', paths: { toDsh: async (p: string) => p, fromDsh: async (p: string) => p },
    buildLaunchSpec: async () => ({ command: '/bin/true', args: [] }),
    buildDoctorSpec: async () => ({ command: '/bin/true', args: [] }),
  } as Launcher
  const out = { appendLine: () => undefined, append: () => undefined } as unknown as vscode.OutputChannel
  const service = new AcpService(() => launcher, out)
  t.after(() => service.dispose())

  const first = service.ensureClient()
  await new Promise(resolve => setImmediate(resolve))
  service.reset()
  const second = service.ensureClient()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(pending.length, 2)

  const secondClient = fakeClient()
  pending[1].resolve(secondClient)
  await second
  const oldClient = fakeClient()
  pending[0].resolve(oldClient)
  await assert.rejects(first, /reset/)

  assert.equal(service.isReady, true)
  assert.equal(oldClient.isClosed, true)
  assert.equal(service.generation, 1)
})
