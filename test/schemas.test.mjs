import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const { toDshSpec, specToJsonSchema, specViolation, callTitle, callKind, publicToolName, isValidPrefix } = await import('../dist/schemas.js')
const { assertWireSchema } = await import('./wire-schema.mjs')

const HERE = dirname(fileURLToPath(import.meta.url))
const DAEMON_TOOLS = JSON.parse(readFileSync(join(HERE, 'fixtures', 'daemon-tools.json'), 'utf8'))

test('every real bladebro daemon inputSchema projects cleanly into author and wire schemas', () => {
  assert.equal(DAEMON_TOOLS.length, 5)
  for (const tool of DAEMON_TOOLS) {
    const spec = toDshSpec(tool.inputSchema)
    assert.equal(specViolation(spec), null, `${tool.name} author spec violation`)
    const wire = specToJsonSchema(spec)
    assertWireSchema(wire, tool.name)
  }
})

test('act and run preserve required enums and nested step schemas', () => {
  const actTool = DAEMON_TOOLS.find((t) => t.name === 'act')
  const wire = specToJsonSchema(toDshSpec(actTool.inputSchema))
  assert.deepEqual(wire.required, ['action'])
  assert.ok(Array.isArray(wire.properties.action.enum))
  assert.ok(wire.properties.action.enum.includes('click'))
  assert.ok(wire.properties.action.enum.includes('navigate'))
  assert.equal(wire.properties.steps.type, 'array')
  assert.equal(wire.properties.steps.items.type, 'object')
})

test('workbench call cards summarize act, see, state, run, and vision cleanly', () => {
  assert.equal(callKind('bladebro_see'), 'read')
  assert.equal(callKind('bladebro_vision'), 'read')
  assert.equal(callKind('bladebro_act'), 'execute')
  assert.equal(callKind('bladebro_run'), 'execute')
  assert.equal(callKind('bladebro_state'), 'other')

  assert.match(callTitle('bladebro_act', { action: 'click', ref: 'e5' }), /click e5/)
  assert.match(callTitle('bladebro_see', { logs: 'xhr' }), /logs=xhr/)
  assert.match(callTitle('bladebro_state', { op: 'cookies' }), /cookies/)
  assert.match(callTitle('bladebro_run', { steps: [{ action: 'click' }, { action: 'see' }] }), /2 steps/)
  assert.match(callTitle('bladebro_vision', { marks: true }), /marks/)
})

test('prefix and tool name validation reject hostile characters', () => {
  assert.equal(isValidPrefix('bladebro'), true)
  assert.equal(isValidPrefix('bb'), true)
  assert.equal(isValidPrefix('bad prefix'), false)
  assert.equal(publicToolName('bb', 'act'), 'bb_act')
  assert.equal(publicToolName('bb', 'has space!'), null)
})
