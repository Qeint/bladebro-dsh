/**
 * Live end-to-end: real bladebro binary, real MCP handshake, real
 * tools/list, and real browser navigation + see content read. Uses
 * BLADEBRO_BIN when set, otherwise resolves/downloads the pinned release.
 */
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveBinary } from '../dist/binary.js'
import { McpClient } from '../dist/mcp.js'
import { PINNED_BLADEBRO_VERSION } from '../dist/version.js'

const REQUIRED_TOOLS = ['act', 'see', 'state', 'run', 'vision']

async function main() {
  const { path, version, source } = await resolveBinary(PINNED_BLADEBRO_VERSION, false, {
    onProgress: (state) => console.log('  ' + state),
  })
  console.log(`bladebro binary: ${path}`)
  console.log(`expected version: v${PINNED_BLADEBRO_VERSION}; resolved: ${version} (${source})`)

  const home = mkdtempSync(join(tmpdir(), 'bladebro-dsh-live-'))
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end('<!doctype html><title>Bladebro Live</title><h1>Bladebro DSH Parity</h1><p>ready</p>')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/`

  const client = new McpClient({
    cmd: [path, 'mcp'],
    callTimeoutMs: 180_000,
    bootTimeoutMs: 30_000,
    env: { BLADE_HOME: home, BLADE_NO_WARMING: '1' },
  })
  try {
    await client.start()
    console.log(`daemon version: ${client.serverVersion ?? 'unknown'}`)
    const names = client.tools.map((t) => t.name)
    console.log(`tools discovered: ${names.join(', ')}`)
    for (const required of REQUIRED_TOOLS) {
      if (!names.includes(required)) {
        throw new Error(`LIVE FAIL: ${required} missing from tools/list`)
      }
    }
    const nav = await client.callTool('act', { action: 'navigate', url })
    if (nav.isError === true) throw new Error('LIVE FAIL: act navigate returned isError: ' + JSON.stringify(nav.content))
    const see = await client.callTool('see', { mode: 'content' })
    if (see.isError === true) throw new Error('LIVE FAIL: see content returned isError')
    const text = (see.content ?? []).map((b) => (typeof b.text === 'string' ? b.text : '')).join('')
    if (!/Bladebro DSH Parity/i.test(text)) {
      throw new Error(`LIVE FAIL: unexpected see content: ${text}`)
    }
    console.log(`see content ok: ${text.length} chars`)
    console.log('LIVE OK: daemon parity confirmed (act + see + state + run + vision surface)')
  } finally {
    await client.dispose(1500)
    await new Promise((resolve) => server.close(resolve))
    rmSync(home, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error('LIVE FAIL: ' + (err instanceof Error ? err.message : String(err)))
  process.exit(1)
})
