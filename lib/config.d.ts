/**
 * Configuration shared by the settings sync and the object-storage credential
 * provider: which bucket holds the synced documents, how to authenticate, how
 * often to look for another machine's committed writes, and which profile
 * entries the settings document carries.
 *
 * The sync entry (`oss-settings`) declares every field `.volatile()`: Harness
 * 0.1.7 projects volatile Config fields into the settings forms, so the
 * Plugins-page section edits them through `ctx.settings` and the profile's
 * `cordis.patch.yml`, and the Loader commits an edit into the running
 * references without remounting the plugin. The credentials entry keeps plain
 * fields: they are only its cold-start bootstrap, and it follows the sync
 * entry's connection once that is in hand.
 *
 * @module dsh-oss-sync/config
 */
import z from '@deepseek-ai/schemastery';
import type { StoredConnection } from './envelope.js';
/**
 * Profile entries the settings document never carries unless `include` names
 * them: the shell executors hold this machine's working directory and
 * executable paths, and the two rows of this plugin hold its own connection.
 */
export declare const DEFAULT_EXCLUDE: readonly string[];
/** This plugin's own rows; never synced, whatever `include` says. */
export declare const OWN_ENTRIES: readonly string[];
/** Plain configuration: what either half acts on once volatile references are read. */
export interface Config {
    /**
     * Bucket holding the synced documents. Empty means "not configured yet": the
     * providers run local-only — settings stay in the profile, credentials in
     * this machine's cache — and the Plugins-page section is where one is set.
     */
    bucket?: string;
    /** Endpoint of an S3-compatible service (MinIO, Ceph, COS); omit for AWS itself. */
    endpoint?: string;
    /** Region sent with every request; a gateway that ignores regions still needs one. */
    region?: string;
    /** Key prefix inside the bucket; the two documents live directly under it. */
    prefix?: string;
    /** Opt into path-style addressing for services such as MinIO; standard S3-compatible endpoints use virtual hosts. */
    forcePathStyle?: boolean;
    /** Environment variable holding the access key id; defaults to `DSH_SYNC_ACCESS_KEY_ID`. */
    accessKeyIdEnv?: string;
    /** Environment variable holding the secret access key; defaults to `DSH_SYNC_SECRET_ACCESS_KEY`. */
    secretAccessKeyEnv?: string;
    /** Milliseconds between polls for another machine's committed writes. */
    pollMs?: number;
    /**
     * Access key id for the bucket. Stored in this profile only (its
     * `cordis.patch.yml`), never in the bucket, which could not be read without
     * it. An empty string together with an empty secret clears the pair and the
     * machine-wide one a 0.1.x install left behind.
     */
    accessKeyId?: string;
    /** Secret access key for the bucket, kept like {@link Config.accessKeyId}; redacted from every wire read. */
    secretAccessKey?: string;
    /** Profile entry ids to sync; empty syncs every entry the settings service describes. */
    include?: string[];
    /** Profile entry ids never synced; defaults to {@link DEFAULT_EXCLUDE}. */
    exclude?: string[];
    /**
     * A sync request from the Plugins page, written as `<verb>:<token>`; any
     * change runs the verb. `pull` reconciles with the bucket now; `push`
     * re-commits this profile's document over it.
     */
    request?: string;
    /** Directory holding the device id, the credential cache, and the sync baselines. */
    stateDir?: string;
}
/** Schema of the settings sync entry (`oss-settings`). */
export declare const SyncConfigSchema: z<Schemastery.ObjectS<NoInfer<{
    stateDir: z<string, string, "plain">;
    bucket: z<string, string, "volatile-defined">;
    endpoint: z<string, string, "volatile">;
    region: z<string, string, "volatile-defined">;
    prefix: z<string, string, "volatile-defined">;
    forcePathStyle: z<boolean, boolean, "volatile-defined">;
    accessKeyIdEnv: z<string, string, "volatile-defined">;
    secretAccessKeyEnv: z<string, string, "volatile-defined">;
    pollMs: z<number, number, "volatile-defined">;
    accessKeyId: z<string, string, "volatile">;
    secretAccessKey: z<string, string, "volatile">;
    include: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    exclude: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    request: z<string, string, "volatile">;
    /**
     * Runtime status, published by this plugin into its own running reference
     * so the settings forms carry it to the Plugins page. Never persisted by the
     * plugin; a value a hand edit stores is overwritten by the next report.
     */
    status: z<any, any, "volatile">;
}>>, Schemastery.ObjectT<NoInfer<{
    stateDir: z<string, string, "plain">;
    bucket: z<string, string, "volatile-defined">;
    endpoint: z<string, string, "volatile">;
    region: z<string, string, "volatile-defined">;
    prefix: z<string, string, "volatile-defined">;
    forcePathStyle: z<boolean, boolean, "volatile-defined">;
    accessKeyIdEnv: z<string, string, "volatile-defined">;
    secretAccessKeyEnv: z<string, string, "volatile-defined">;
    pollMs: z<number, number, "volatile-defined">;
    accessKeyId: z<string, string, "volatile">;
    secretAccessKey: z<string, string, "volatile">;
    include: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    exclude: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    request: z<string, string, "volatile">;
    /**
     * Runtime status, published by this plugin into its own running reference
     * so the settings forms carry it to the Plugins page. Never persisted by the
     * plugin; a value a hand edit stores is overwritten by the next report.
     */
    status: z<any, any, "volatile">;
}>>, "plain">;
/** Schema of the credential provider entry (`oss-credentials`): plain bootstrap fields. */
export declare const CredentialsConfigSchema: z<Config>;
/**
 * Read a parsed Config into plain values, unwrapping every volatile reference.
 * References must be read per operation, so callers call this each time they
 * act rather than keeping its result.
 * @param config - the Config the plugin was constructed with.
 * @returns the plain values in force now.
 */
export declare function readConfig(config: unknown): Config;
/** Every connection parameter with its default applied. */
export interface ResolvedConfig {
    bucket: string;
    endpoint?: string;
    region: string;
    prefix: string;
    forcePathStyle: boolean;
    accessKeyIdEnv: string;
    secretAccessKeyEnv: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    pollMs: number;
    stateDir: string;
}
/**
 * Resolve the harness home the way the rest of the product does.
 * @returns the configured `$DSH_HOME`, else `~/.dsh`.
 */
export declare function resolveDshHome(): string;
/**
 * Resolve plain Config into the parameters a store is built from, so
 * defaulting happens in one explicit step rather than inline at each use.
 * @param config - plain Config.
 * @returns the resolved parameters.
 */
export declare function resolveConfig(config: Config): ResolvedConfig;
/**
 * Whether Config explicitly clears the bucket credentials: both fields saved
 * as empty strings. That is how the page says "forget the pair", which also
 * retires the machine-wide pair a 0.1.x install saved.
 * @param config - plain Config.
 * @returns whether the pair is explicitly cleared.
 */
export declare function clearsConnection(config: Config): boolean;
/**
 * Fold the machine-wide pair a 0.1.x install saved under the resolved
 * parameters. It is a fallback layer only: a pair in Config wins, and a
 * cleared pair ignores it.
 * @param base - parameters resolved from Config and the environment.
 * @param connection - the machine-wide pair, when one exists.
 * @param cleared - whether Config explicitly cleared the pair.
 * @returns the parameters a store should use.
 */
export declare function mergeConnection(base: ResolvedConfig, connection: StoredConnection | undefined, cleared?: boolean): ResolvedConfig;
/**
 * Whether two resolved parameter sets address the same storage the same way.
 * @param left - one parameter set.
 * @param right - the other parameter set.
 * @returns whether a rebuild would reach the same object with the same signature.
 */
export declare function sameConnection(left: ResolvedConfig, right: ResolvedConfig): boolean;
/**
 * The storage location a baseline belongs to; switching bucket, endpoint, or
 * prefix starts the settings sync over at the new location.
 * @param spec - the resolved parameters.
 * @returns a stable key for the location.
 */
export declare function locationKey(spec: ResolvedConfig): string;
