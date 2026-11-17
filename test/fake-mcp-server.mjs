#!/usr/bin/env node
import { appendFileSync } from 'node:fs'

const logLine = (envKey, text) => {
  if (!process.env[envKey]) return
  try {
    appendFileSync(process.env[envKey], text + '\n')
  } catch {}
}

const emit = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')

const TOOLS = [
  { name: 'act', description: 'interact with page', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['click', 'navigate', 'fail', 'slow', 'crash'] }, url: { type: 'string' }, ref: { type: 'string' } }, required: ['action'] } },
  { name: 'see', description: 'read page', inputSchema: { type: 'object', properties: { mode: { type: 'string', enum: ['model', 'content', 'outline'] }, logs: { type: 'string', enum: ['console', 'network', 'xhr'] } } } },
  { name: 'state', description: 'manage state', inputSchema: { type: 'object', properties: { op: { type: 'string', enum: ['cookies', 'tabs'] } }, required: ['op'] } },
  { name: 'run', description: 'batch steps', inputSchema: { type: 'object', properties: { steps: { type: 'array', items: { type: 'object', properties: { action: { type: 'string' } } } } }, required: ['steps'] } },
  { name: 'vision', description: 'screenshot', inputSchema: { type: 'object', properties: { marks: { type: 'boolean' } } } },
  { name: 'bad name!!', description: 'illegal', inputSchema: { type: 'object', properties: {} } },
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const queue = []
const cancelledIds = new Set()
let waiters = []
let buffer = ''

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  const lines = buffer.split('\n')
  buffer = lines.pop() ?? ''
  for (const line of lines) {
    if (!line.trim()) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    if (msg.method === 'notifications/cancelled') {
      const id = msg.params?.id
      if (typeof id === 'number') cancelledIds.add(id)
      logLine('FAKE_CANCEL_LOG', String(id ?? '?'))
      continue
    }
    queue.push(msg)
    const w = waiters
    waiters = []
    for (const fn of w) fn()
  }
})
process.stdin.on('end', () => process.exit(0))

const nextMessage = () => (queue.length > 0 ? Promise.resolve(queue.shift()) : new Promise((r) => waiters.push(() => r(queue.shift()))))

async function handleCall(msg) {
  const name = msg.params?.name ?? ''
  const args = msg.params?.arguments ?? {}
  if (name === 'act') {
    if (args.action === 'fail') {
      emit({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'blocked: target missing' }], isError: true } })
    } else if (args.action === 'slow') {
      await sleep(4000)
      if (!cancelledIds.has(msg.id)) {
        emit({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'slow done' }] } })
      }
    } else if (args.action === 'crash') {
      process.exit(7)
    } else {
      emit({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `act:${args.action}:${args.url ?? args.ref ?? ''}` }] } })
    }
  } else if (name === 'vision') {
    emit({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        content: [
          { type: 'image', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', mimeType: 'image/png' },
          { type: 'text', text: '1920x1080 screenshot' },
        ],
      },
    })
  } else if (name === 'see') {
    emit({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `see:${args.mode ?? args.logs ?? 'model'}` }] } })
  } else {
    emit({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `${name}:ok` }] } })
  }
}

for (;;) {
  const msg = await nextMessage()
  if (!msg) break
  if (msg.method === 'initialize') {
    logLine('FAKE_BOOT_LOG', 'boot')
    emit({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'bladebro', version: '4.6.9-fake' } } })
  } else if (msg.method === 'tools/list') {
    emit({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } })
  } else if (msg.method === 'tools/call') {
    void handleCall(msg)
  }
}
