/**
 * Credentials stored in an S3-compatible bucket instead of a local file.
 *
 * One object holds both halves of the seam — `refs`, the values behind
 * `CredentialRef` names that configuration refers to, and `records`, the
 * durable per-plugin records addressed by `CredentialKey`. Both are written
 * under an ETag precondition, so a token refresh on one machine cannot erase
 * a grant committed on another.
 *
 * The stored values are plaintext: this provider exists for deployments that
 * accept bucket-level protection, and it removes the local file's
 * owner-only-permission check entirely.
 *
 * @module dsh-oss-sync/credentials
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import {
  CredentialProvider, type CredentialInfo, type CredentialKey, type CredentialRecord, type CredentialRecordEntry,
  type CredentialRecordInfo, type CredentialRef, type ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import z from '@deepseek-ai/schemastery'
import { ConfigSchema, resolveConfig, type Config } from './config.js'
import { ENVELOPE_VERSION, SyncState, encodeEnvelope, parseEnvelope, type Envelope } from './envelope.js'
import { PollLoop } from './poll.js'
import { ObjectStore, PreconditionFailedError } from './store.js'

/** Object name under the configured prefix. */
const OBJECT_NAME = 'credentials.yaml'

/** Attempts a conditional write makes against a moving object before giving up. */
const MAX_WRITE_ATTEMPTS = 5

/** The source-layer id an ambient process environment value reports. */
const ENV_SOURCE = 'env'

/** The source-layer id a value from the bucket reports. */
const STORE_SOURCE = 'oss'

/** Both halves of the seam as stored in one object. */
interface CredentialDocument {
  /** Reference name to secret value. */
  refs: Record<string, string>
  /** `<scope>/<id>` to the record its owner wrote. */
  records: Record<string, CredentialRecord>
}

/** An empty document; the shape a first write starts from. */
function emptyDocument(): CredentialDocument {
  return { refs: {}, records: {} }
}

/** Whether a value read from storage or config is a usable document. */
function isDocument(value: unknown): value is CredentialDocument {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const candidate = value as Partial<CredentialDocument>
  return typeof candidate.refs === 'object' && candidate.refs !== null && !Array.isArray(candidate.refs)
    && typeof candidate.records === 'object' && candidate.records !== null && !Array.isArray(candidate.records)
}

/**
 * Read a stored document, rejecting anything this plugin cannot serve.
 * @param value - the parsed envelope document.
 * @returns the document, with absent halves defaulted.
 */
function asDocument(value: unknown): CredentialDocument {
  if (!isDocument(value)) throw new Error('dsh-oss-sync: stored credentials must carry "refs" and "records" maps')
  return { refs: { ...value.refs }, records: { ...value.records } }
}

/**
 * Credential provider backed by one object in an S3-compatible bucket.
 *
 * Resolution is layered: the launching environment wins and is read-only, so
 * `DEEPSEEK_API_KEY=… dsh` keeps working exactly as it does with the local
 * store and a stored value can never appear to take effect while an ambient
 * one shadows it. Everything else comes from the bucket, refreshed by the
 * poll loop.
 */
export class OssCredentialProvider extends CredentialProvider {
  static Config: z<Config> = ConfigSchema

  private readonly store: ObjectStore
  private readonly state: SyncState
  private readonly key: string
  private readonly poll: PollLoop
  /** The document this process considers current. */
  private local: CredentialDocument = emptyDocument()
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
    const resolved = resolveConfig(config)
    this.store = new ObjectStore(resolved)
    this.state = new SyncState(resolved.stateDir)
    this.key = `${resolved.prefix}/${OBJECT_NAME}`
    this.poll = new PollLoop(resolved.pollMs, () => this.refresh(), (error: unknown) => {
      this.ctx.logger.error('dsh-oss-sync: credential poll failed at %s', this.key)
      this.ctx.logger.error(error)
    })
  }

  /**
   * Resolve one reference per call: the ambient environment first, then the
   * stored value. Nothing is cached across calls, so a rotated key reaches
   * the next model request without a restart.
   * @param ref - the reference to resolve.
   * @returns the value and its source, or `undefined` while unconfigured.
   */
  override resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const ambient = process.env[ref]
    if (ambient !== undefined && ambient.length > 0) return Promise.resolve({ value: ambient, source: ENV_SOURCE })
    const stored = this.local.refs[ref]
    return Promise.resolve(stored === undefined || stored.length === 0
      ? undefined
      : { value: stored, source: STORE_SOURCE })
  }

  /**
   * Describe one reference without exposing its value.
   * @param ref - the reference to describe.
   * @returns configured state, supplying source, and writability.
   */
  override describe(ref: CredentialRef): Promise<CredentialInfo> {
    const ambient = process.env[ref]
    if (ambient !== undefined && ambient.length > 0) {
      return Promise.resolve({ configured: true, source: ENV_SOURCE, writable: false })
    }
    const stored = this.local.refs[ref]
    return Promise.resolve(stored === undefined || stored.length === 0
      ? { configured: false, writable: true }
      : { configured: true, source: STORE_SOURCE, writable: true })
  }

  /**
   * Store one value in the bucket.
   * @param ref - the reference to store.
   * @param value - the non-empty secret value.
   */
  override async set(ref: CredentialRef, value: string): Promise<void> {
    if (value.length === 0) throw new Error(`dsh-oss-sync: refusing to store an empty value for "${ref}" (use unset)`)
    this.refuseShadowed(ref)
    await this.enqueue(() => this.commit(document => ({ ...document, refs: { ...document.refs, [ref]: value } })))
    this.notifyUpdated(ref)
  }

  /**
   * Remove one reference from the bucket; removing an absent reference is a no-op.
   * @param ref - the reference to remove.
   */
  override async unset(ref: CredentialRef): Promise<void> {
    this.refuseShadowed(ref)
    if (this.local.refs[ref] === undefined) return
    await this.enqueue(() => this.commit((document) => {
      const { [ref]: _removed, ...rest } = document.refs
      return { ...document, refs: rest }
    }))
    this.notifyUpdated(ref)
  }

  /**
   * Read one stored record.
   * @param key - the record to read.
   * @returns the record as its owner wrote it, or `undefined` while none is stored.
   */
  override readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    const record = this.local.records[key]
    return Promise.resolve(record === undefined ? undefined : structuredClone(record))
  }

  /**
   * Describe one record without exposing its value.
   * @param key - the record to describe.
   * @returns presence, discriminant, and writability.
   */
  override describeRecord(key: CredentialKey): Promise<CredentialRecordInfo> {
    const record = this.local.records[key]
    return Promise.resolve(record === undefined
      ? { configured: false, writable: true }
      : { configured: true, kind: record.kind, writable: true })
  }

  /**
   * Enumerate every stored record's address and tag.
   * @returns every stored record, values excluded.
   */
  override listRecords(): Promise<readonly CredentialRecordEntry[]> {
    return Promise.resolve(Object.entries(this.local.records)
      .map(([key, record]) => ({ key: key as CredentialKey, kind: record.kind })))
  }

  /**
   * Serialized read-modify-write over one record. The read, the mutation, and
   * the write run inside one exclusive section here, and the write presents
   * the ETag of the document the mutation saw — so a refresh racing another
   * machine's refresh re-reads and re-applies instead of dropping a token.
   * @param key - the record to modify.
   * @param mutate - receives the current record and returns its replacement, or `undefined` to leave it.
   * @returns the record after the write, or the current one when `mutate` declined.
   */
  override modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    return this.enqueue(async () => {
      // A retried attempt re-runs the mutation against the newer document,
      // which is the seam's contract: the mutation sees the record as it
      // stands when the write is exclusive.
      const committed = await this.commit(async (document) => {
        const current = document.records[key]
        const next = await mutate(current === undefined ? undefined : structuredClone(current))
        if (next === undefined) return undefined
        return { ...document, records: { ...document.records, [key]: structuredClone(next) } }
      })
      if (committed.written) this.notifyRecordUpdated(key)
      const stored = committed.doc.records[key]
      return stored === undefined ? undefined : structuredClone(stored)
    })
  }

  /**
   * Remove one record; removing an absent record is a no-op.
   * @param key - the record to remove.
   */
  override async deleteRecord(key: CredentialKey): Promise<void> {
    if (this.local.records[key] === undefined) return
    await this.enqueue(() => this.commit((document) => {
      const { [key]: _removed, ...rest } = document.records
      return { ...document, records: rest }
    }))
    this.notifyRecordUpdated(key)
  }

  /**
   * Read the stored document once at registration, falling back to this
   * machine's cache when the service is unreachable.
   */
  private async load(): Promise<CredentialDocument> {
    try {
      const remote = await this.store.read(this.key)
      if (remote === undefined) {
        const cached = await this.state.readCache<CredentialDocument>(OBJECT_NAME)
        if (cached === undefined) return emptyDocument()
        this.local = asDocument(cached.doc)
        this.revision = cached.rev
        this.ctx.logger.warn('dsh-oss-sync: %s does not exist yet; seeding from the local cache', this.key)
        return this.local
      }
      const envelope = parseEnvelope<CredentialDocument>(remote.text)
      this.etag = remote.etag
      this.revision = envelope.rev
      this.local = asDocument(envelope.doc)
      await this.state.writeCache(OBJECT_NAME, { ...envelope, doc: this.local })
      return this.local
    } catch (error) {
      const cached = await this.state.readCache<CredentialDocument>(OBJECT_NAME)
      this.ctx.logger.warn('dsh-oss-sync: could not read %s; running from the local cache', this.key)
      this.ctx.logger.warn(error)
      if (cached === undefined) return emptyDocument()
      this.local = asDocument(cached.doc)
      this.revision = cached.rev
      return this.local
    }
  }

  async* [Service.init](): AsyncGenerator<() => Promise<void> | void, void, void> {
    await this.store.preflight()
    this.local = await this.load()
    this.poll.start()
    yield async () => {
      this.closed = true
      await this.poll.stop()
      await this.operations
      this.store.destroy()
    }
  }

  /**
   * Apply one edit to the stored document and commit it under the ETag of the
   * revision the edit saw, retrying against a newer revision when another
   * machine committed in between. An edit that returns `undefined` declines
   * the write, so a `modifyRecord` that leaves its record alone costs no
   * revision and notifies no observer.
   * @param edit - the edit, applied to the revision read inside the exclusive section.
   * @returns the resulting document and whether storage was written.
   */
  private async commit(
    edit: (document: CredentialDocument) => CredentialDocument | undefined | Promise<CredentialDocument | undefined>,
  ): Promise<{ doc: CredentialDocument, written: boolean }> {
    for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
      let remote
      try {
        remote = await this.store.read(this.key)
      } catch (error) {
        throw new Error(`dsh-oss-sync: cannot read ${this.key} before writing it: ${String(error)}`)
      }
      const stored = remote === undefined ? undefined : parseEnvelope<CredentialDocument>(remote.text)
      // A vanished object with a revision already observed means another
      // machine deleted the document; without one, a machine that started
      // offline seeds storage from the state it already carries.
      const base: CredentialDocument = remote === undefined
        ? (this.etag === undefined ? this.local : emptyDocument())
        : asDocument(stored?.doc)
      const next = await edit(base)
      if (next === undefined) return { doc: base, written: false }
      const envelope: Envelope<CredentialDocument> = {
        v: ENVELOPE_VERSION,
        rev: (stored?.rev ?? 0) + 1,
        writer: await this.state.deviceId(),
        updatedAt: new Date().toISOString(),
        doc: next,
      }
      try {
        const written = await this.store.write(this.key, encodeEnvelope(envelope), remote === undefined
          ? { ifNoneMatch: true }
          : { ifMatch: remote.etag })
        this.etag = written.etag
        this.revision = envelope.rev
        this.local = next
        await this.state.writeCache(OBJECT_NAME, envelope)
        return { doc: next, written: true }
      } catch (error) {
        if (error instanceof PreconditionFailedError && attempt < MAX_WRITE_ATTEMPTS) continue
        throw error
      }
    }
    throw new Error(`dsh-oss-sync: gave up writing ${this.key} after ${String(MAX_WRITE_ATTEMPTS)} attempts`)
  }

  /** Read storage once and notify every reference and record another machine changed. */
  private refresh(): Promise<void> {
    return this.enqueue(async () => {
      if (this.closed) return
      let remote
      try {
        remote = await this.store.read(this.key)
      } catch (error) {
        this.ctx.logger.warn('dsh-oss-sync: could not read %s; keeping the last good document', this.key)
        this.ctx.logger.warn(error)
        return
      }
      if (remote === undefined) return
      if (this.etag !== undefined && remote.etag === this.etag) return
      const envelope = parseEnvelope<CredentialDocument>(remote.text)
      if (envelope.writer === await this.state.deviceId() && envelope.rev === this.revision) return
      const previous = this.local
      const next = asDocument(envelope.doc)
      this.etag = remote.etag
      this.revision = envelope.rev
      this.local = next
      await this.state.writeCache(OBJECT_NAME, { ...envelope, doc: next })
      this.ctx.logger.info('dsh-oss-sync: applying credential revision %d from %s', envelope.rev, envelope.writer)
      for (const ref of new Set([...Object.keys(previous.refs), ...Object.keys(next.refs)])) {
        if (previous.refs[ref] !== next.refs[ref]) this.notifyUpdated(ref as CredentialRef)
      }
      for (const key of new Set([...Object.keys(previous.records), ...Object.keys(next.records)])) {
        if (JSON.stringify(previous.records[key]) !== JSON.stringify(next.records[key])) {
          this.notifyRecordUpdated(key as CredentialKey)
        }
      }
    })
  }

  /** Refuse a write while a read-only ambient value shadows the reference. */
  private refuseShadowed(ref: CredentialRef): void {
    const ambient = process.env[ref]
    if (ambient !== undefined && ambient.length > 0) {
      throw new Error(`dsh-oss-sync: "${ref}" is supplied by the launching environment and cannot be written; clear it first`)
    }
  }

  /** Queue one exclusive operation behind every earlier one. */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.operations.then(operation)
    this.operations = task.then(() => undefined, () => undefined)
    return task
  }
}

export default OssCredentialProvider
