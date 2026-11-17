import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const { apply, bladebroConfigPath, renderContent } = await import('../dist/index.js')
const { assertWireSchema, wireViolations } = await import('./wire-schema.mjs')

const HERE = dirname(fileURLToPath(import.meta.url))
const FAKE = join(HERE, 'fake-mcp-server.mjs')

let artifact
let cancelLog
let bootLog

before(() => {
  artifact = mkdtempSync(join(tmpdir(), 'bladebro-dsh-apply-'))
  cancelLog = join(artifact, 'cancelled.log')
  bootLog = join(artifact, 'boot.log')
  process.env.FAKE_CANCEL_LOG = cancelLog
  process.env.FAKE_BOOT_LOG = bootLog
  process.env.BLADEBRO_BIN = process.platform === 'win32' ? join(HERE, 'fake-mcp-server.cmd') : FAKE
  process.env.BLADEBRO_DSH_HOME = join(artifact, 'home')
  process.env.BLADEBRO_DSH_AUTOUPDATE = 'off'
  mkdirSync(dirname(bladebroConfigPath()), { recursive: true })
  writeFileSync(bladebroConfigPath(), 'pace = "normal"\n')
  chmodSync(FAKE, 0o755)
})

after(() => {
  delete process.env.FAKE_CANCEL_LOG
  delete process.env.FAKE_BOOT_LOG
  delete process.env.BLADEBRO_BIN
  delete process.env.BLADEBRO_DSH_HOME
  delete process.env.BLADEBRO_DSH_AUTOUPDATE
  rmSync(artifact, { recursive: true, force: true })
})

function makeHarness() {
  const all = new Map()
  const disposers = []
  const ctx = {
    tools: {
      register(def) {
        const issue = wireViolations(def.parameters, `${def.name}.parameters`)[0]
        if (issue) throw new Error(issue)
        all.set(def.name, def)
        return () => all.delete(def.name)
      },
    },
    effect(scope) {
      const disposer = scope()
      disposers.push(async () => {
        if (typeof disposer === 'function') await disposer()
      })
      return { dispose: () => undefined }
    },
    on: () => () => undefined,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  }
  return {
    ctx,
    defs: () => [...all.values()],
    waitFor(cond, timeoutMs = 8000) {
      return new Promise((resolve, reject) => {
        const start = Date.now()
        const timer = setInterval(() => {
          if (cond(this)) {
            clearInterval(timer)
            resolve()
          } else if (Date.now() - start > timeoutMs) {
            clearInterval(timer)
            reject(new Error(`timeout waiting; registered: ${[...all.keys()].join(', ')}`))
          }
        }, 50)
      })
    },
    dispose: async () => {
      for (const d of disposers.splice(0)) await d()
    },
  }
}

test('apply: registers all 5 Bladebro tools + status, preserves vision image blocks, and maps errors', async () => {
  const harness = makeHarness()
  apply(harness.ctx, { toolPrefix: 'bb', fallbackToPath: false, callTimeoutMs: 5000, bootTimeoutMs: 5000 })
  await harness.waitFor((h) => h.defs().some((d) => d.name === 'bb_act'))
  const names = harness.defs().map((d) => d.name)
  for (const expected of ['bb_act', 'bb_see', 'bb_state', 'bb_run', 'bb_vision', 'bb_status']) {
    assert.ok(names.includes(expected), `missing ${expected}`)
  }
  for (const def of harness.defs()) {
    assertWireSchema(def.parameters, def.name)
  }

  const act = harness.defs().find((d) => d.name === 'bb_act')
  const navRes = await act.execute({ action: 'navigate', url: 'https://example.com' }, { signal: new AbortController().signal })
  assert.equal(navRes.content[0].text, 'act:navigate:https://example.com')

  // Vision screenshot image block passes through renderContent intact!
  const vision = harness.defs().find((d) => d.name === 'bb_vision')
  const visRes = await vision.execute({ marks: true }, { signal: new AbortController().signal })
  const rendered = renderContent(visRes)
  assert.equal(rendered[0].type, 'image')
  assert.equal(rendered[0].mimeType, 'image/png')
  assert.ok(rendered[0].data.length > 20)

  await assert.rejects(
    () => act.execute({ action: 'fail' }, { signal: new AbortController().signal }),
    /blocked: target missing/,
  )
  await harness.dispose()
})

test('apply: cancellation forwards notifications/cancelled, crash revives, and config watch refreshes cleanly', async () => {
  const harness = makeHarness()
  apply(harness.ctx, { toolPrefix: 'bb', fallbackToPath: false, callTimeoutMs: 15_000 })
  try {
    await harness.waitFor((h) => h.defs().some((d) => d.name === 'bb_act'))
    const act = () => harness.defs().find((d) => d.name === 'bb_act')

    // Cancellation
    const ac = new AbortController()
    const slowPromise = act().execute({ action: 'slow' }, { signal: ac.signal })
    setTimeout(() => ac.abort(), 120)
    await assert.rejects(slowPromise, /cancelled/)
    await new Promise((r) => setTimeout(r, 200))
    assert.ok(existsSync(cancelLog))

    // Crash + revival
    await assert.rejects(() => act().execute({ action: 'crash' }, { signal: new AbortController().signal }), /exited|unavailable/)
    const revived = await act().execute({ action: 'click', ref: 'e3' }, { signal: new AbortController().signal })
    assert.equal(revived.content[0].text, 'act:click:e3')

    // Config watch restart without duplicate registrationFailures
    const bootsBefore = readFileSync(bootLog, 'utf8').trim().split('\n').length
    const now = new Date()
    utimesSync(bladebroConfigPath(), now, now)
    await harness.waitFor(
      () => readFileSync(bootLog, 'utf8').trim().split('\n').length > bootsBefore,
      12_000,
    )
    const statusDef = harness.defs().find((d) => d.name === 'bb_status')
    const statusOut = await statusDef.execute({}, { signal: new AbortController().signal })
    const statusText = statusOut.content[0].text
    assert.match(statusText, /state: daemon running/)
    assert.doesNotMatch(statusText, /skipping duplicate tool name/)
  } finally {
    await harness.dispose()
  }
})
