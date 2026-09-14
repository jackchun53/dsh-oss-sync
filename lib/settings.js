/**
 * User settings stored in an S3-compatible bucket instead of a local file.
 *
 * One object holds the whole document — the same namespace-to-section mapping
 * `dsh-settings-file` keeps in `settings.yaml` — wrapped in a revision
 * envelope. A write presents the ETag it read, so two machines can never
 * overwrite each other silently; a poll publishes another machine's committed
 * revision into the seam, which re-resolves every registered namespace.
 *
 * @module dsh-oss-sync/settings
 */
import { Service } from '@deepseek-ai/cordis';
import { SettingsProvider } from '@deepseek-ai/dsh-settings';
import z from '@deepseek-ai/schemastery';
import { ConfigSchema, resolveConfig } from './config.js';
import { ENVELOPE_VERSION, SyncState, encodeEnvelope, parseEnvelope } from './envelope.js';
import { PollLoop } from './poll.js';
import { ObjectStore, PreconditionFailedError } from './store.js';
/** Object name under the configured prefix. */
const OBJECT_NAME = 'settings.yaml';
/** Attempts a conditional write makes against a moving object before giving up. */
const MAX_WRITE_ATTEMPTS = 5;
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
    static Config = ConfigSchema;
    store;
    state;
    key;
    poll;
    /**
     * The document this process considers current. It is what the seam holds
     * and what a deferred publish republishes, so a publish can never resurrect
     * a superseded local view.
     */
    local = {};
    /** ETag of the revision {@link local} reflects; `undefined` until one is read. */
    etag;
    /** Revision number {@link etag} belongs to. */
    revision = 0;
    /** Serializes remote reads and writes, so a poll never interleaves a write. */
    operations = Promise.resolve();
    /** Set at dispose: refuse new work and let in-flight work settle. */
    closed = false;
    constructor(ctx, config) {
        super(ctx);
        const resolved = resolveConfig(config);
        this.store = new ObjectStore(resolved);
        this.state = new SyncState(resolved.stateDir);
        this.key = `${resolved.prefix}/${OBJECT_NAME}`;
        this.poll = new PollLoop(resolved.pollMs, () => this.refresh(), (error) => {
            this.ctx.logger.error('dsh-oss-sync: settings poll failed at %s', this.key);
            this.ctx.logger.error(error);
        });
    }
    /** Storage is always writable through {@link SettingsProvider.persist}. */
    get writable() {
        return true;
    }
    /**
     * Read the stored document once at registration. An unreachable service
     * falls back to the cache this machine last saw, because a laptop that
     * starts offline must still boot with its own configuration; a stored
     * object that is not an envelope this plugin understands is refused.
     */
    async load() {
        try {
            const remote = await this.store.read(this.key);
            if (remote === undefined) {
                // No stored revision yet: keep whatever this machine last cached, so
                // the first writer seeds the bucket instead of erasing its own state.
                const cached = await this.state.readCache(OBJECT_NAME);
                if (cached === undefined)
                    return {};
                this.local = cached.doc;
                this.revision = cached.rev;
                this.ctx.logger.warn('dsh-oss-sync: %s does not exist yet; seeding from the local cache', this.key);
                return cached.doc;
            }
            const envelope = parseEnvelope(remote.text);
            this.etag = remote.etag;
            this.revision = envelope.rev;
            this.local = envelope.doc;
            await this.state.writeCache(OBJECT_NAME, envelope);
            return envelope.doc;
        }
        catch (error) {
            const cached = await this.state.readCache(OBJECT_NAME);
            this.ctx.logger.warn('dsh-oss-sync: could not read %s; running from the local cache', this.key);
            this.ctx.logger.warn(error);
            if (cached === undefined)
                return {};
            this.local = cached.doc;
            this.revision = cached.rev;
            return cached.doc;
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
    persist(ns, section) {
        return this.enqueue(async () => {
            for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
                let remote;
                try {
                    remote = await this.store.read(this.key);
                }
                catch (error) {
                    throw new Error(`dsh-oss-sync: cannot read ${this.key} before writing it: ${String(error)}`);
                }
                const stored = remote === undefined ? undefined : parseEnvelope(remote.text);
                // A vanished object with a revision already observed means another
                // machine deleted the document; without one, a machine that started
                // offline seeds storage from the state it already carries.
                const base = remote === undefined
                    ? (this.etag === undefined ? this.local : {})
                    : stored?.doc ?? {};
                const next = { ...base, [ns]: section };
                const envelope = {
                    v: ENVELOPE_VERSION,
                    rev: (stored?.rev ?? 0) + 1,
                    writer: await this.state.deviceId(),
                    updatedAt: new Date().toISOString(),
                    doc: next,
                };
                try {
                    const written = await this.store.write(this.key, encodeEnvelope(envelope), remote === undefined
                        ? { ifNoneMatch: true }
                        : { ifMatch: remote.etag });
                    this.etag = written.etag;
                    this.revision = envelope.rev;
                    this.local = next;
                    await this.state.writeCache(OBJECT_NAME, envelope);
                    // Deferred: the seam commits this namespace only after persist
                    // returns, so publishing synchronously would emit the pre-write
                    // value first. By the time this runs, a later local write has also
                    // landed in `local`, so republishing it cannot resurrect a stale one.
                    setImmediate(() => {
                        if (!this.closed)
                            this.publish(this.local);
                    });
                    return;
                }
                catch (error) {
                    if (error instanceof PreconditionFailedError && attempt < MAX_WRITE_ATTEMPTS)
                        continue;
                    throw error;
                }
            }
        });
    }
    async *[Service.init]() {
        await this.store.preflight();
        // The base init loads and publishes; an unreadable bucket has already
        // fallen back to the cache there, so this cannot fail on an offline host.
        yield* super[Service.init]();
        this.poll.start();
        yield async () => {
            this.closed = true;
            await this.poll.stop();
            await this.operations;
            this.store.destroy();
        };
    }
    /** Read storage once and publish a revision this process did not commit. */
    refresh() {
        return this.enqueue(async () => {
            if (this.closed)
                return;
            let remote;
            try {
                remote = await this.store.read(this.key);
            }
            catch (error) {
                this.ctx.logger.warn('dsh-oss-sync: could not read %s; keeping the last good document', this.key);
                this.ctx.logger.warn(error);
                return;
            }
            if (remote === undefined)
                return;
            if (this.etag !== undefined && remote.etag === this.etag)
                return;
            const envelope = parseEnvelope(remote.text);
            if (envelope.writer === await this.state.deviceId() && envelope.rev === this.revision)
                return;
            this.etag = remote.etag;
            this.revision = envelope.rev;
            this.local = envelope.doc;
            await this.state.writeCache(OBJECT_NAME, envelope);
            this.ctx.logger.info('dsh-oss-sync: applying settings revision %d from %s', envelope.rev, envelope.writer);
            // The stored revision is newer, so it is authoritative for every
            // namespace: a section it dropped stays dropped here.
            this.publish(envelope.doc, 'provider');
        });
    }
    /** Queue one exclusive operation behind every earlier one. */
    enqueue(operation) {
        const task = this.operations.then(operation);
        this.operations = task.then(() => undefined, () => undefined);
        return task;
    }
}
export default OssSettingsProvider;
