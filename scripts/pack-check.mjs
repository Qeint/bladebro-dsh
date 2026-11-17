import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = join(import.meta.dirname, '..')
const dir = mkdtempSync(join(tmpdir(), 'bladebro-pack-'))
try {
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const packRes = spawnSync(npmCmd, ['pack', '--pack-destination', dir, '--json'], {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
  if (packRes.status !== 0) {
    throw new Error(`npm pack failed: ${packRes.stderr || packRes.stdout || packRes.error?.message}`)
  }
  const tgz = readdirSync(dir).find((f) => f.endsWith('.tgz'))
  if (!tgz) throw new Error('npm pack produced no tarball')
  const out = join(dir, 'out')
  mkdirSync(out, { recursive: true })
  execFileSync('tar', ['-xzf', join(dir, tgz), '-C', out])

  const pkg = JSON.parse(readFileSync(join(out, 'package', 'package.json'), 'utf8'))
  if (pkg.name !== '@dsh-external/bladebro') throw new Error('package name mismatch: ' + pkg.name)
  if (!pkg.dsh?.bundle?.patch) throw new Error('package.json is missing dsh.bundle.patch')
  const patchRel = pkg.dsh.bundle.patch.replace(/^\.\//, '')
  if (!existsSync(join(out, 'package', patchRel))) throw new Error(`patch file ${patchRel} missing from tarball`)
  const patch = readFileSync(join(out, 'package', patchRel), 'utf8')
  if (!patch.includes("'@dsh-external/bladebro'") && !patch.includes('"@dsh-external/bladebro"')) {
    throw new Error('patch does not mount the plugin package name')
  }
  for (const entry of pkg.files ?? []) {
    if (!existsSync(join(out, 'package', entry))) throw new Error(`files entry ${entry} missing from tarball`)
  }
  const mainEntry = (pkg.main ?? './dist/index.js').replace(/^\.\//, '')
  if (!existsSync(join(out, 'package', mainEntry))) throw new Error(`main entry ${mainEntry} missing from tarball`)
  const mod = await import(pathToFileURL(join(out, 'package', mainEntry)).href)
  if (typeof mod.apply !== 'function' || typeof mod.name !== 'string') {
    throw new Error('entry module does not export { name, apply }')
  }
  console.log('PACK OK: manifest, patch, files, and entry contract verified')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
