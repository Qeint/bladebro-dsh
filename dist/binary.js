/**
 * Binary provisioning: resolve an existing bladebro binary, download
 * and SHA256-verify one from GitHub Releases when missing, install it
 * atomically into its own versioned cache directory, and check for
 * newer releases on a throttled schedule. Zero external dependencies.
 */
import { compareSemver, isNewer, parseSemver } from './version.js';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
const REPO = 'dondai44423/bladebro';
function releasesBase() {
    return process.env.BLADEBRO_DSH_RELEASES_BASE?.trim() || `https://github.com/${REPO}/releases/download`;
}
function apiBase() {
    return process.env.BLADEBRO_DSH_API_BASE?.trim() || `https://api.github.com/repos/${REPO}`;
}
const MAX_DOWNLOAD_BYTES = 150 * 1024 * 1024;
const BINARY_NAME = process.platform === 'win32' ? 'bladebro.exe' : 'bladebro';
function platformInfo() {
    if (process.platform === 'linux' && process.arch === 'x64') {
        return { key: 'linux-x64', asset: 'bladebro-linux-x64', supported: true };
    }
    if (process.platform === 'linux' && process.arch === 'arm64') {
        return { key: 'linux-arm64', asset: 'bladebro-linux-arm64', supported: true };
    }
    if (process.platform === 'darwin' && process.arch === 'arm64') {
        return { key: 'darwin-arm64', asset: 'bladebro-darwin-arm64', supported: true };
    }
    if (process.platform === 'darwin' && process.arch === 'x64') {
        return { key: 'darwin-x64', asset: 'bladebro-darwin-x64', supported: true };
    }
    if (process.platform === 'win32' && process.arch === 'x64') {
        return { key: 'win32-x64', asset: 'bladebro-windows-x64.exe', supported: true };
    }
    return { key: `${process.platform}-${process.arch}`, asset: 'unsupported', supported: false };
}
export const PLATFORM = platformInfo();
function isRegularFile(path) {
    try {
        return statSync(path).isFile();
    }
    catch {
        return false;
    }
}
function findOnPath(name) {
    const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
    const suffixes = process.platform === 'win32' && !/\.(exe|cmd|bat)$/i.test(name)
        ? ['', '.exe', '.cmd', '.bat']
        : [''];
    for (const dir of dirs) {
        for (const suffix of suffixes) {
            const candidate = join(dir, name + suffix);
            if (isRegularFile(candidate))
                return candidate;
        }
    }
    return null;
}
function resolveEnvBinary(spec) {
    if (spec.includes('/') || spec.includes('\\') || isRegularFile(spec)) {
        return isRegularFile(spec) ? spec : null;
    }
    return findOnPath(spec);
}
export function cacheDir() {
    const env = process.env.BLADEBRO_DSH_CACHE_DIR;
    if (env && env.trim())
        return env.trim();
    const home = process.env.BLADEBRO_DSH_HOME?.trim() || homedir();
    return join(home, '.cache', 'bladebro', 'dsh');
}
export function binDir(version) {
    return join(cacheDir(), 'bin', version);
}
export function binaryAt(version) {
    return join(binDir(version), BINARY_NAME);
}
export function installedVersions() {
    const root = join(cacheDir(), 'bin');
    let entries;
    try {
        entries = readdirSync(root);
    }
    catch {
        return [];
    }
    const out = [];
    for (const entry of entries) {
        const parsed = parseSemver(entry);
        if (parsed === null)
            continue;
        if (!isRegularFile(join(root, entry, BINARY_NAME)))
            continue;
        out.push(parsed);
    }
    return out;
}
export async function resolveBinary(pinned, allowPathFallback, options = {}) {
    const env = process.env.BLADEBRO_BIN?.trim();
    if (env) {
        const resolvedEnv = resolveEnvBinary(env);
        if (resolvedEnv !== null)
            return { path: resolvedEnv, version: 'env', source: 'path' };
        throw new Error(`BLADEBRO_BIN points at ${env}, which does not exist or is not a file.`);
    }
    const installed = installedVersions().sort((a, b) => compareSemver(versionString(a), versionString(b)));
    const newest = installed.length > 0 ? versionString(installed[installed.length - 1]) : null;
    const newestPath = newest !== null ? binaryAt(newest) : null;
    const hasCached = newest !== null && newestPath !== null && isRegularFile(newestPath);
    if (hasCached && (parseSemver(pinned) === null || !isNewer(pinned, newest))) {
        return { path: newestPath, version: newest, source: 'release' };
    }
    try {
        const path = await downloadBinary(pinned, options);
        return { path, version: pinned, source: 'release' };
    }
    catch (err) {
        if (!allowPathFallback)
            throw err;
        if (hasCached) {
            options.onProgress?.(`bladebro v${pinned} download failed; using cached v${newest}`);
            return { path: newestPath, version: newest, source: 'release' };
        }
        const onPath = findOnPath(BINARY_NAME);
        if (onPath !== null) {
            options.onProgress?.('bladebro download failed; using bladebro from PATH (degraded)');
            return { path: onPath, version: 'path', source: 'path' };
        }
        throw err;
    }
}
function versionString(v) {
    const pre = v.prerelease.length > 0 ? `-${v.prerelease.join('.')}` : '';
    return `${v.major}.${v.minor}.${v.patch}${pre}`;
}
const STALE_LOCK_MAX_AGE_MS = 10 * 60_000;
function isProcessAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (err) {
        return err?.code === 'EPERM';
    }
}
function isStaleLock(lock, ownerFile) {
    try {
        if (existsSync(ownerFile)) {
            const pid = Number(readFileSync(ownerFile, 'utf8').trim());
            if (Number.isInteger(pid) && pid > 0) {
                return !isProcessAlive(pid);
            }
        }
        return Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MAX_AGE_MS;
    }
    catch {
        return false;
    }
}
async function acquireLock(dir, timeoutMs) {
    mkdirSync(dir, { recursive: true });
    const lock = join(dir, '.install.lock');
    const ownerFile = join(lock, 'owner.pid');
    const start = Date.now();
    for (;;) {
        try {
            mkdirSync(lock);
            try {
                writeFileSync(ownerFile, `${process.pid}\n`);
            }
            catch {
                // Best-effort owner stamp.
            }
            return;
        }
        catch {
            if (isStaleLock(lock, ownerFile)) {
                rmSync(lock, { recursive: true, force: true });
                continue;
            }
            if (Date.now() - start > timeoutMs) {
                throw new Error('timed out waiting for another bladebro install to finish (stale lock?)');
            }
            await new Promise((r) => setTimeout(r, 100));
        }
    }
}
function releaseLock(dir) {
    try {
        rmSync(join(dir, '.install.lock'), { recursive: true, force: true });
    }
    catch {
        // Best effort.
    }
}
export async function downloadBinary(version, options = {}) {
    const parsed = parseSemver(version);
    if (parsed === null)
        throw new Error(`refusing to download bladebro version ${version}: not a valid semver`);
    const root = cacheDir();
    const timeout = options.timeoutMs ?? 120_000;
    await acquireLock(root, timeout);
    try {
        if (!PLATFORM.supported) {
            throw new Error(`bladebro does not ship a binary for ${PLATFORM.key}. Supported platforms: linux-x64, linux-arm64, darwin-x64, darwin-arm64, win32-x64.`);
        }
        const target = binaryAt(version);
        if (isRegularFile(target))
            return target;
        const asset = PLATFORM.asset;
        const base = `${releasesBase()}/v${version}/${asset}`;
        const binResp = await httpGet(`${base}`, timeout).catch(() => null);
        if (binResp === null)
            throw new Error(`could not reach ${releasesBase()} (network down?) while installing bladebro v${version}`);
        if (!binResp.ok) {
            await binResp.drain();
            throw new Error(`bladebro does not ship a ${PLATFORM.key} binary for v${version} (release fetch returned HTTP ${binResp.status}). Supported platforms: linux-x64, linux-arm64, darwin-x64, darwin-arm64, win32-x64.`);
        }
        const sidecarResp = await httpGet(`${base}.sha256`, timeout).catch(() => null);
        if (sidecarResp === null || !sidecarResp.ok) {
            if (sidecarResp !== null)
                await sidecarResp.drain();
            await binResp.drain();
            throw new Error(`bladebro v${version} ${PLATFORM.key} asset found but its .sha256 sidecar is missing; refusing to install an unverifiable binary`);
        }
        let sidecarText;
        try {
            sidecarText = (await sidecarResp.text(64 * 1024)).trim();
        }
        catch (err) {
            await binResp.drain();
            throw err;
        }
        const sidecarMatch = /^([a-f0-9]{64})(?:\s|$)/.exec(sidecarText);
        if (sidecarMatch === null) {
            await binResp.drain();
            throw new Error(`bladebro v${version} .sha256 sidecar is malformed; refusing to install`);
        }
        const expected = sidecarMatch[1];
        mkdirSync(root, { recursive: true });
        const tmpDir = join(root, `.tmp-${process.pid}-${Date.now()}`);
        const stageDir = join(tmpDir, 'out');
        const stagedBin = join(stageDir, BINARY_NAME);
        mkdirSync(stageDir, { recursive: true });
        try {
            options.onProgress?.(`downloading bladebro v${version} for ${PLATFORM.key}`);
            const hash = createHash('sha256');
            let bytes = 0;
            const chunks = [];
            for await (const buf of binResp) {
                bytes += buf.length;
                if (bytes > MAX_DOWNLOAD_BYTES)
                    throw new Error('download exceeds the 150 MB guard; aborting');
                hash.update(buf);
                chunks.push(buf);
            }
            const digest = hash.digest('hex');
            if (digest !== expected) {
                throw new Error(`SHA256 mismatch for bladebro v${version} ${PLATFORM.key}: expected ${expected}, got ${digest}`);
            }
            writeFileSync(stagedBin, Buffer.concat(chunks));
            if (process.platform !== 'win32')
                chmodSync(stagedBin, 0o755);
            const finalDir = binDir(version);
            mkdirSync(join(cacheDir(), 'bin'), { recursive: true });
            if (existsSync(finalDir))
                rmSync(finalDir, { recursive: true, force: true });
            renameSync(stageDir, finalDir);
            return binaryAt(version);
        }
        finally {
            rmSync(tmpDir, { recursive: true, force: true });
        }
    }
    finally {
        releaseLock(root);
    }
}
function httpResult(res) {
    const consumed = { done: false };
    let streamError = null;
    res.on('error', (err) => {
        streamError = err instanceof Error ? err : new Error(String(err));
    });
    res.on('end', () => {
        consumed.done = true;
    });
    res.on('close', () => {
        consumed.done = true;
    });
    const drain = () => new Promise((resolve) => {
        if (consumed.done || res.destroyed || res.complete) {
            consumed.done = true;
            resolve();
            return;
        }
        consumed.done = true;
        res.resume();
        res.once('end', resolve);
        res.once('error', () => resolve());
        res.once('close', resolve);
    });
    return {
        ok: res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode ?? 0,
        drain,
        text(maxBytes) {
            return new Promise((resolve, reject) => {
                if (streamError !== null) {
                    reject(streamError);
                    return;
                }
                const chunks = [];
                let size = 0;
                res.on('data', (chunk) => {
                    size += chunk.length;
                    if (size > maxBytes) {
                        consumed.done = true;
                        res.destroy();
                        reject(new Error(`response body exceeds ${maxBytes} bytes`));
                        return;
                    }
                    chunks.push(chunk);
                });
                res.on('end', () => {
                    consumed.done = true;
                    resolve(Buffer.concat(chunks).toString('utf8'));
                });
                res.on('error', reject);
            });
        },
        [Symbol.asyncIterator]() {
            if (streamError !== null) {
                const err = streamError;
                return {
                    next: () => Promise.reject(err),
                };
            }
            return res[Symbol.asyncIterator]();
        },
    };
}
function httpGet(url, timeoutMs) {
    return new Promise((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;
        const makeTimeoutError = () => new Error(`request timed out after ${timeoutMs}ms`);
        const driver = (target, redirectsLeft) => {
            let parsed;
            try {
                parsed = new URL(target);
            }
            catch {
                reject(new Error(`invalid URL: ${target}`));
                return;
            }
            const remaining = deadline - Date.now();
            if (remaining <= 0) {
                reject(makeTimeoutError());
                return;
            }
            let activeRes = null;
            const mod = parsed.protocol === 'https:' ? httpsRequest : httpRequest;
            const timer = setTimeout(() => {
                const err = makeTimeoutError();
                if (activeRes !== null)
                    activeRes.destroy(err);
                req.destroy(err);
                reject(err);
            }, remaining);
            const req = mod(parsed, { method: 'GET', headers: { 'user-agent': 'bladebro-dsh-plugin', accept: '*/*', connection: 'close' } }, (res) => {
                activeRes = res;
                const result = httpResult(res);
                if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    if (redirectsLeft <= 0) {
                        clearTimeout(timer);
                        void result.drain().finally(() => reject(new Error('too many redirects')));
                        return;
                    }
                    const next = new URL(res.headers.location, parsed).toString();
                    if (next !== target && (next.startsWith('http://') || next.startsWith('https://'))) {
                        void result.drain().finally(() => {
                            clearTimeout(timer);
                            driver(next, redirectsLeft - 1);
                        });
                        return;
                    }
                }
                const clear = () => clearTimeout(timer);
                res.once('end', clear);
                res.once('close', clear);
                resolve(result);
            });
            req.on('error', (err) => {
                clearTimeout(timer);
                reject(err instanceof Error ? err : new Error(String(err)));
            });
            req.end();
        };
        driver(url, 5);
    });
}
async function fetchLatestTag(channel) {
    try {
        if (channel === 'stable') {
            const resp = await httpGet(`${apiBase()}/releases/latest`, 15_000).catch(() => null);
            if (resp === null || !resp.ok) {
                if (resp !== null)
                    await resp.drain();
                return null;
            }
            const body = (JSON.parse(await resp.text(2 * 1024 * 1024).catch(() => '{}')) ?? {});
            if (typeof body.tag_name === 'string')
                return body.tag_name;
            return null;
        }
        const resp = await httpGet(`${apiBase()}/releases?per_page=10`, 15_000).catch(() => null);
        if (resp === null || !resp.ok) {
            if (resp !== null)
                await resp.drain();
            return null;
        }
        const body = (JSON.parse(await resp.text(2 * 1024 * 1024).catch(() => '[]')) ?? []);
        for (const release of body) {
            if (typeof release.tag_name !== 'string')
                continue;
            if (parseSemver(release.tag_name) === null)
                continue;
            return release.tag_name;
        }
        return null;
    }
    catch {
        return null;
    }
}
let lastCheckAt = 0;
export async function checkForUpdate(currentVersion, channel, intervalHours) {
    const intervalMs = Math.max(1, intervalHours) * 3600_000;
    const now = Date.now();
    if (now - lastCheckAt < intervalMs)
        return null;
    lastCheckAt = now;
    try {
        const tag = await fetchLatestTag(channel);
        if (tag === null)
            return null;
        if (parseSemver(tag) === null)
            return null;
        if (isNewer(tag, currentVersion)) {
            return { current: currentVersion, latest: tag, newer: true };
        }
        return null;
    }
    catch {
        return null;
    }
}
