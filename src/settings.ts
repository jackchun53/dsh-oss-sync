/**
 * Settings sync over the Harness 0.1.7 settings service.
 *
 * Harness 0.1.7 has no settings document store to replace: every configurable
 * value is a plugin's volatile Config field, `ctx.settings` projects those
 * fields into forms, and a write lands in the active profile's
 * `cordis.patch.yml` through the configuration editor. So this half no longer
 * sits under the seam. It sits beside it, as a client of the public API:
 *
 * - it reads the profile's form sections with `describe({ redactSecrets })`,
 *   so secrets never leave the machine, and leaves `!!js` expressions out;
 * - it keeps one object in the bucket mapping entry id to section, wrapped in
 *   the revision envelope and written under an ETag precondition;
 * - it applies a section another machine committed with `replace()` fenced by
 *   the entry's describe revision, restoring this profile's own secrets and
 *   expressions into the section first;
 * - it reconciles per entry against the baseline of its last sync, recorded
 *   after every apply, so an applied change is never uploaded back.
 *
 * It also owns the connection: its own Config is what the Plugins-page
 * section edits, and it provides `ossSyncControl`, through which the credential
 * provider follows that connection and reports its status.
 *
 * @module dsh-oss-sync/settings
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { createVolatile, isVolatile, updateVolatile } from '@deepseek-ai/cosmokit'
import type { SettingsForms } from '@deepseek-ai/dsh-settings'
import {
  DEFAULT_EXCLUDE, OWN_ENTRIES, SyncConfigSchema, clearsConnection, locationKey, mergeConnection, readConfig,
  resolveConfig, resolveDshHome, sameConnection, type Config, type ResolvedConfig,
} from './config.js'
import {
  LEGACY_SYNC_NAMESPACE, SYNC_ENTRY, requestVerb, type SyncControl, type SyncParticipant, type SyncStatus,
  type SyncStatusMap,
} from './control.js'
import {
  aliasDocument, expressionPaths, getPath, isMapping, isSynced, planSync, sameSection, setPath, withoutExpressions,
  type SettingsDocument, type SyncBaseline,
} from './document.js'
import { ENVELOPE_VERSION, SyncState, encodeEnvelope, parseEnvelope, type Envelope, type StoredConnection } from './envelope.js'
import { PollLoop } from './poll.js'
import { ObjectStore, PreconditionFailedError } from './store.js'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Instance-local notice from the Loader after it committed volatile Config values. */
    'loader/volatile-update'(paths: readonly (readonly string[])[]): void
  }
}

/** This half's key in the status map. */
const STATUS_LABEL = 'settings'

/** Object name under the configured prefix. */
const OBJECT_NAME = 'settings.yaml'

/** Attempts one sync makes against a moving object before giving up until the next one. */
const MAX_WRITE_ATTEMPTS = 5

/** How long a burst of local edits settles before it is uploaded. */
const LOCAL_SETTLE_MS = 1000

/** How long a dispose waits for a sync in flight before letting it finish on its own. */
const DISPOSE_WAIT_MS = 5000

/** Config fields whose change moves or re-authenticates the store. */
const CONNECTION_FIELDS = new Set([
  'bucket', 'endpoint', 'region', 'prefix', 'forcePathStyle', 'accessKeyIdEnv', 'secretAccessKeyEnv',
  'accessKeyId', 'secretAccessKey',
])

/** 0.1.x connection fields the one-time migration carries into this profile. */
const LEGACY_CONNECTION_FIELDS = [
  'bucket', 'endpoint', 'region', 'prefix', 'forcePathStyle', 'pollMs', 'accessKeyIdEnv', 'secretAccessKeyEnv',
] as const

/** The part of the settings service this half uses. */
type SettingsService = Pick<SettingsForms, 'describe' | 'replace' | 'update'>

/** One described entry, as `describe()` reports it. */
type Descriptor = ReturnType<SettingsService['describe']>[number]

/** The Config the Loader hands this plugin: volatile references for every live field. */
type SyncConfigInput = ReturnType<typeof SyncConfigSchema>

/** Structural view of the Harness profile context, which this plugin does not depend on. */
interface ProfileFacts {
  name?: string
  home?: string
}

/** Structural view of the Loader, which this plugin does not depend on. */
interface LoaderFacts {
  await?: () => Promise<unknown>
}

/**
 * Structural view of Harness's HMR service, which this plugin does not depend
 * on: `executing` is the AsyncLocalStorage flag `runExclusive` refuses to nest
 * under.
 */
interface HmrFacts {
  executing?: { exit?: <R>(callback: () => R) => R }
}

/** Top-level field names a form schema envelope declares, when it declares an object. */
function schemaFields(schema: unknown): Set<string> | undefined {
  if (!isMapping(schema)) return undefined
  const refs = schema['refs']
  const root = isMapping(refs) ? refs[String(schema['uid'])] : undefined
  if (!isMapping(root) || root['type'] !== 'object' || !isMapping(root['dict'])) return undefined
  return new Set(Object.keys(root['dict']))
}

/** Plain JSON copy with `undefined` members removed, fit for a volatile snapshot. */
function plainJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** Wait without keeping the process alive. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms).unref() })
}

/**
 * The settings sync and the connection owner.
 *
 * It needs `ctx.settings` to sync and runs local-only without it; the
 * coordination handle is provided either way, so the credential provider can
 * always follow the connection.
 */
export class OssSettingsSync extends Service implements SyncControl {
  static Config = SyncConfigSchema

  /** The plugin's own context: the one its listeners and logs belong to. */
  private readonly owner: Context
  private readonly state: SyncState
  /** The machine-wide bucket pair a 0.1.x install saved, read as a fallback layer. */
  private legacyConnection: StoredConnection | undefined
  /** Parameters in force now. */
  private spec: ResolvedConfig
  /** The store in force; `undefined` while the configured connection cannot be built. */
  private store: ObjectStore | undefined
  /** Why the configured connection cannot be built, when it cannot. */
  private storeError: string | undefined
  private key: string
  private readonly poll: PollLoop
  /** The settings service while it is mounted. */
  private settings: SettingsService | undefined
  /** Set once the migration and the first sync may run: the Loader settled every entry. */
  private started = false
  /** The baseline of the last sync at the current location, once read. */
  private baseline: SyncBaseline | undefined
  private baselineLoaded = false
  /** Last request token acted on; the one present at boot counts as handled. */
  private handled: string | undefined
  private readonly status: SyncStatusMap = {}
  /** Canonical text of the status last announced to the page, timestamps aside. */
  private announced = ''
  private readonly participants = new Map<string, SyncParticipant>()
  private readonly connectionListeners = new Set<() => void>()
  private operations: Promise<void> = Promise.resolve()
  private settleTimer: NodeJS.Timeout | undefined
  private closed = false
  /** Settles once the migration and the first sync ran, for callers that must observe them. */
  private startedSignal: () => void = () => {}
  readonly whenStarted: Promise<void> = new Promise((resolve) => { this.startedSignal = resolve })

  constructor(ctx: Context, private readonly config: SyncConfigInput) {
    super(ctx, 'ossSyncControl')
    this.owner = ctx
    const plain = readConfig(config)
    this.handled = plain.request
    this.spec = resolveConfig(plain)
    this.state = new SyncState(this.spec.stateDir)
    this.key = `${this.spec.prefix}/${OBJECT_NAME}`
    this.poll = new PollLoop(this.spec.pollMs, () => this.sync(), (error: unknown) => {
      this.owner.logger.error('dsh-oss-sync: settings poll failed at %s', this.key)
      this.owner.logger.error(error)
    })
  }

  // ── the coordination handle ────────────────────────────────────────────

  join(label: string, participant: SyncParticipant): () => void {
    this.participants.set(label, participant)
    return () => { this.participants.delete(label) }
  }

  report(label: string, patch: Partial<SyncStatus>): void {
    const previous = this.status[label]
    this.status[label] = {
      state: 'idle',
      configured: false,
      revision: 0,
      writer: '',
      updatedAt: '',
      deviceId: '',
      objectKey: '',
      ...previous,
      ...patch,
    }
    this.publishStatus()
  }

  connection(): ResolvedConfig {
    return this.spec
  }

  onConnection(listener: () => void): () => void {
    this.connectionListeners.add(listener)
    return () => { this.connectionListeners.delete(listener) }
  }

  // ── lifecycle ──────────────────────────────────────────────────────────

  async* [Service.init](): AsyncGenerator<() => Promise<void> | void, void, void> {
    this.legacyConnection = await this.state.readConnection()
    const plain = readConfig(this.config)
    if (clearsConnection(plain)) await this.forgetLegacyConnection()
    this.adoptConnection(this.desiredSpec(plain))
    // A participant that read the connection before the machine-wide pair was
    // folded in follows the completed one.
    this.notifyConnection()
    const preflightError = await this.preflight()
    this.report(STATUS_LABEL, {
      state: preflightError === undefined && this.storeError === undefined ? 'idle' : 'error',
      lastError: preflightError ?? this.storeError,
      deviceId: await this.state.deviceId(),
      objectKey: this.key,
    })
    this.owner.on('loader/volatile-update', (paths) => { void this.onVolatileUpdate(paths) })
    this.owner.inject(['settings'], (settingsCtx) => {
      const settings = settingsCtx.settings
      this.settings = settings
      settingsCtx.on('settings/document-updated', (ns) => {
        if (this.syncs(String(ns))) this.schedule()
      })
      settingsCtx.effect(() => () => {
        if (this.settings === settings) this.settings = undefined
      }, 'dsh-oss-sync: settings service')
      void this.start(settings)
    })
    this.applyPoll()
    yield async () => {
      this.closed = true
      clearTimeout(this.settleTimer)
      // A settings write queued behind the HMR transaction that is disposing
      // this plugin runs only once the dispose returns, so the wait is bounded.
      await Promise.race([Promise.all([this.poll.stop(), this.operations]), delay(DISPOSE_WAIT_MS)])
      this.store?.destroy()
    }
  }

  /**
   * Begin syncing once the Loader settled every entry: the forms describe only
   * active entries, and Harness imports `settings.yaml` at the same point.
   * @param settings - the settings service this start belongs to.
   */
  private async start(settings: SettingsService): Promise<void> {
    try {
      const loader = this.lookup('loader') as LoaderFacts | undefined
      await loader?.await?.()
      await this.awaitHarnessImport()
      if (this.closed || this.settings !== settings) return
      await this.migrate(settings)
      this.started = true
      await this.sync()
    } catch (error) {
      this.owner.logger.error('dsh-oss-sync: could not start the settings sync')
      this.owner.logger.error(error)
      this.report(STATUS_LABEL, { state: 'error', lastError: String(error) })
    } finally {
      this.startedSignal()
    }
  }

  /**
   * Let Harness's own one-time `settings.yaml` import run first, so the
   * migration below lands over it rather than under it.
   */
  private async awaitHarnessImport(): Promise<void> {
    const home = this.profile().home ?? resolveDshHome()
    const legacy = join(home, 'settings.yaml')
    if (!existsSync(legacy)) return
    for (let waited = 0; waited < 10_000 && existsSync(legacy); waited += 100) await delay(100)
    // The rename is Harness's first step; its section writes follow it.
    await delay(1500)
  }

  /** The profile this process runs, as far as it can be told. */
  private profile(): ProfileFacts {
    return (this.lookup('profileContext') as ProfileFacts | undefined) ?? {}
  }

  /**
   * Run a settings write outside any HMR transaction this call chain inherited.
   *
   * The settings service fences every write with `hmr.runExclusive`, which
   * detects nesting with an AsyncLocalStorage flag. That flag follows every
   * timer and promise created while it is set, so a sync started while the
   * Plugins page enabled this plugin, or scheduled from a page save, carries it
   * for good, and every write fails with "HMR transactions cannot be nested".
   * Leaving the flag's scope queues the write behind the transaction instead.
   * @param write - the settings service call.
   * @returns what the call returns.
   */
  private outsideHmr<T>(write: () => Promise<T>): Promise<T> {
    const executing = (this.lookup('hmr') as HmrFacts | undefined)?.executing
    return typeof executing?.exit === 'function' ? executing.exit(write) : write()
  }

  /** Read a service this plugin does not declare types for. */
  private lookup(name: string): unknown {
    return (this.owner as unknown as { get: (name: string) => unknown }).get(name)
  }

  /** State path of one file belonging to this profile's sync. */
  private profileState(name: string): string {
    const profile = (this.profile().name ?? 'default').replace(/[^\w.-]/gu, '_')
    return `profiles/${profile}/${name}`
  }

  // ── migration from 0.1.x ───────────────────────────────────────────────

  /**
   * Carry what a 0.1.x install held only in its own cache into this profile,
   * once per profile: the connection the page saved (when this profile has no
   * bucket yet), and the settings sections of a machine that never had a
   * bucket, whose cache was their only copy.
   * @param settings - the settings service.
   */
  private async migrate(settings: SettingsService): Promise<void> {
    const marker = this.profileState('migrated-0.1.yaml')
    if (await this.state.readState(marker) !== undefined) return
    const cached = await this.state.readCache<Record<string, unknown>>(OBJECT_NAME)
    const document = cached?.doc
    if (document !== undefined) {
      const legacyConnection = document[LEGACY_SYNC_NAMESPACE]
      if (isMapping(legacyConnection) && (readConfig(this.config).bucket ?? '').length === 0) {
        const fields = Object.fromEntries(LEGACY_CONNECTION_FIELDS
          .filter(field => legacyConnection[field] !== undefined)
          .map(field => [field, legacyConnection[field]]))
        if (typeof fields['bucket'] === 'string' && fields['bucket'].length > 0) {
          try {
            await this.outsideHmr(() => settings.update(SYNC_ENTRY, fields))
            this.owner.logger.info('dsh-oss-sync: carried the 0.1.x connection into this profile')
          } catch (error) {
            this.owner.logger.warn('dsh-oss-sync: could not carry the 0.1.x connection into this profile')
            this.owner.logger.warn(error)
          }
        }
      }
      const described = new Map(settings.describe({ redactSecrets: true }).map(view => [String(view.ns), view]))
      for (const [entry, section] of Object.entries(aliasDocument(document))) {
        const view = described.get(entry)
        if (view === undefined || !this.syncs(entry)) continue
        const fields = schemaFields(view.schema)
        const patch = Object.fromEntries(Object.entries(section).filter(([field]) => fields?.has(field) ?? true))
        if (Object.keys(patch).length === 0) continue
        try {
          await this.outsideHmr(() => settings.update(entry, patch))
        } catch (error) {
          this.owner.logger.warn('dsh-oss-sync: section %s of the 0.1.x cache was not imported', entry)
          this.owner.logger.warn(error)
        }
      }
      this.owner.logger.info('dsh-oss-sync: imported the 0.1.x settings cache into this profile')
    }
    await this.state.writeState(marker, { v: 1, at: new Date().toISOString() })
  }

  // ── connection ─────────────────────────────────────────────────────────

  /** The parameters Config and the machine-wide fallback resolve to now. */
  private desiredSpec(plain: Config = readConfig(this.config)): ResolvedConfig {
    return mergeConnection(resolveConfig(plain), this.legacyConnection, clearsConnection(plain))
  }

  /** Retire the machine-wide pair a 0.1.x install saved; the page cleared the pair. */
  private async forgetLegacyConnection(): Promise<void> {
    if (this.legacyConnection === undefined) return
    this.legacyConnection = undefined
    await this.state.writeConnection()
  }

  /**
   * Build the store for one parameter set. A connection that cannot be built —
   * half a credential pair — is a status line, not a failure: the page is
   * where it gets repaired.
   * @param desired - the parameters to adopt.
   */
  private adoptConnection(desired: ResolvedConfig): void {
    this.store?.destroy()
    this.store = undefined
    this.storeError = undefined
    this.spec = desired
    this.key = `${desired.prefix}/${OBJECT_NAME}`
    try {
      this.store = new ObjectStore(desired)
    } catch (error) {
      this.storeError = String(error)
      this.owner.logger.error('dsh-oss-sync: the configured connection cannot be used')
      this.owner.logger.error(error)
    }
  }

  /** Whether a bucket is set and a store could be built for it. */
  private get configured(): boolean {
    return this.store?.configured === true
  }

  /**
   * Report a bucket this process cannot authenticate against yet.
   * @returns the failure's text, or `undefined` when preflight passed (including local-only).
   */
  private async preflight(): Promise<string | undefined> {
    try {
      await this.store?.preflight()
      return undefined
    } catch (error) {
      this.owner.logger.error('dsh-oss-sync: storage is not usable yet')
      this.owner.logger.error(error)
      return String(error)
    }
  }

  /** Poll only while a bucket is configured. */
  private applyPoll(): void {
    if (this.configured) this.poll.start()
    else this.poll.pause()
  }

  /**
   * React to the Loader committing new volatile values: the page saved a
   * connection, a poll interval, the scope, or a request token.
   * @param paths - the changed Config paths.
   */
  private async onVolatileUpdate(paths: readonly (readonly string[])[]): Promise<void> {
    if (this.closed) return
    const fields = new Set(paths.map(path => path[0] ?? ''))
    const plain = readConfig(this.config)
    try {
      if ([...fields].some(field => CONNECTION_FIELDS.has(field))) await this.reconnect(plain)
      if (fields.has('pollMs') && plain.pollMs !== undefined && plain.pollMs !== this.spec.pollMs) {
        this.spec = { ...this.spec, pollMs: plain.pollMs }
        this.poll.restart(plain.pollMs)
        this.applyPoll()
      }
      if (fields.has('include') || fields.has('exclude')) this.schedule(0)
      if (fields.has('request') && plain.request !== undefined && plain.request !== this.handled) {
        this.handled = plain.request
        await this.runRequested(plain.request)
      }
    } catch (error) {
      this.owner.logger.error('dsh-oss-sync: could not apply the saved sync settings')
      this.owner.logger.error(error)
      this.report(STATUS_LABEL, { state: 'error', lastError: String(error) })
    }
    // The Loader resets the status reference whenever this entry's raw config
    // moves; publishing again restores it.
    this.announced = ''
    this.publishStatus()
  }

  /**
   * Move to the connection the page saved. A new location starts the sync
   * over there: an existing document wins, and an empty one is seeded.
   * @param plain - the Config values now in force.
   */
  private async reconnect(plain: Config): Promise<void> {
    if (clearsConnection(plain)) await this.forgetLegacyConnection()
    const desired = this.desiredSpec(plain)
    if (sameConnection(desired, this.spec) && desired.prefix === this.spec.prefix) return
    await this.enqueue(async () => {
      this.adoptConnection({ ...desired, pollMs: this.spec.pollMs })
      this.baseline = undefined
      this.baselineLoaded = false
    })
    const preflightError = await this.preflight()
    this.report(STATUS_LABEL, {
      state: preflightError === undefined && this.storeError === undefined ? 'idle' : 'error',
      lastError: preflightError ?? this.storeError,
      objectKey: this.key,
      revision: 0,
      writer: '',
      updatedAt: '',
    })
    this.applyPoll()
    this.owner.logger.info('dsh-oss-sync: settings now sync with %s', this.configured ? this.key : 'nothing (local-only)')
    this.notifyConnection()
    this.schedule(0)
  }

  /** Tell every participant the connection moved. */
  private notifyConnection(): void {
    for (const listener of this.connectionListeners) {
      try {
        listener()
      } catch (error) {
        this.owner.logger.warn(error)
      }
    }
  }

  /** Run the verb the page asked for on this half and every participant. */
  private async runRequested(request: string): Promise<void> {
    const verb = requestVerb(request)
    this.owner.logger.info('dsh-oss-sync: %s requested from the Plugins page', verb)
    const participants = [...this.participants.values()]
    await Promise.allSettled(verb === 'push'
      ? [this.sync('push'), ...participants.map(participant => participant.push())]
      : [this.sync(), ...participants.map(participant => participant.refresh())])
  }

  // ── the sync ───────────────────────────────────────────────────────────

  /** Whether one profile entry takes part in the sync under the current scope. */
  private syncs(entry: string): boolean {
    const plain = readConfig(this.config)
    return isSynced(entry, plain.include ?? [], plain.exclude ?? DEFAULT_EXCLUDE, OWN_ENTRIES)
  }

  /** Sync after a burst of local edits settles. */
  private schedule(ms = LOCAL_SETTLE_MS): void {
    if (this.closed) return
    clearTimeout(this.settleTimer)
    this.settleTimer = setTimeout(() => { void this.sync() }, ms)
    this.settleTimer.unref()
  }

  /**
   * This profile's synced sections: the user layer of every described entry,
   * secrets redacted and expressions left out. An entry with no user layer
   * contributes an empty section, which is how a reset propagates.
   * @param settings - the settings service.
   * @returns the local document.
   */
  private snapshot(settings: SettingsService): SettingsDocument {
    const document: SettingsDocument = {}
    for (const view of settings.describe({ redactSecrets: true })) {
      const entry = String(view.ns)
      if (!this.syncs(entry)) continue
      const section = withoutExpressions(view.user ?? {})
      document[entry] = isMapping(section) ? section : {}
    }
    return document
  }

  /**
   * Write one section another machine committed into this profile.
   *
   * `replace` resets the entry's live fields to what the bundles supply and
   * sets the section over them, so a field the other machine cleared clears
   * here too. The section never carries this profile's secrets or `!!js`
   * expressions, so both are restored into it first; fields this Harness does
   * not declare are dropped rather than refused.
   * @param settings - the settings service.
   * @param entry - the profile entry id.
   * @param section - the section to apply.
   */
  private async apply(settings: SettingsService, entry: string, section: Record<string, unknown>): Promise<void> {
    const redacted = settings.describe({ redactSecrets: true }).find(view => String(view.ns) === entry)
    const full: Descriptor | undefined = settings.describe().find(view => String(view.ns) === entry)
    if (redacted === undefined || full === undefined) throw new Error(`entry "${entry}" is no longer configurable`)
    const fields = schemaFields(redacted.schema)
    const next: Record<string, unknown> = structuredClone(Object.fromEntries(Object.entries(section)
      .filter(([field]) => fields?.has(field) ?? true)))
    for (const secret of redacted.secrets ?? []) {
      const value = getPath(full.user, secret.path)
      if (value !== undefined && secret.path.length > 0) setPath(next, secret.path, structuredClone(value))
    }
    for (const path of expressionPaths(full.user)) {
      if (path.length > 0) setPath(next, path, structuredClone(getPath(full.user, path)))
    }
    await this.outsideHmr(() => settings.replace(entry, next, redacted.revision))
  }

  /** Read this profile's baseline once per location. */
  private async loadBaseline(): Promise<SyncBaseline | undefined> {
    if (!this.baselineLoaded) {
      const stored = await this.state.readState<SyncBaseline>(this.profileState('settings-sync.yaml'))
      this.baseline = stored?.v === 1 && stored.location === locationKey(this.spec) ? stored : undefined
      this.baselineLoaded = true
    }
    return this.baseline
  }

  /** Record what this profile and the bucket agree on now. */
  private async saveBaseline(baseline: SyncBaseline): Promise<void> {
    this.baseline = baseline
    this.baselineLoaded = true
    await this.state.writeState(this.profileState('settings-sync.yaml'), baseline)
  }

  /**
   * Reconcile this profile with the bucket once.
   * @param force - `push` re-commits every local section over the bucket's.
   */
  sync(force?: 'push'): Promise<void> {
    return this.enqueue(async () => {
      const settings = this.settings
      if (this.closed || !this.started || settings === undefined) return
      const store = this.store
      if (store === undefined || !store.configured) {
        this.report(STATUS_LABEL, { state: this.storeError === undefined ? 'idle' : 'error', lastError: this.storeError })
        return
      }
      for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
        let remote
        try {
          remote = await store.read(this.key)
        } catch (error) {
          this.owner.logger.warn('dsh-oss-sync: could not read %s; keeping this profile as it is', this.key)
          this.owner.logger.warn(error)
          this.report(STATUS_LABEL, { state: 'error', lastError: String(error) })
          return
        }
        const envelope = remote === undefined ? undefined : parseEnvelope<Record<string, unknown>>(remote.text)
        const stored = envelope?.doc ?? {}
        const remoteView = aliasDocument(stored)
        const baseline = await this.loadBaseline()
        const local = this.snapshot(settings)
        const readAt = new Date().toISOString()
        if (force === undefined && baseline !== undefined && remote !== undefined && remote.etag === baseline.etag
          && Object.keys(local).every(entry => sameSection(local[entry], baseline.local[entry]))) {
          this.report(STATUS_LABEL, { state: 'idle', lastReadAt: readAt, lastError: undefined })
          return
        }
        const plan = planSync(local, remoteView, baseline, force)
        const applied: string[] = []
        const failures: string[] = []
        for (const [entry, section] of Object.entries(plan.apply)) {
          try {
            await this.apply(settings, entry, section)
            applied.push(entry)
          } catch (error) {
            failures.push(`${entry}: ${String(error)}`)
            this.owner.logger.warn('dsh-oss-sync: could not apply the stored section of %s', entry)
            this.owner.logger.warn(error)
          }
        }
        // The baseline moves past every apply before anything is uploaded: an
        // applied section reads back as this profile's state, and must never
        // look like a local change to send back.
        const after = applied.length === 0 ? local : this.snapshot(settings)
        const agreed: SyncBaseline = {
          v: 1,
          location: locationKey(this.spec),
          ...remote === undefined ? {} : { etag: remote.etag },
          rev: envelope?.rev ?? 0,
          remote: remoteView,
          local: { ...baseline?.local, ...after },
        }
        /**
         * Keep an entry whose apply failed exactly as the previous baseline
         * had it, so the next sync still sees the stored change and retries.
         * @param agreement - the baseline about to be recorded.
         * @returns the same baseline with the failed entries rolled back.
         */
        const retrying = (agreement: SyncBaseline): SyncBaseline => {
          for (const entry of Object.keys(plan.apply).filter(name => !applied.includes(name))) {
            for (const side of ['local', 'remote'] as const) {
              const previous = baseline?.[side][entry]
              if (previous === undefined) Reflect.deleteProperty(agreement[side], entry)
              else agreement[side][entry] = previous
            }
          }
          return agreement
        }
        const upload = Object.entries(plan.upload)
        if (upload.length === 0) {
          await this.saveBaseline(retrying(agreed))
          if (applied.length > 0) {
            this.owner.logger.info('dsh-oss-sync: applied %s from settings revision %d', applied.join(', '), agreed.rev)
          }
          this.report(STATUS_LABEL, {
            state: failures.length === 0 ? 'idle' : 'error',
            lastError: failures.length === 0 ? undefined : failures.join('; '),
            revision: agreed.rev,
            writer: envelope?.writer ?? '',
            updatedAt: envelope?.updatedAt ?? '',
            lastReadAt: readAt,
            applied: applied.length === 0 ? undefined : applied,
            uploaded: undefined,
          })
          return
        }
        if (applied.length > 0) await this.saveBaseline(retrying(agreed))
        const document: Record<string, unknown> = { ...stored }
        for (const [entry, section] of upload) document[entry] = section
        const next: Envelope<Record<string, unknown>> = {
          v: ENVELOPE_VERSION,
          rev: (envelope?.rev ?? 0) + 1,
          writer: await this.state.deviceId(),
          updatedAt: new Date().toISOString(),
          doc: document,
        }
        try {
          const written = await store.write(this.key, encodeEnvelope(next), remote === undefined
            ? { ifNoneMatch: true }
            : { ifMatch: remote.etag })
          await this.saveBaseline(retrying({
            ...agreed,
            local: { ...agreed.local },
            etag: written.etag,
            rev: next.rev,
            remote: aliasDocument(document),
          }))
          const uploaded = upload.map(([entry]) => entry)
          this.owner.logger.info('dsh-oss-sync: uploaded %s as settings revision %d', uploaded.join(', '), next.rev)
          this.report(STATUS_LABEL, {
            state: failures.length === 0 ? 'idle' : 'error',
            lastError: failures.length === 0 ? undefined : failures.join('; '),
            revision: next.rev,
            writer: next.writer,
            updatedAt: next.updatedAt,
            lastReadAt: readAt,
            lastWriteAt: next.updatedAt,
            uploaded,
            applied: applied.length === 0 ? undefined : applied,
          })
          return
        } catch (error) {
          if (error instanceof PreconditionFailedError && attempt < MAX_WRITE_ATTEMPTS) continue
          this.owner.logger.warn('dsh-oss-sync: could not write %s', this.key)
          this.owner.logger.warn(error)
          this.report(STATUS_LABEL, { state: 'error', lastError: String(error) })
          return
        }
      }
    })
  }

  // ── status ─────────────────────────────────────────────────────────────

  /**
   * Publish the status map into this entry's own volatile `status` reference,
   * which `describe()` reads, and tell the page when something it shows moved.
   * The reference is this process's alone: nothing here writes the profile.
   */
  private publishStatus(): void {
    if (this.closed) return
    const settingsStatus = this.status[STATUS_LABEL]
    const map: SyncStatusMap = {
      ...this.status,
      ...settingsStatus === undefined ? {} : {
        [STATUS_LABEL]: { ...settingsStatus, configured: this.configured, objectKey: this.key },
      },
    }
    const snapshot = plainJson(map)
    const reference: unknown = this.config.status
    if (isVolatile(reference)) {
      try {
        updateVolatile(reference, createVolatile(snapshot))
      } catch (error) {
        this.owner.logger.debug(error)
      }
    }
    // A read that found nothing new is not worth a page refresh.
    const shown = JSON.stringify(Object.fromEntries(Object.entries(snapshot)
      .map(([label, entry]) => [label, { ...entry, lastReadAt: undefined }])))
    if (shown === this.announced) return
    this.announced = shown
    if (this.settings === undefined) return
    try {
      this.owner.emit('settings/document-updated', SYNC_ENTRY as never, 0)
    } catch (error) {
      this.owner.logger.debug(error)
    }
  }

  /**
   * Queue one exclusive operation behind every earlier one. Nothing queued
   * here queues again, so a poll can never interleave an apply or an upload.
   */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.operations.then(operation)
    this.operations = task.then(() => undefined, () => undefined)
    return task
  }
}

export default OssSettingsSync
