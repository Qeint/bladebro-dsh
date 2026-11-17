import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BIN = process.env.BLADEBRO_BIN?.trim()
if (!BIN || !existsSync(BIN)) {
  test('real-registry proof', { skip: 'BLADEBRO_BIN not set or missing' }, () => {})
} else {
  test('real-registry proof: register in actual ToolRuntime, navigate, click, read content, and capture screenshot', async () => {
    const cordis = await import('@deepseek-ai/cordis')
    const dshTools = await import('@deepseek-ai/dsh-tools')
    const { Context, Service } = cordis
    const { ToolRuntime, assertSupportedJsonSchema, validateJsonSchemaValue } = dshTools
    const { apply } = await import('../dist/index.js')
    const { assertWireSchema } = await import('./wire-schema.mjs')

    class StubSystemPrompt extends Service {
      constructor(ctx) { super(ctx, 'systemPrompt') }
      tools() { return () => {} }
      section() { return () => {} }
      getSectionOrder() { return 0 }
      collapseSection() { return () => {} }
    }

    class CapturingRuntime extends ToolRuntime {
      constructor(ctx) {
        super(ctx)
        globalThis.__bbTools = this
      }
    }

    const bladeHome = mkdtempSync(join(tmpdir(), 'bladebro-dsh-real-'))
    const prevHome = process.env.BLADE_HOME
    const prevAuto = process.env.BLADEBRO_DSH_AUTOUPDATE
    process.env.BLADE_HOME = bladeHome
    process.env.BLADEBRO_DSH_AUTOUPDATE = 'off'

    let clicked = false
    const server = createServer((req, res) => {
      if (req.url === '/api/ping') {
        clicked = true
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: true, token: 'LIVE_API_OK' }))
        return
      }
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end(`<!doctype html><title>Real DSH Test</title>
        <h1>Bladebro Real ToolRuntime</h1>
        <button id="go" onclick="fetch('/api/ping').then(r=>r.json()).then(d=>{document.getElementById('out').textContent=d.token})">Trigger API</button>
        <p id="out">waiting</p>`)
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${server.address().port}/`

    const ctx = new Context()
    const fibers = [ctx.plugin(StubSystemPrompt), ctx.plugin(CapturingRuntime)]
    await Promise.all(fibers)
    Object.defineProperty(ctx, 'tools', { value: globalThis.__bbTools, configurable: true })

    const handle = apply(ctx, {
      toolPrefix: 'bladebro',
      fallbackToPath: false,
      callTimeoutMs: 120_000,
      bootTimeoutMs: 30_000,
    })

    try {
      const expected = ['act', 'see', 'state', 'run', 'vision', 'status'].map((s) => `bladebro_${s}`)
      const deadline = Date.now() + 30_000
      let defs = []
      while (Date.now() < deadline) {
        defs = expected.map((n) => ({ name: n, def: ctx.tools.get(n) })).filter((x) => x.def !== undefined)
        if (defs.length === expected.length) break
        await new Promise((r) => setTimeout(r, 200))
      }
      assert.equal(defs.length, expected.length, `missing tools; got ${defs.map((d) => d.name).join(', ')}`)

      for (const { name, def } of defs) {
        assertWireSchema(def.parameters, name)
        assertSupportedJsonSchema(def.parameters)
      }

      assert.deepEqual(
        validateJsonSchemaValue(ctx.tools.get('bladebro_act').parameters, { action: 'navigate', url }, 'args'),
        [],
      )

      // 1. Navigate
      const nav = await ctx.tools.execute({
        name: 'bladebro_act',
        arguments: { action: 'navigate', url },
        signal: new AbortController().signal,
      })
      assert.equal(nav.isError, false)

      // 2. Click button by text
      const clk = await ctx.tools.execute({
        name: 'bladebro_act',
        arguments: { action: 'click', text: 'Trigger API' },
        signal: new AbortController().signal,
      })
      assert.equal(clk.isError, false)
      assert.equal(clicked, true, 'real Chromium click must hit local HTTP /api/ping')

      // 3. Read rendered markdown content
      const see = await ctx.tools.execute({
        name: 'bladebro_see',
        arguments: { mode: 'content' },
        signal: new AbortController().signal,
      })
      const seeText = (see.content ?? []).map((b) => b.text ?? '').join(' ')
      assert.match(seeText, /LIVE_API_OK/)

      // 4. Inspect XHR endpoint via new logs=xhr!
      const xhr = await ctx.tools.execute({
        name: 'bladebro_see',
        arguments: { logs: 'xhr' },
        signal: new AbortController().signal,
      })
      const xhrText = (xhr.content ?? []).map((b) => b.text ?? '').join(' ')
      assert.match(xhrText, /\/api\/ping/)

      // 5. Capture real screenshot via bladebro_vision
      const shot = await ctx.tools.execute({
        name: 'bladebro_vision',
        arguments: { marks: false },
        signal: new AbortController().signal,
      })
      assert.equal(shot.isError, false)
      assert.ok((shot.content ?? []).some((b) => b.type === 'image' && b.data?.length > 100), 'vision must emit image block')
    } finally {
      await handle.dispose()
      for (const f of fibers) {
        try { f.dispose() } catch {}
      }
      await new Promise((resolve) => server.close(resolve))
      if (prevHome === undefined) delete process.env.BLADE_HOME
      else process.env.BLADE_HOME = prevHome
      if (prevAuto === undefined) delete process.env.BLADEBRO_DSH_AUTOUPDATE
      else process.env.BLADEBRO_DSH_AUTOUPDATE = prevAuto
      rmSync(bladeHome, { recursive: true, force: true })
    }
  })
}
