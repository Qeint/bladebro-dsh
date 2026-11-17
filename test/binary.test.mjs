import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

let artifact
let cacheRoot
let goodPayload
let goodHash
let server
let serveMode = 'good'
let serveMissingSidecar = false
const servedVersions = new Set(['4.6.7', '4.6.8', '4.6.9', '4.6.10'])
let binaryApi

before(async () => {
  delete process.env.BLADEBRO_BIN
  artifact = mkdtempSync(join(tmpdir(), 'bladebro-dsh-bin-'))
  cacheRoot = join(artifact, 'cache')
  goodPayload = Buffer.from('#!/bin/sh\necho fake-bladebro\n', 'utf8')
  goodHash = createHash('sha256').update(goodPayload).digest('hex')
  binaryApi = await import('../dist/binary.js')

  server = createServer((req, res) => {
    const versionMatch = /^\/v([^/]+)\//.exec(req.url)
    if (versionMatch && !servedVersions.has(versionMatch[1])) {
      res.statusCode = 404
      res.end('release not found')
      return
    }
    if (req.url.endsWith('.sha256')) {
      if (serveMissingSidecar) {
        res.statusCode = 404
        res.end('missing')
        return
      }
      res.setHeader('content-type', 'text/plain')
      res.end(`${goodHash}  ${binaryApi.PLATFORM.asset}\n`)
      return
    }
    if (req.url.includes('/bladebro-')) {
      if (serveMode === 'stalled-body') {
        res.writeHead(200, { 'content-type': 'application/octet-stream' })
        res.write(Buffer.from('partial'))
        req.on('close', () => res.destroy())
        return
      }
      const body = serveMode === 'tampered' ? Buffer.from('corrupted-binary') : goodPayload
      res.setHeader('content-type', 'application/octet-stream')
      res.end(body)
      return
    }
    res.statusCode = 404
    res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  process.env.BLADEBRO_DSH_RELEASES_BASE = `http://127.0.0.1:${server.address().port}`
  process.env.BLADEBRO_DSH_CACHE_DIR = cacheRoot
})

after(async () => {
  delete process.env.BLADEBRO_DSH_RELEASES_BASE
  delete process.env.BLADEBRO_DSH_CACHE_DIR
  await new Promise((resolve) => server.close(resolve))
  rmSync(artifact, { recursive: true, force: true })
})

test('downloadBinary: verifies SHA256, chmods, caches, and cleans .tmp-* dirs', async () => {
  const { downloadBinary, installedVersions } = binaryApi
  const path = await downloadBinary('4.6.7', { timeoutMs: 15_000 })
  assert.ok(existsSync(path))
  if (process.platform !== 'win32') {
    assert.ok(statSync(path).mode & 0o100, 'binary must be executable')
  }
  assert.equal(readFileSync(path, 'utf8'), goodPayload.toString('utf8'))
  assert.equal(installedVersions().length, 1)
  assert.deepEqual(
    readdirSync(cacheRoot).filter((e) => e.startsWith('.tmp-')),
    [],
    'no .tmp-* staging dirs may survive',
  )
})

test('downloadBinary: SHA256 mismatch and missing sidecar refuse to install', async () => {
  const { downloadBinary, binaryAt } = binaryApi
  serveMode = 'tampered'
  await assert.rejects(() => downloadBinary('4.6.8', { timeoutMs: 15_000 }), /SHA256 mismatch/)
  assert.equal(existsSync(binaryAt('4.6.8')), false)
  serveMode = 'good'

  serveMissingSidecar = true
  await assert.rejects(() => downloadBinary('4.6.8', { timeoutMs: 15_000 }), /unverifiable/)
  assert.equal(existsSync(binaryAt('4.6.8')), false)
  serveMissingSidecar = false
})

test('resolveBinary: enforces pinned floor and upgrades older cache entries', async () => {
  const { resolveBinary } = binaryApi
  const resolved = await resolveBinary('4.6.9', false, { timeoutMs: 15_000 })
  assert.equal(resolved.version, '4.6.9')
  assert.equal(resolved.source, 'release')
  // Newer cached version wins over lower pin
  const newer = await resolveBinary('4.6.7', false, { timeoutMs: 15_000 })
  assert.equal(newer.version, '4.6.9')
})

test('resolveBinary: BLADEBRO_BIN rejects directories and resolves bare names on PATH', async () => {
  const { resolveBinary } = binaryApi
  const dirOnly = mkdtempSync(join(artifact, 'dir-only-'))
  process.env.BLADEBRO_BIN = dirOnly
  try {
    await assert.rejects(() => resolveBinary('4.6.9', false), /not a file/)
  } finally {
    delete process.env.BLADEBRO_BIN
  }

  const pathDir = mkdtempSync(join(artifact, 'path-bin-'))
  const binName = process.platform === 'win32' ? 'my-bladebro.exe' : 'my-bladebro'
  const binPath = join(pathDir, binName)
  writeFileSync(binPath, '#!/bin/sh\n')
  const prevPath = process.env.PATH
  process.env.PATH = `${pathDir}${delimiter}${prevPath ?? ''}`
  process.env.BLADEBRO_BIN = 'my-bladebro'
  try {
    const resolved = await resolveBinary('4.6.9', false)
    assert.equal(resolved.path, binPath)
    assert.equal(resolved.source, 'path')
  } finally {
    process.env.PATH = prevPath
    delete process.env.BLADEBRO_BIN
  }
})

test('downloadBinary: reaps dead-PID .install.lock and aborts stalled body streams', async () => {
  const { downloadBinary, binaryAt } = binaryApi
  const lockDir = join(cacheRoot, '.install.lock')
  mkdirSync(lockDir, { recursive: true })
  writeFileSync(join(lockDir, 'owner.pid'), '2147483646\n')
  const path = await downloadBinary('4.6.10', { timeoutMs: 5000 })
  assert.ok(existsSync(path))
  assert.equal(existsSync(lockDir), false)

  servedVersions.add('4.6.11')
  serveMode = 'stalled-body'
  try {
    await assert.rejects(() => downloadBinary('4.6.11', { timeoutMs: 400 }), /timed out/)
    assert.equal(existsSync(binaryAt('4.6.11')), false)
  } finally {
    serveMode = 'good'
    servedVersions.delete('4.6.11')
  }
})
