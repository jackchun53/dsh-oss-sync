/**
 * Configuration shared by the object-storage settings and credential
 * providers: which bucket holds the synced documents, how to authenticate,
 * and how often to look for another machine's committed writes.
 *
 * Two layers feed the resolved parameters. The entry config is the bootstrap —
 * it is what a cold start needs before anything has been read — and the
 * `oss-sync` settings namespace overrides it once the document is in hand, so
 * the settings page can change the connection without editing cordis.yml.
 *
 * @module dsh-oss-sync/config
 */
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import z from '@deepseek-ai/schemastery';
/** Schemastery schema for {@link Config}; the loader validates entry config against it. */
export const ConfigSchema = z.object({
    bucket: z.string().default(''),
    endpoint: z.string(),
    region: z.string().default('us-east-1'),
    prefix: z.string().default('dsh-sync'),
    forcePathStyle: z.boolean().default(true),
    accessKeyIdEnv: z.string().default('DSH_SYNC_ACCESS_KEY_ID'),
    secretAccessKeyEnv: z.string().default('DSH_SYNC_SECRET_ACCESS_KEY'),
    pollMs: z.number().min(1000).default(30_000),
    accessKeyId: z.string(),
    secretAccessKey: z.string(),
    stateDir: z.string(),
});
/**
 * Normalize a connection field that the settings page may clear by emptying it:
 * an empty string is how a text input says "none", not a credential.
 * @param value - the field as configured or stored.
 * @returns the value, or `undefined` when it addresses nothing.
 */
function clearable(value) {
    return value === undefined || value.length === 0 ? undefined : value;
}
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
 * Resolve the entry config into the parameters a cold start runs on, so
 * defaulting happens in one explicit step rather than inline at each use.
 * @param config - raw entry config.
 * @returns the resolved parameters.
 */
export function resolveConfig(config) {
    const stateDir = config.stateDir ?? join(resolveDshHome(), '.dsh-oss-sync');
    const accessKeyId = clearable(config.accessKeyId);
    const secretAccessKey = clearable(config.secretAccessKey);
    return {
        bucket: config.bucket ?? '',
        ...config.endpoint === undefined ? {} : { endpoint: config.endpoint },
        region: config.region ?? 'us-east-1',
        prefix: (config.prefix ?? 'dsh-sync').replace(/\/+$/u, ''),
        forcePathStyle: config.forcePathStyle ?? true,
        accessKeyIdEnv: config.accessKeyIdEnv ?? 'DSH_SYNC_ACCESS_KEY_ID',
        secretAccessKeyEnv: config.secretAccessKeyEnv ?? 'DSH_SYNC_SECRET_ACCESS_KEY',
        pollMs: config.pollMs ?? 30_000,
        ...accessKeyId === undefined ? {} : { accessKeyId },
        ...secretAccessKey === undefined ? {} : { secretAccessKey },
        stateDir: isAbsolute(stateDir) ? stateDir : resolve(stateDir),
    };
}
/**
 * Fold the settings namespace over the bootstrap parameters.
 * @param base - parameters resolved from the entry config.
 * @param overrides - the effective `oss-sync` namespace value.
 * @returns the parameters the providers act on now.
 */
export function applyOverrides(base, overrides) {
    if (overrides === undefined)
        return base;
    const prefix = overrides.prefix ?? base.prefix;
    const accessKeyId = clearable(overrides.accessKeyId ?? base.accessKeyId);
    const secretAccessKey = clearable(overrides.secretAccessKey ?? base.secretAccessKey);
    return {
        bucket: overrides.bucket ?? base.bucket,
        ...(overrides.endpoint ?? base.endpoint) === undefined ? {} : { endpoint: overrides.endpoint ?? base.endpoint },
        region: overrides.region ?? base.region,
        prefix: prefix.replace(/\/+$/u, ''),
        forcePathStyle: overrides.forcePathStyle ?? base.forcePathStyle,
        accessKeyIdEnv: overrides.accessKeyIdEnv ?? base.accessKeyIdEnv,
        secretAccessKeyEnv: overrides.secretAccessKeyEnv ?? base.secretAccessKeyEnv,
        ...accessKeyId === undefined ? {} : { accessKeyId },
        ...secretAccessKey === undefined ? {} : { secretAccessKey },
        pollMs: overrides.pollMs ?? base.pollMs,
        stateDir: base.stateDir,
    };
}
/**
 * Fold the credentials the settings page saved on this machine over the entry
 * config. They are a bootstrap layer: the store needs them before the first
 * read, which is earlier than any namespace resolves.
 * @param base - parameters resolved from the entry config and the environment.
 * @param connection - this machine's stored pair, when it has one.
 * @returns the parameters a cold start should use.
 */
export function mergeConnection(base, connection) {
    return {
        ...base,
        ...connection?.accessKeyId === undefined ? {} : { accessKeyId: connection.accessKeyId },
        ...connection?.secretAccessKey === undefined ? {} : { secretAccessKey: connection.secretAccessKey },
    };
}
/**
 * Whether two resolved parameters address the same storage the same way.
 * @param left - one parameter set.
 * @param right - the other parameter set.
 * @returns whether a rebuild would reach the same object with the same signature.
 */
export function sameConnection(left, right) {
    return left.bucket === right.bucket
        && left.endpoint === right.endpoint
        && left.region === right.region
        && left.forcePathStyle === right.forcePathStyle
        && left.accessKeyIdEnv === right.accessKeyIdEnv
        && left.secretAccessKeyEnv === right.secretAccessKeyEnv
        && left.accessKeyId === right.accessKeyId
        && left.secretAccessKey === right.secretAccessKey;
}
