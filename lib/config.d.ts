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
import z from '@deepseek-ai/schemastery';
/** Entry config: the bootstrap values a cold start needs. */
export interface Config {
    /** Bucket holding the synced documents. */
    bucket: string;
    /** Endpoint of an S3-compatible service (MinIO, Ceph, COS); omit for AWS itself. */
    endpoint?: string;
    /** Region sent with every request; a gateway that ignores regions still needs one. */
    region?: string;
    /** Key prefix inside the bucket; the two documents live directly under it. */
    prefix?: string;
    /** Path-style addressing, which MinIO and most self-hosted gateways require. */
    forcePathStyle?: boolean;
    /** Environment variable holding the access key id; defaults to `DSH_SYNC_ACCESS_KEY_ID`. */
    accessKeyIdEnv?: string;
    /** Environment variable holding the secret access key; defaults to `DSH_SYNC_SECRET_ACCESS_KEY`. */
    secretAccessKeyEnv?: string;
    /** Milliseconds between polls for another machine's committed writes. */
    pollMs?: number;
    /** Directory holding the device id and the offline read cache. */
    stateDir?: string;
}
/** Schemastery schema for {@link Config}; the loader validates entry config against it. */
export declare const ConfigSchema: z<Config>;
/** Connection parameters a settings namespace may override. */
export interface SpecOverrides {
    bucket?: string;
    endpoint?: string;
    region?: string;
    prefix?: string;
    forcePathStyle?: boolean;
    accessKeyIdEnv?: string;
    secretAccessKeyEnv?: string;
    pollMs?: number;
}
/** Every parameter with its default applied; programmatic construction bypasses the schema. */
export interface ResolvedConfig {
    bucket: string;
    endpoint?: string;
    region: string;
    prefix: string;
    forcePathStyle: boolean;
    accessKeyIdEnv: string;
    secretAccessKeyEnv: string;
    pollMs: number;
    stateDir: string;
}
/**
 * Resolve the harness home the way the rest of the product does.
 * @returns the configured `$DSH_HOME`, else `~/.dsh`.
 */
export declare function resolveDshHome(): string;
/**
 * Resolve the entry config into the parameters a cold start runs on, so
 * defaulting happens in one explicit step rather than inline at each use.
 * @param config - raw entry config.
 * @returns the resolved parameters.
 */
export declare function resolveConfig(config: Config): ResolvedConfig;
/**
 * Fold the settings namespace over the bootstrap parameters.
 * @param base - parameters resolved from the entry config.
 * @param overrides - the effective `oss-sync` namespace value.
 * @returns the parameters the providers act on now.
 */
export declare function applyOverrides(base: ResolvedConfig, overrides: SpecOverrides | undefined): ResolvedConfig;
/**
 * Whether two resolved parameters address the same storage the same way.
 * @param left - one parameter set.
 * @param right - the other parameter set.
 * @returns whether a rebuild would reach the same object with the same signature.
 */
export declare function sameConnection(left: ResolvedConfig, right: ResolvedConfig): boolean;
