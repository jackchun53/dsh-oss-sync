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

import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { isVolatile } from '@deepseek-ai/cosmokit'
import z from '@deepseek-ai/schemastery'
import type { StoredConnection } from './envelope.js'

/**
 * Profile entries the settings document never carries unless `include` names
 * them: the shell executors hold this machine's working directory and
 * executable paths, and the two rows of this plugin hold its own connection.
 */
export const DEFAULT_EXCLUDE: readonly string[] = [
  'pwsh-sandbox', 'bash-sandbox', 'pwsh-local', 'bash-local', 'shell',
]

/** This plugin's own rows; never synced, whatever `include` says. */
export const OWN_ENTRIES: readonly string[] = ['oss-settings', 'oss-credentials']

/** Plain configuration: what either half acts on once volatile references are read. */
export interface Config {
  /**
   * Bucket holding the synced documents. Empty means "not configured yet": the
   * providers run local-only — settings stay in the profile, credentials in
   * this machine's cache — and the Plugins-page section is where one is set.
   */
  bucket?: string
  /** Endpoint of an S3-compatible service (MinIO, Ceph, COS); omit for AWS itself. */
  endpoint?: string
  /** Region sent with every request; a gateway that ignores regions still needs one. */
  region?: string
  /** Key prefix inside the bucket; the two documents live directly under it. */
  prefix?: string
  /** Opt into path-style addressing for services such as MinIO; standard S3-compatible endpoints use virtual hosts. */
  forcePathStyle?: boolean
  /** Environment variable holding the access key id; defaults to `DSH_SYNC_ACCESS_KEY_ID`. */
  accessKeyIdEnv?: string
  /** Environment variable holding the secret access key; defaults to `DSH_SYNC_SECRET_ACCESS_KEY`. */
  secretAccessKeyEnv?: string
  /** Milliseconds between polls for another machine's committed writes. */
  pollMs?: number
  /**
   * Access key id for the bucket. Stored in this profile only (its
   * `cordis.patch.yml`), never in the bucket, which could not be read without
   * it. An empty string together with an empty secret clears the pair and the
   * machine-wide one a 0.1.x install left behind.
   */
  accessKeyId?: string
  /** Secret access key for the bucket, kept like {@link Config.accessKeyId}; redacted from every wire read. */
  secretAccessKey?: string
  /** Profile entry ids to sync; empty syncs every entry the settings service describes. */
  include?: string[]
  /** Profile entry ids never synced; defaults to {@link DEFAULT_EXCLUDE}. */
  exclude?: string[]
  /**
   * A sync request from the Plugins page, written as `<verb>:<token>`; any
   * change runs the verb. `pull` reconciles with the bucket now; `push`
   * re-commits this profile's document over it.
   */
  request?: string
  /** Directory holding the device id, the credential cache, and the sync baselines. */
  stateDir?: string
}

/** The fields the settings sync reads live; every one of them is a volatile Config field. */
const liveFields = {
  bucket: z.string().default('').volatile(),
  endpoint: z.string().volatile(),
  region: z.string().default('us-east-1').volatile(),
  prefix: z.string().default('dsh-sync').volatile(),
  forcePathStyle: z.boolean().default(false).volatile(),
  accessKeyIdEnv: z.string().default('DSH_SYNC_ACCESS_KEY_ID').volatile(),
  secretAccessKeyEnv: z.string().default('DSH_SYNC_SECRET_ACCESS_KEY').volatile(),
  pollMs: z.number().min(1000).default(30_000).volatile(),
  accessKeyId: z.string().volatile(),
  secretAccessKey: z.string().role('secret').volatile(),
  include: z.array(z.string()).default([]).volatile(),
  exclude: z.array(z.string()).default([...DEFAULT_EXCLUDE]).volatile(),
  request: z.string().volatile(),
  /**
   * Runtime status, published by this plugin into its own running reference
   * so the settings forms carry it to the Plugins page. Never persisted by the
   * plugin; a value a hand edit stores is overwritten by the next report.
   */
  status: z.any().volatile(),
}

/** Schema of the settings sync entry (`oss-settings`). */
export const SyncConfigSchema = z.object({
  ...liveFields,
  stateDir: z.string(),
})

/** Schema of the credential provider entry (`oss-credentials`): plain bootstrap fields. */
export const CredentialsConfigSchema: z<Config> = z.object({
  bucket: z.string().default(''),
  endpoint: z.string(),
  region: z.string().default('us-east-1'),
  prefix: z.string().default('dsh-sync'),
  forcePathStyle: z.boolean().default(false),
  accessKeyIdEnv: z.string().default('DSH_SYNC_ACCESS_KEY_ID'),
  secretAccessKeyEnv: z.string().default('DSH_SYNC_SECRET_ACCESS_KEY'),
  pollMs: z.number().min(1000).default(30_000),
  accessKeyId: z.string(),
  secretAccessKey: z.string(),
  stateDir: z.string(),
})

/**
 * Read a parsed Config into plain values, unwrapping every volatile reference.
 * References must be read per operation, so callers call this each time they
 * act rather than keeping its result.
 * @param config - the Config the plugin was constructed with.
 * @returns the plain values in force now.
 */
export function readConfig(config: unknown): Config {
  if (typeof config !== 'object' || config === null) return {}
  const plain: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config)) {
    const current: unknown = isVolatile(value) ? value.get() : value
    if (current !== undefined) plain[key] = Array.isArray(current) ? [...current as unknown[]] : current
  }
  return plain as Config
}

/** Every connection parameter with its default applied. */
export interface ResolvedConfig {
  bucket: string
  endpoint?: string
  region: string
  prefix: string
  forcePathStyle: boolean
  accessKeyIdEnv: string
  secretAccessKeyEnv: string
  accessKeyId?: string
  secretAccessKey?: string
  pollMs: number
  stateDir: string
}

/**
 * Normalize a connection field that the page may clear by emptying it: an
 * empty string is how a text input says "none", not a credential.
 * @param value - the field as configured or stored.
 * @returns the value, or `undefined` when it addresses nothing.
 */
function clearable(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/** Normalize a custom endpoint; the AWS SDK requires an absolute URL. */
function endpointUrl(value: string | undefined): string | undefined {
  const endpoint = clearable(value)
  if (endpoint === undefined) return undefined
  return /^[a-z][a-z\d+.-]*:\/\//iu.test(endpoint) ? endpoint : `https://${endpoint}`
}

/**
 * Resolve the harness home the way the rest of the product does.
 * @returns the configured `$DSH_HOME`, else `~/.dsh`.
 */
export function resolveDshHome(): string {
  const configured = process.env['DSH_HOME']
  return configured !== undefined && configured.trim().length > 0
    ? resolve(configured)
    : join(homedir(), '.dsh')
}

/**
 * Resolve plain Config into the parameters a store is built from, so
 * defaulting happens in one explicit step rather than inline at each use.
 * @param config - plain Config.
 * @returns the resolved parameters.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const stateDir = config.stateDir ?? join(resolveDshHome(), '.dsh-oss-sync')
  const accessKeyId = clearable(config.accessKeyId)
  const secretAccessKey = clearable(config.secretAccessKey)
  const endpoint = endpointUrl(config.endpoint)
  return {
    bucket: config.bucket?.trim() ?? '',
    ...endpoint === undefined ? {} : { endpoint },
    region: config.region?.trim() || 'us-east-1',
    prefix: (config.prefix ?? 'dsh-sync').trim().replace(/\/+$/u, ''),
    forcePathStyle: config.forcePathStyle ?? false,
    accessKeyIdEnv: config.accessKeyIdEnv ?? 'DSH_SYNC_ACCESS_KEY_ID',
    secretAccessKeyEnv: config.secretAccessKeyEnv ?? 'DSH_SYNC_SECRET_ACCESS_KEY',
    pollMs: config.pollMs ?? 30_000,
    ...accessKeyId === undefined ? {} : { accessKeyId },
    ...secretAccessKey === undefined ? {} : { secretAccessKey },
    stateDir: isAbsolute(stateDir) ? stateDir : resolve(stateDir),
  }
}

/**
 * Whether Config explicitly clears the bucket credentials: both fields saved
 * as empty strings. That is how the page says "forget the pair", which also
 * retires the machine-wide pair a 0.1.x install saved.
 * @param config - plain Config.
 * @returns whether the pair is explicitly cleared.
 */
export function clearsConnection(config: Config): boolean {
  return config.accessKeyId?.trim() === '' && config.secretAccessKey?.trim() === ''
}

/**
 * Fold the machine-wide pair a 0.1.x install saved under the resolved
 * parameters. It is a fallback layer only: a pair in Config wins, and a
 * cleared pair ignores it.
 * @param base - parameters resolved from Config and the environment.
 * @param connection - the machine-wide pair, when one exists.
 * @param cleared - whether Config explicitly cleared the pair.
 * @returns the parameters a store should use.
 */
export function mergeConnection(
  base: ResolvedConfig, connection: StoredConnection | undefined, cleared = false,
): ResolvedConfig {
  if (cleared || connection === undefined) return base
  if (base.accessKeyId !== undefined || base.secretAccessKey !== undefined) return base
  return {
    ...base,
    ...connection.accessKeyId === undefined ? {} : { accessKeyId: connection.accessKeyId },
    ...connection.secretAccessKey === undefined ? {} : { secretAccessKey: connection.secretAccessKey },
  }
}

/**
 * Whether two resolved parameter sets address the same storage the same way.
 * @param left - one parameter set.
 * @param right - the other parameter set.
 * @returns whether a rebuild would reach the same object with the same signature.
 */
export function sameConnection(left: ResolvedConfig, right: ResolvedConfig): boolean {
  return left.bucket === right.bucket
    && left.endpoint === right.endpoint
    && left.region === right.region
    && left.forcePathStyle === right.forcePathStyle
    && left.accessKeyIdEnv === right.accessKeyIdEnv
    && left.secretAccessKeyEnv === right.secretAccessKeyEnv
    && left.accessKeyId === right.accessKeyId
    && left.secretAccessKey === right.secretAccessKey
}

/**
 * The storage location a baseline belongs to; switching bucket, endpoint, or
 * prefix starts the settings sync over at the new location.
 * @param spec - the resolved parameters.
 * @returns a stable key for the location.
 */
export function locationKey(spec: ResolvedConfig): string {
  return JSON.stringify([spec.endpoint ?? '', spec.bucket, spec.prefix])
}
