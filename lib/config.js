/**
 * Configuration shared by the object-storage settings and credential
 * providers: which bucket holds the synced documents, how to authenticate,
 * and how often to look for another machine's committed writes.
 *
 * @module dsh-oss-sync/config
 */
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import z from '@deepseek-ai/schemastery';
/** Schemastery schema for {@link Config}; the loader validates entry config against it. */
export const ConfigSchema = z.object({
    bucket: z.string().required(),
    endpoint: z.string(),
    region: z.string().default('us-east-1'),
    prefix: z.string().default('dsh-sync'),
    forcePathStyle: z.boolean().default(true),
    accessKeyIdEnv: z.string().default('DSH_SYNC_ACCESS_KEY_ID'),
    secretAccessKeyEnv: z.string().default('DSH_SYNC_SECRET_ACCESS_KEY'),
    pollMs: z.number().min(1000).default(30_000),
    stateDir: z.string(),
});
/**
 * Resolve the harness home the way the rest of the product does.
 * @returns the configured `$DSH_HOME`, else `~/.dsh`.
 */
export function resolveDshHome() {
    const configured = process.env['DSH_HOME'];
    return configured !== undefined && configured.trim().length > 0
        ? resolve(configured)
        : join(homedir(), '.dsh');
}
/**
 * Resolve entry config into every parameter the providers act on, so
 * defaulting happens in one explicit step rather than inline at each use.
 * @param config - raw entry config.
 * @returns the resolved parameters.
 */
export function resolveConfig(config) {
    const stateDir = config.stateDir ?? join(resolveDshHome(), '.dsh-oss-sync');
    return {
        bucket: config.bucket,
        ...config.endpoint === undefined ? {} : { endpoint: config.endpoint },
        region: config.region ?? 'us-east-1',
        prefix: (config.prefix ?? 'dsh-sync').replace(/\/+$/u, ''),
        forcePathStyle: config.forcePathStyle ?? true,
        accessKeyIdEnv: config.accessKeyIdEnv ?? 'DSH_SYNC_ACCESS_KEY_ID',
        secretAccessKeyEnv: config.secretAccessKeyEnv ?? 'DSH_SYNC_SECRET_ACCESS_KEY',
        pollMs: config.pollMs ?? 30_000,
        stateDir: isAbsolute(stateDir) ? stateDir : resolve(stateDir),
    };
}
