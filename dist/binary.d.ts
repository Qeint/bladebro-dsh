/**
 * Binary provisioning: resolve an existing bladebro binary, download
 * and SHA256-verify one from GitHub Releases when missing, install it
 * atomically into its own versioned cache directory, and check for
 * newer releases on a throttled schedule. Zero external dependencies.
 */
import { type Semver } from './version.js';
interface PlatformInfo {
    key: string;
    asset: string;
    supported: boolean;
}
export declare const PLATFORM: PlatformInfo;
export declare function cacheDir(): string;
export declare function binDir(version: string): string;
export declare function binaryAt(version: string): string;
export declare function installedVersions(): Semver[];
export interface ResolvedBinary {
    path: string;
    version: string;
    source: 'release' | 'path';
}
export interface DownloadOptions {
    timeoutMs?: number;
    onProgress?(state: string): void;
}
export declare function resolveBinary(pinned: string, allowPathFallback: boolean, options?: DownloadOptions): Promise<ResolvedBinary>;
export declare function downloadBinary(version: string, options?: DownloadOptions): Promise<string>;
export interface HttpResult {
    ok: boolean;
    status: number;
    drain(): Promise<void>;
    text(maxBytes: number): Promise<string>;
    [Symbol.asyncIterator](): AsyncIterator<Buffer>;
}
export interface UpdateInfo {
    current: string;
    latest: string;
    newer: boolean;
}
export declare function checkForUpdate(currentVersion: string, channel: 'stable' | 'latest', intervalHours: number): Promise<UpdateInfo | null>;
export {};
