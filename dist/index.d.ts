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
import type { Context } from '@deepseek-ai/cordis';
import type { ContentBlock } from '@deepseek-ai/dsh-tools';
export declare const name = "bladebro";
export declare const inject: readonly ["tools"];
export type UpdateChannel = 'stable' | 'latest';
export interface BladebroConfig {
    /** Model-facing tool prefix; default bladebro. */
    toolPrefix?: string;
    /** Release channel for auto-updates. */
    channel?: UpdateChannel;
    /** Auto-download+swap newer bladebro releases. Default true. */
    autoUpdate?: boolean;
    /** Minimum gap between update checks, hours. Default 24. */
    updateIntervalHours?: number;
    /** Per-call MCP timeout, ms. Default 180000. */
    callTimeoutMs?: number;
    /** Initialize + tools/list timeout, ms. Default 25000. */
    bootTimeoutMs?: number;
    /** Fall back to a bladebro already on PATH when download fails. */
    fallbackToPath?: boolean;
    /** bladebro release pinned for fresh installs (floor, not ceiling). */
    pinnedVersion?: string;
}
/**
 * Derive per-call timeout from the tool's own timeout parameters so long
 * waits, multi-step `run` programs, and `collect` sweeps are never cut
 * prematurely by a lower default `callTimeoutMs`.
 */
export declare function callTimeoutFor(toolName: string, args: unknown, baseMs: number): number;
/** Resolve Bladebro's home directory (`BLADE_HOME` or default `~/.bladebro`). */
export declare function bladebroHomeDir(): string;
/** Resolve Bladebro's config file (`$BLADE_HOME/config.toml`). */
export declare function bladebroConfigPath(): string;
/**
 * Project MCP result blocks into model-facing dsh ContentBlocks.
 * Text and base64 image blocks (`vision` screenshots) pass through
 * intact so vision-capable models receive real PNG/JPEG/WebP data.
 */
export declare function renderContent(value: unknown): ContentBlock[];
export declare function apply(ctx: Context, rawConfig?: BladebroConfig): {
    dispose(): Promise<void>;
};
