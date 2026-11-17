import { test } from 'node:test'
import assert from 'node:assert/strict'

const { callTimeoutFor } = await import('../dist/index.js')

const BASE = 180_000

test('calls without explicit timeout keep base timeout (run floors at 300s)', () => {
  assert.equal(callTimeoutFor('see', { mode: 'model' }, BASE), BASE)
  assert.equal(callTimeoutFor('act', { action: 'click', ref: 'e1' }, BASE), BASE)
  assert.equal(callTimeoutFor('vision', { marks: true }, BASE), BASE)
  assert.equal(callTimeoutFor('run', { steps: [{ action: 'click' }] }, BASE), 300_000)
})

test('act timeout seconds and run step timeouts scale with slack and cap at 620s', () => {
  assert.equal(callTimeoutFor('act', { action: 'wait', timeout: 240 }, BASE), 260_000)
  assert.equal(callTimeoutFor('act', { action: 'wait', timeout: 9999 }, BASE), 620_000)
  assert.equal(
    callTimeoutFor('run', { steps: [{ action: 'wait', timeout: 200 }, { action: 'wait', timeout: 180 }] }, BASE),
    400_000,
  )
})
