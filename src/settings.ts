/**
 * User settings stored in an S3-compatible bucket instead of a local file.
 *
 * One object holds the whole document — the same namespace-to-section mapping
 * `dsh-settings-file` keeps in `settings.yaml` — wrapped in a revision
 * envelope. A write presents the ETag it read, so two machines can never
 * overwrite each other silently; a poll publishes another machine's committed
 * revision into the seam, which re-resolves every registered namespace.
 *
 * This provider also owns the `oss-sync` namespace, which is how the settings
 * page reads and drives the sync: the editable connection parameters, the
 * runtime status both providers report, and the request token a card writes.
 *
 * @module dsh-oss-sync/settings
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { SettingsProvider, type SettingsNamespace, type SettingsScope } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import {
  ConfigSchema, applyOverrides, resolveConfig, sameConnection, type Config, type ResolvedConfig,
} from './config.js'
import {
  SYNC_NAMESPACE, storedDocument, storedSection, type SyncControl, type SyncParticipant, type SyncSettings,
  type SyncStatus, type SyncStatusMap,
} from './control.js'
import { ENVELOPE_VERSION, SyncState, encodeEnvelope, parseEnvelope, type Envelope } from './envelope.js'
import { PollLoop } from './poll.js'
import { ObjectStore, PreconditionFailedError } from './store.js'

/** This provider's key in the namespace's status map. */
const STATUS_LABEL = 'settings'

/** Object name under the configured prefix. */
const OBJECT_NAME = 'settings.yaml'

/** Attempts a conditional write makes against a moving object before giving up. */
const MAX_WRITE_ATTEMPTS = 5

/** One settings document: namespace to raw user section. */
type SettingsDocument = Record<string, Record<string, unknown>>

/** Schema of the namespace the settings page binds to. */
const SyncSettingsSchema: z<SyncSettings> = z.object({
  bucket: z.string(),
  endpoint: z.string(),
  region: z.string(),
  prefix: z.string(),
  pollMs: z.number().min(1000),
  forcePathStyle: z.boolean(),
  accessKeyIdEnv: z.string(),
  secretAccessKeyEnv: z.string(),
  status: z.any(),
  request: z.string(),
})

/** Object key for one resolved prefix. */
function objectKey(spec: ResolvedConfig): string {
  return `${spec.prefix}/${OBJECT_NAME}`
}

/**
 * Settings provider backed by one object in an S3-compatible bucket.
 *
 * Reads are served from the document this process last read, wrote, or
 * polled, so a model request never waits on storage; the poll interval is the
 * propagation window between machines. Writes are conditional: a machine that
 * read a stale revision re-reads, re-applies its own section over the newer
 * document, and retries, so concurrent edits on different machines merge
 * instead of erasing each other.
 */
export class OssSettingsProvider extends SettingsProvider {
  static Config: z<Config> = ConfigSchema

  /** Parameters the entry config supplies; the namespace overrides them. */
  private readonly bootstrap: ResolvedConfig
  private readonly state: SyncState
  /** Parameters in force now. */
  private spec: ResolvedConfig
  private store: ObjectStore
  private key: string
  private readonly poll: PollLoop
  private scope: SettingsScope<SyncSettings> | undefined
  /** Last request token this provider acted on. */
  private handled: string | undefined
  /** Status each participant last reported. */
  private readonly status: SyncStatusMap = {}
  private readonly participants = new Map<string, SyncParticipant>()
  /**
   * The document this process considers current. It is what the seam holds
   * and what a deferred publish republishes, so a publish can never resurrect
   * a superseded local view.
   */
  private local: SettingsDocument = {}
  /** ETag of the revision {@link local} reflects; `undefined` until one is read. */
  private etag: string | undefined
  /** Revision number {@link etag} belongs to. */
  private revision = 0
  /** Serializes remote reads and writes, so a poll never interleaves a write. */
  private operations: Promise<void> = Promise.resolve()
  /** Set at dispose: refuse new work and let in-flight work settle. */
  private closed = false

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.bootstrap = resolveConfig(config)
    this.state = new SyncState(this.bootstrap.stateDir)
    this.spec = this.bootstrap
    this.store = new ObjectStore(this.spec)
    this.key = objectKey(this.spec)
    this.poll = new PollLoop(this.spec.pollMs, () => this.refresh(), (error: unknown) => {
      this.ctx.logger.error('dsh-oss-sync: settings poll failed at %s', this.key)
      this.ctx.logger.error(error)
    })
  }

  /** Storage is always writable through {@link SettingsProvider.persist}. */
  override get writable(): boolean {
    return true
  }

  /**
   * Read the stored document once at registration. An unreachable service
   * falls back to the cache this machine last saw, because a laptop that
   * starts offline must still boot with its own configuration; a stored
   * object that is not an envelope this plugin understands is refused.
   */
  protected override async load(): Promise<Record<string, unknown>> {
    try {
      const remote = await this.store.read(this.key)
      if (remote === undefined) {
        // No stored revision yet: keep whatever this machine last cached, so
        // the first writer seeds the bucket instead of erasing its own state.
        const cached = await this.state.readCache<SettingsDocument>(OBJECT_NAME)
        if (cached === undefined) return {}
        this.local = cached.doc
        this.revision = cached.rev
        this.ctx.logger.warn('dsh-oss-sync: %s does not exist yet; seeding from the local cache', this.key)
        return cached.doc
      }
      const envelope = parseEnvelope<SettingsDocument>(remote.text)
      return this.adopt(envelope, remote.etag)
    } catch (error) {
      const cached = await this.state.readCache<SettingsDocument>(OBJECT_NAME)
      this.ctx.logger.warn('dsh-oss-sync: could not read %s; running from the local cache', this.key)
      this.ctx.logger.warn(error)
      if (cached === undefined) return {}
      this.local = cached.doc
      this.revision = cached.rev
      return cached.doc
    }
  }

  /**
   * Store one namespace's next user section.
   *
   * The write re-reads the object, keeps every section the newer revision
   * carries, overlays this namespace's section, and commits under the ETag it
   * read. A refusal means another machine committed in between: the loop
   * re-reads and re-applies, so the loser of the race retries against the
   * winner's document rather than overwriting it.
   */
  protected override persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    // The sync namespace's own section carries runtime facts; storage keeps
    // the connection parameters and drops the rest.
    const next = ns === SYNC_NAMESPACE ? storedSection(section) : section
    return this.enqueue(async () => {
      for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
        let remote
        try {
          remote = await this.store.read(this.key)
        } catch (error) {
          throw new Error(`dsh-oss-sync: cannot read ${this.key} before writing it: ${String(error)}`)
        }
        const stored = remote === undefined ? undefined : parseEnvelope<SettingsDocument>(remote.text)
        // A vanished object with a revision already observed means another
        // machine deleted the document; without one, a machine that started
        // offline seeds storage from the state it already carries.
        const base: SettingsDocument = remote === undefined
          ? (this.etag === undefined ? this.local : {})
          : stored?.doc ?? {}
        const document: SettingsDocument = { ...base, [ns]: next }
        const envelope: Envelope<SettingsDocument> = {
          v: ENVELOPE_VERSION,
          rev: (stored?.rev ?? 0) + 1,
          writer: await this.state.deviceId(),
          updatedAt: new Date().toISOString(),
          doc: document,
        }
        try {
          const written = await this.store.write(this.key, encodeEnvelope(envelope), remote === undefined
            ? { ifNoneMatch: true }
            : { ifMatch: remote.etag })
          this.etag = written.etag
          this.revision = envelope.rev
          // The seam holds the section it was handed, runtime fields included;
          // only storage is narrowed.
          this.local = { ...document, [ns]: section }
          await this.state.writeCache(OBJECT_NAME, envelope)
          this.report(STATUS_LABEL, { lastWriteAt: envelope.updatedAt, lastError: undefined, state: 'idle' })
          // Deferred: the seam commits this namespace only after persist
          // returns, so publishing synchronously would emit the pre-write
          // value first. By the time this runs, a later local write has also
          // landed in `local`, so republishing it cannot resurrect a stale one.
          setImmediate(() => {
            if (!this.closed) this.publishDocument()
          })
          return
        } catch (error) {
          if (error instanceof PreconditionFailedError && attempt < MAX_WRITE_ATTEMPTS) continue
          this.report(STATUS_LABEL, { state: 'error', lastError: String(error) })
          throw error
        }
      }
    })
  }

  override async* [Service.init](): AsyncGenerator<() => Promise<void> | void, void, void> {
    await this.store.preflight()
    // The base init loads and publishes; an unreadable bucket has already
    // fallen back to the cache there, so this cannot fail on an offline host.
    yield* super[Service.init]()
    this.scope = this.register(SYNC_NAMESPACE, SyncSettingsSchema, { base: this.bootstrap })
    this.ctx.provide('ossSyncControl', this.createControl())
    const current = this.scope.get()
    await this.reconcile(current)
    this.scope.watch(next => this.onSettings(next))
    this.report(STATUS_LABEL, {
      state: 'idle',
      revision: this.revision,
      writer: '',
      updatedAt: '',
      deviceId: await this.state.deviceId(),
      objectKey: this.key,
    })
    this.poll.start()
    yield async () => {
      this.closed = true
      await this.poll.stop()
      await this.operations
      this.store.destroy()
    }
  }

  /** The coordination handle the credentials provider joins. */
  private createControl(): SyncControl {
    return {
      join: (label, participant) => {
        this.participants.set(label, participant)
        return () => { this.participants.delete(label) }
      },
      report: (label, patch) => { this.report(label, patch) },
    }
  }

  /**
   * React to a committed `oss-sync` section: run a requested sync, then adopt
   * any connection parameter the user changed.
   */
  private async onSettings(next: SyncSettings): Promise<void> {
    if (next.request !== undefined && next.request !== this.handled) {
      this.handled = next.request
      await this.runRequested()
      return
    }
    await this.reconcile(next)
  }

  /** Run this provider's and every participant's refresh, as one card gesture. */
  private async runRequested(): Promise<void> {
    this.ctx.logger.info('dsh-oss-sync: sync requested from the settings page')
    await Promise.allSettled([
      this.refresh(),
      ...[...this.participants.values()].map(participant => participant.refresh()),
    ])
  }

  /**
   * Adopt the parameters the namespace now resolves to. A poll interval
   * applies immediately; a changed connection or prefix moves the providers
   * to the new location, carrying the document this process holds when the
   * target is empty.
   */
  private async reconcile(next: SyncSettings): Promise<void> {
    const desired = applyOverrides(this.bootstrap, next)
    if (desired.pollMs !== this.spec.pollMs) this.poll.restart(desired.pollMs)
    if (sameConnection(desired, this.spec) && desired.prefix === this.spec.prefix) {
      this.spec = desired
      return
    }
    await this.relocate(desired)
  }

  /** Move both documents' home to the parameters the settings page asked for. */
  private relocate(desired: ResolvedConfig): Promise<void> {
    return this.enqueue(async () => {
      const carried = storedDocument(this.local)
      const connectionChanged = !sameConnection(desired, this.spec)
      this.spec = desired
      this.key = objectKey(desired)
      if (connectionChanged) {
        this.store.destroy()
        this.store = new ObjectStore(desired)
        await this.store.preflight()
      }
      // The target starts from nothing: read it, and seed it from the document
      // already in hand when it is empty, so switching buckets or prefixes
      // carries the configuration instead of appearing to lose it.
      this.etag = undefined
      let remote
      try {
        remote = await this.store.read(this.key)
      } catch (error) {
        this.report(STATUS_LABEL, { state: 'error', lastError: String(error), objectKey: this.key })
        throw error
      }
      if (remote === undefined) {
        const envelope: Envelope<SettingsDocument> = {
          v: ENVELOPE_VERSION,
          rev: this.revision + 1,
          writer: await this.state.deviceId(),
          updatedAt: new Date().toISOString(),
          doc: carried,
        }
        const written = await this.store.write(this.key, encodeEnvelope(envelope), { ifNoneMatch: true })
        this.etag = written.etag
        this.revision = envelope.rev
        await this.state.writeCache(OBJECT_NAME, envelope)
        this.local = carried
        this.ctx.logger.info('dsh-oss-sync: moved to %s and seeded it from this machine', this.key)
        this.publishDocument()
        return
      }
      const envelope = parseEnvelope<SettingsDocument>(remote.text)
      this.adopt(envelope, remote.etag)
      await this.state.writeCache(OBJECT_NAME, envelope)
      this.ctx.logger.info('dsh-oss-sync: moved to %s and adopted revision %d', this.key, envelope.rev)
      this.publishDocument()
    })
  }

  /** Adopt one stored revision as this process's document. */
  private adopt(envelope: Envelope<SettingsDocument>, etag: string): SettingsDocument {
    this.etag = etag
    this.revision = envelope.rev
    this.local = envelope.doc
    return envelope.doc
  }

  /** Publish the seam's document with the runtime status merged in. */
  private publishDocument(): void {
    const section = { ...(this.local[SYNC_NAMESPACE] ?? {}), status: { ...this.status } } as Record<string, unknown>
    const document: SettingsDocument = { ...this.local, [SYNC_NAMESPACE]: section }
    this.local = document
    this.publish(document)
  }

  /** Merge one participant's status and republish the namespace. */
  private report(label: string, patch: Partial<SyncStatus>): void {
    const previous = this.status[label]
    this.status[label] = {
      state: 'idle',
      revision: this.revision,
      writer: '',
      updatedAt: '',
      deviceId: previous?.deviceId ?? '',
      objectKey: this.key,
      ...previous,
      ...patch,
    }
    if (!this.closed) this.publishDocument()
  }

  /** Read storage once and publish a revision this process did not commit. */
  private refresh(): Promise<void> {
    return this.enqueue(async () => {
      if (this.closed) return
      let remote
      try {
        remote = await this.store.read(this.key)
      } catch (error) {
        this.ctx.logger.warn('dsh-oss-sync: could not read %s; keeping the last good document', this.key)
        this.ctx.logger.warn(error)
        this.report(STATUS_LABEL, { state: 'error', lastError: String(error) })
        return
      }
      this.report(STATUS_LABEL, { lastReadAt: new Date().toISOString(), lastError: undefined })
      if (remote === undefined) return
      if (this.etag !== undefined && remote.etag === this.etag) return
      const envelope = parseEnvelope<SettingsDocument>(remote.text)
      if (envelope.writer === await this.state.deviceId() && envelope.rev === this.revision) return
      this.adopt(envelope, remote.etag)
      await this.state.writeCache(OBJECT_NAME, envelope)
      this.ctx.logger.info('dsh-oss-sync: applying settings revision %d from %s', envelope.rev, envelope.writer)
      // The stored revision is newer, so it is authoritative for every
      // namespace: a section it dropped stays dropped here.
      this.report(STATUS_LABEL, { state: 'idle', updatedAt: envelope.updatedAt, writer: envelope.writer })
    })
  }

  /** Queue one exclusive operation behind every earlier one. */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.operations.then(operation)
    this.operations = task.then(() => undefined, () => undefined)
    return task
  }
}

export default OssSettingsProvider
