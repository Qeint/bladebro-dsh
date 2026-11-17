/**
 * @dsh-external/bladebro : first-class Bladebro agentic browser control
 * for DeepSeek Harness.
 *
 * Spawns ONE supervised `bladebro mcp` daemon, registers all five
 * Bladebro tools (`act`, `see`, `state`, `run`, `vision`) plus a
 * self-diagnostic `status` tool on `ctx.tools` with clean names
 * (`bladebro_act`, not `mcp__bladebro__act`), projects every wire
 * schema into the harness JSON Schema subset, preserves image content
 * blocks from `vision`, forwards cancellations (`notifications/cancelled`),
 * watches Bladebro's config file for live swaps, and auto-updates the
 * SHA256-verified binary between calls.
 *
 * Zero runtime imports from the host train: talks to DeepSeek Harness
 * exclusively through the `ctx` handed to `apply()`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, statSync, unwatchFile, watchFile } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cacheDir, checkForUpdate, downloadBinary, installedVersions, resolveBinary } from './binary.js';
import { McpClient } from './mcp.js';
import { callKind, callTitle, firstLine, isValidPrefix, publicToolName, specToJsonSchema, toDshSpec } from './schemas.js';
import { PINNED_BLADEBRO_VERSION, PLUGIN_VERSION } from './version.js';
export const name = 'bladebro';
export const inject = ['tools'];
const CALL_DEADLINE_SLACK_MS = 20_000;
const MAX_CALL_TIMEOUT_MS = 620_000;
function positiveNumber(value) {
    const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
}
/**
 * Derive per-call timeout from the tool's own timeout parameters so long
 * waits, multi-step `run` programs, and `collect` sweeps are never cut
 * prematurely by a lower default `callTimeoutMs`.
 */
export function callTimeoutFor(toolName, args, baseMs) {
    const a = (args ?? {});
    if (toolName === 'act') {
        const secs = positiveNumber(a.timeout);
        if (secs !== null) {
            return Math.min(secs * 1000 + CALL_DEADLINE_SLACK_MS, MAX_CALL_TIMEOUT_MS);
        }
        if ((a.action === 'batch' || a.action === 'collect') && Array.isArray(a.steps)) {
            let stepSecs = 0;
            for (const step of a.steps) {
                if (step !== null && typeof step === 'object') {
                    const s = positiveNumber(step.timeout);
                    if (s !== null)
                        stepSecs += s;
                }
            }
            if (stepSecs > 0) {
                return Math.min(Math.max(baseMs, stepSecs * 1000 + CALL_DEADLINE_SLACK_MS), MAX_CALL_TIMEOUT_MS);
            }
        }
        return baseMs;
    }
    if (toolName === 'run') {
        let stepSecs = 0;
        if (Array.isArray(a.steps)) {
            for (const step of a.steps) {
                if (step !== null && typeof step === 'object') {
                    const s = positiveNumber(step.timeout);
                    if (s !== null)
                        stepSecs += s;
                }
            }
        }
        const derived = stepSecs > 0 ? stepSecs * 1000 + CALL_DEADLINE_SLACK_MS : 300_000;
        return Math.min(Math.max(baseMs, derived), MAX_CALL_TIMEOUT_MS);
    }
    return baseMs;
}
function resolveConfig(raw) {
    const prefix = raw.toolPrefix ?? process.env.BLADEBRO_DSH_PREFIX ?? 'bladebro';
    if (!isValidPrefix(prefix)) {
        throw new Error(`bladebro plugin: toolPrefix ${JSON.stringify(prefix)} must match [A-Za-z0-9_-]{1,16}`);
    }
    const channel = process.env.BLADEBRO_DSH_CHANNEL === 'latest' || raw.channel === 'latest' ? 'latest' : 'stable';
    const autoUpdate = process.env.BLADEBRO_DSH_AUTOUPDATE === 'off' ? false : (raw.autoUpdate ?? true);
    return {
        toolPrefix: prefix,
        channel,
        autoUpdate,
        updateIntervalHours: clampInt(raw.updateIntervalHours, 1, 24 * 30, 24),
        callTimeoutMs: clampInt(raw.callTimeoutMs, 5000, 900_000, 180_000),
        bootTimeoutMs: clampInt(raw.bootTimeoutMs, 5000, 120_000, 25_000),
        fallbackToPath: raw.fallbackToPath ?? true,
        pinnedVersion: raw.pinnedVersion ?? PINNED_BLADEBRO_VERSION,
    };
}
function clampInt(value, min, max, fallback) {
    const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
    return Math.min(max, Math.max(min, n));
}
/** Resolve Bladebro's home directory (`BLADE_HOME` or default `~/.bladebro`). */
export function bladebroHomeDir() {
    const explicit = process.env.BLADE_HOME?.trim();
    if (explicit)
        return explicit;
    const dshHome = process.env.BLADEBRO_DSH_HOME?.trim();
    if (dshHome)
        return join(dshHome, '.bladebro');
    const home = process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || homedir();
    return join(home, '.bladebro');
}
/** Resolve Bladebro's config file (`$BLADE_HOME/config.toml`). */
export function bladebroConfigPath() {
    return join(bladebroHomeDir(), 'config.toml');
}
/**
 * Project MCP result blocks into model-facing dsh ContentBlocks.
 * Text and base64 image blocks (`vision` screenshots) pass through
 * intact so vision-capable models receive real PNG/JPEG/WebP data.
 */
export function renderContent(value) {
    const result = (value ?? {});
    const blocks = Array.isArray(result.content)
        ? result.content.map((block) => {
            const b = (block ?? {});
            if (b.type === 'image' && typeof b.data === 'string' && b.data.length > 0) {
                const mimeType = typeof b.mimeType === 'string' && b.mimeType.length > 0 ? b.mimeType : 'image/png';
                return { type: 'image', data: b.data, mimeType };
            }
            if (typeof b.text === 'string')
                return { type: 'text', text: b.text };
            try {
                return { type: 'text', text: JSON.stringify(b) };
            }
            catch {
                return { type: 'text', text: String(b) };
            }
        })
        : [];
    if (blocks.length === 0)
        return [{ type: 'text', text: 'bladebro returned no content' }];
    return blocks;
}
export function apply(ctx, rawConfig = {}) {
    let config;
    const inert = { dispose: async () => { } };
    try {
        config = resolveConfig(rawConfig);
    }
    catch (err) {
        ctx.logger?.error(`bladebro plugin rejecting configuration: ${err instanceof Error ? err.message : String(err)}`);
        return inert;
    }
    if (typeof ctx.tools?.register !== 'function') {
        ctx.logger?.error('bladebro plugin: this DeepSeek Harness build has no ctx.tools registry (missing @deepseek-ai/dsh-tools)');
        return inert;
    }
    const log = (msg) => {
        ctx.logger?.info(`[bladebro] ${msg}`);
    };
    const warn = (msg) => {
        ctx.logger?.warn(`[bladebro] ${msg}`);
    };
    const disposers = [];
    const registeredNames = new Set();
    const registrationFailures = [];
    let booted = null;
    let bootError = null;
    let status = 'starting';
    let bootLock = null;
    let generation = 0;
    let pendingUpdateVersion = null;
    let activeCalls = 0;
    let statusRegistrations = [];
    let disposed = false;
    function runDoctor(binPath) {
        const cmd = binPath ?? 'bladebro';
        try {
            const result = spawnSync(cmd, ['doctor'], { encoding: 'utf8', timeout: 30_000 });
            const out = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
            return out || '(doctor produced no output)';
        }
        catch {
            return '(bladebro binary not callable yet)';
        }
    }
    function registerStatusTools() {
        for (const dispose of statusRegistrations.splice(0)) {
            try {
                dispose();
            }
            catch {
                // Disposer already ran; ignore.
            }
        }
        const def = {
            name: publicToolName(config.toolPrefix, 'status') ?? `${config.toolPrefix}_status`,
            description: 'Bladebro status and self-diagnostics: binary version, daemon state, browser home, registered tools, registration failures, and the output of `bladebro doctor` (Chrome, Xvfb, window manager, profile locks). Read this when a bladebro_* tool fails or is missing.',
            parameters: { type: 'object', properties: {} },
            output: { schema: {}, render: (_args, value) => renderContent(value) },
            execute: async () => {
                const lines = [];
                lines.push(`Bladebro plugin status: ${status}`);
                if (status === 'ready') {
                    lines.push('state: daemon running and healthy');
                }
                else if (status === 'degraded') {
                    lines.push(booted?.bin.version === 'env'
                        ? 'state: daemon running via BLADEBRO_BIN override (degraded)'
                        : 'state: daemon running via PATH fallback (degraded)');
                }
                else if (status === 'failed') {
                    lines.push(`state: ${bootError ?? 'unknown failure'}`);
                }
                else {
                    lines.push('state: daemon starting in background; re-check shortly');
                }
                lines.push(`browser home: ${bladebroHomeDir()}`);
                const cfgPath = bladebroConfigPath();
                lines.push(`config file: ${cfgPath}${existsSync(cfgPath) ? '' : ' (not written yet)'}`);
                lines.push(`registered tools (${registeredNames.size}): ${[...registeredNames].sort().join(', ') || '(none)'}`);
                if (registrationFailures.length > 0) {
                    lines.push(`registration failures (${registrationFailures.length}):`);
                    for (const failure of registrationFailures)
                        lines.push(`  - ${failure}`);
                }
                lines.push(`binary cache: ${cacheDir()}`);
                lines.push(`pinned release: v${config.pinnedVersion}`);
                if (booted) {
                    lines.push(`binary: ${booted.bin.path} (source: ${booted.bin.source})`);
                    lines.push(`bladebro version: ${booted.client.serverVersion ?? 'unknown'}`);
                }
                lines.push('---');
                lines.push(...runDoctor(booted?.bin.path ?? null).split('\n'));
                return { content: [{ type: 'text', text: lines.join('\n') + '\n' }] };
            },
            presentCall: () => ({ card: 'generic', title: `${config.toolPrefix}_status` }),
            presentResult: (_args, value) => ({
                card: 'generic',
                title: `bladebro ${status}`,
                content: renderContent(value),
            }),
        };
        let dispose;
        try {
            dispose = ctx.tools.register(def);
        }
        catch (err) {
            warn(`could not register status tool: ${err instanceof Error ? err.message : String(err)}`);
            return;
        }
        statusRegistrations.push(dispose);
    }
    function registerTool(rawName, description, inputSchema) {
        const pub = publicToolName(config.toolPrefix, rawName);
        if (pub === null) {
            const reason = `skipping tool ${JSON.stringify(rawName)}: name does not fit the tool-name contract`;
            registrationFailures.push(reason);
            warn(reason);
            return false;
        }
        if (registeredNames.has(pub)) {
            const reason = `skipping duplicate tool name ${pub}`;
            registrationFailures.push(reason);
            warn(reason);
            return false;
        }
        const parameters = specToJsonSchema(toDshSpec(inputSchema));
        const def = {
            name: pub,
            description: description || `${rawName} via Bladebro`,
            parameters,
            output: { schema: {}, render: (_args, value) => renderContent(value) },
            execute: async (args, exec) => {
                const healthy = await ensureDaemon(exec.signal);
                if (!healthy) {
                    const hint = bootError ?? 'not running';
                    throw new Error(`bladebro is unavailable (${hint}); check ${config.toolPrefix}_status for diagnostics`);
                }
                activeCalls++;
                try {
                    const result = await booted.client.callTool(rawName, args, exec?.signal, callTimeoutFor(rawName, args, config.callTimeoutMs));
                    if (result?.isError === true) {
                        const text = joinBlocks(result);
                        throw new Error(text || `bladebro ${rawName} failed`);
                    }
                    return result ?? { content: [{ type: 'text', text: 'No output' }] };
                }
                finally {
                    activeCalls--;
                    refreshWatchBaseline();
                    void maybeSwapUpdate();
                }
            },
            presentCall: (args) => ({
                card: 'generic',
                kind: callKind(pub),
                title: callTitle(pub, args),
                rawInput: args,
            }),
            presentResult: (_args, value) => ({
                card: 'generic',
                title: resultTitle(pub, value),
                content: renderContent(value).slice(0, 4),
            }),
        };
        let dispose;
        try {
            dispose = ctx.tools.register(def);
        }
        catch (err) {
            const reason = `tool ${pub} rejected by the registry: ${err instanceof Error ? err.message : String(err)}`;
            registrationFailures.push(reason);
            warn(reason);
            return false;
        }
        disposers.push(dispose);
        registeredNames.add(pub);
        return true;
    }
    function joinBlocks(result) {
        return (result.content ?? [])
            .map((b) => (typeof b?.text === 'string' ? b.text : ''))
            .join('')
            .trim();
    }
    function resultTitle(pub, value) {
        const blocks = value?.content ?? [];
        if (Array.isArray(blocks) && blocks.some((b) => b?.type === 'image')) {
            return `${pub} \u00B7 screenshot`;
        }
        const text = Array.isArray(blocks) ? joinBlocks(value) : '';
        const line = text ? firstLine(text, 80) : '';
        return line ? `${pub} \u00B7 ${line}` : pub;
    }
    async function boot() {
        const myGen = ++generation;
        status = 'starting';
        const bin = await resolveBinary(config.pinnedVersion, config.fallbackToPath);
        const fresh = new McpClient({
            cmd: [bin.path, 'mcp'],
            callTimeoutMs: config.callTimeoutMs,
            bootTimeoutMs: config.bootTimeoutMs,
        });
        try {
            await fresh.start();
        }
        catch (err) {
            await fresh.dispose(500).catch(() => undefined);
            throw err;
        }
        if (disposed || myGen !== generation) {
            await fresh.dispose(500).catch(() => undefined);
            return;
        }
        booted = { bin, client: fresh };
        status = bin.source === 'path' ? 'degraded' : 'ready';
        bootError = null;
        for (const dispose of disposers.splice(0)) {
            try {
                dispose();
            }
            catch {
                // Already disposed.
            }
        }
        registeredNames.clear();
        registrationFailures.length = 0;
        for (const tool of fresh.tools) {
            registerTool(tool.name, tool.description, tool.inputSchema);
        }
        registerStatusTools();
        refreshWatchBaseline();
        log(`ready: bladebro v${fresh.serverVersion ?? '?'} via ${bin.source} (${bin.path}), ${registeredNames.size} tools as ${config.toolPrefix}_*`);
    }
    async function ensureDaemon(signal) {
        if (disposed)
            return false;
        if (booted !== null && booted.client.healthy)
            return true;
        if (bootLock === null) {
            bootLock = (async () => {
                try {
                    await boot();
                }
                catch (err) {
                    bootError = err instanceof Error ? err.message : String(err);
                    status = 'failed';
                    registerStatusTools();
                }
                finally {
                    bootLock = null;
                }
            })();
        }
        await bootLock;
        if (signal?.aborted)
            return false;
        return booted !== null && booted.client.healthy;
    }
    function restartDaemon() {
        const old = booted;
        booted = null;
        status = 'starting';
        if (old !== null) {
            old.client.kill();
        }
    }
    async function maybeSwapUpdate() {
        if (disposed)
            return;
        if (pendingUpdateVersion === null)
            return;
        if (activeCalls > 0)
            return;
        const version = pendingUpdateVersion;
        pendingUpdateVersion = null;
        if (booted?.bin.version === version)
            return;
        if (await downloadBinaryIfMissing(version)) {
            restartDaemon();
            void ensureDaemon();
            log(`swapped to bladebro v${version}`);
        }
    }
    async function downloadBinaryIfMissing(version) {
        if (installedVersions().some((v) => versionString(v) === version)) {
            return true;
        }
        try {
            await downloadBinary(version, { timeoutMs: 300_000 });
            return true;
        }
        catch (err) {
            warn(`update download for v${version} failed: ${err instanceof Error ? err.message : String(err)}`);
            return false;
        }
    }
    function versionString(v) {
        const pre = v.prerelease.length > 0 ? `-${v.prerelease.join('.')}` : '';
        return `${v.major}.${v.minor}.${v.patch}${pre}`;
    }
    const teardown = async () => {
        if (disposed)
            return;
        disposed = true;
        generation++;
        for (const dispose of disposers.splice(0)) {
            try {
                dispose();
            }
            catch {
                // Already run.
            }
        }
        for (const dispose of statusRegistrations.splice(0)) {
            try {
                dispose();
            }
            catch {
                // Already run.
            }
        }
        const client = booted?.client;
        booted = null;
        if (client)
            await client.dispose(1500);
        if (restartTimer !== null) {
            clearTimeout(restartTimer);
            restartTimer = null;
            armedMtime = null;
        }
    };
    ctx.effect(() => {
        registerStatusTools();
        void boot().catch((err) => {
            bootError = err instanceof Error ? err.message : String(err);
            status = 'failed';
            registerStatusTools();
        });
        return () => {
            void teardown();
        };
    }, 'bladebro-lifecycle');
    const watchEntries = [{ path: bladebroConfigPath(), lastMtime: null }];
    let restartTimer = null;
    let armedMtime = null;
    const recordMtime = (path) => {
        try {
            return statSync(path).mtimeMs;
        }
        catch {
            return null;
        }
    };
    const refreshWatchBaseline = () => {
        for (const entry of watchEntries) {
            entry.lastMtime = recordMtime(entry.path);
        }
        if (restartTimer !== null) {
            clearTimeout(restartTimer);
            restartTimer = null;
            armedMtime = null;
        }
    };
    for (const entry of watchEntries) {
        entry.lastMtime = recordMtime(entry.path);
    }
    for (const entry of watchEntries) {
        try {
            watchFile(entry.path, { persistent: false, interval: 1200 }, () => {
                const mtime = recordMtime(entry.path);
                if (mtime === null) {
                    entry.lastMtime = null;
                    return;
                }
                entry.lastMtime = mtime;
                if (activeCalls > 0 || disposed)
                    return;
                if (restartTimer !== null)
                    return;
                armedMtime = mtime;
                restartTimer = setTimeout(() => {
                    restartTimer = null;
                    const latest = recordMtime(entry.path);
                    if (latest !== armedMtime) {
                        armedMtime = null;
                        return;
                    }
                    armedMtime = null;
                    if (disposed)
                        return;
                    log(`bladebro config changed on disk (${entry.path}); restarting daemon`);
                    restartDaemon();
                    void ensureDaemon();
                }, 800);
            });
        }
        catch {
            warn(`could not watch ${entry.path}; CLI config changes will apply after the next dsh restart`);
        }
    }
    ctx.effect(() => {
        return () => {
            for (const entry of watchEntries) {
                try {
                    unwatchFile(entry.path);
                }
                catch {
                    // Never watched.
                }
            }
            if (restartTimer !== null) {
                clearTimeout(restartTimer);
                restartTimer = null;
            }
        };
    }, 'bladebro-config-watch');
    if (config.autoUpdate) {
        ctx.effect(() => {
            let cancelled = false;
            void (async () => {
                try {
                    await ensureDaemon();
                    if (cancelled || booted === null)
                        return;
                    const current = booted.bin.source === 'release' ? booted.bin.version : config.pinnedVersion;
                    const info = await checkForUpdate(current, config.channel, config.updateIntervalHours);
                    if (cancelled)
                        return;
                    if (info?.newer === true) {
                        pendingUpdateVersion = info.latest;
                        log(`newer bladebro v${info.latest} found (running v${current}); will swap between calls`);
                        void maybeSwapUpdate();
                    }
                }
                catch {
                    // Updates are best-effort; tool service is unaffected.
                }
            })();
            return () => {
                cancelled = true;
            };
        }, 'bladebro-update-check');
    }
    log(`plugin v${PLUGIN_VERSION} loaded; bladebro v${config.pinnedVersion}+ via the ${config.toolPrefix}_* tools`);
    return { dispose: () => teardown() };
}
