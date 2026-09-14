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
import { Service } from '@deepseek-ai/cordis';
import { SettingsProvider } from '@deepseek-ai/dsh-settings';
import z from '@deepseek-ai/schemastery';
import { ConfigSchema, applyOverrides, mergeConnection, resolveConfig, sameConnection, } from './config.js';
import { LOCAL_CREDENTIAL_FIELDS, SYNC_NAMESPACE, requestVerb, storedDocument, storedSection, } from './control.js';
import { ENVELOPE_VERSION, SyncState, encodeEnvelope, parseEnvelope, } from './envelope.js';
import { PollLoop } from './poll.js';
import { ObjectStore, PreconditionFailedError } from './store.js';
/** This provider's key in the namespace's status map. */
const STATUS_LABEL = 'settings';
/** Object name under the configured prefix. */
const OBJECT_NAME = 'settings.yaml';
/** Attempts a conditional write makes against a moving object before giving up. */
const MAX_WRITE_ATTEMPTS = 5;
/** Schema of the namespace the settings page binds to. */
const SyncSettingsSchema = z.object({
    bucket: z.string(),
    endpoint: z.string(),
    region: z.string(),
    prefix: z.string(),
    pollMs: z.number().min(1000),
    forcePathStyle: z.boolean(),
    accessKeyIdEnv: z.string(),
    secretAccessKeyEnv: z.string(),
    accessKeyId: z.string(),
    secretAccessKey: z.string(),
    status: z.any(),
    request: z.string(),
});
/** Object key for one resolved prefix. */
function objectKey(spec) {
    return `${spec.prefix}/${OBJECT_NAME}`;
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
    static Config = ConfigSchema;
    /** Parameters the entry config supplies; the namespace overrides them. */
    bootstrap;
    /** The bucket credentials this machine saved from the settings page, if any. */
    connection;
    state;
    /** Parameters in force now. */
    spec;
    store;
    key;
    poll;
    scope;
    /** Last request token this provider acted on. */
    handled;
    /** Status each participant last reported. */
    status = {};
    participants = new Map();
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
        this.bootstrap = resolveConfig(config);
        this.state = new SyncState(this.bootstrap.stateDir);
        this.spec = this.bootstrap;
        this.store = new ObjectStore(this.spec);
        this.key = objectKey(this.spec);
        this.poll = new PollLoop(this.spec.pollMs, () => this.refresh(), (error) => {
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
        // With no bucket there is no remote to read, and nothing to report: the
        // page is about to be where one is set.
        if (!this.store.configured)
            return await this.loadCache() ?? {};
        try {
            const remote = await this.store.read(this.key);
            if (remote === undefined) {
                // No stored revision yet: keep whatever this machine last cached, so
                // the first writer seeds the bucket instead of erasing its own state.
                const cached = await this.loadCache();
                if (cached === undefined)
                    return {};
                this.ctx.logger.warn('dsh-oss-sync: %s does not exist yet; seeding from the local cache', this.key);
                return cached;
            }
            const envelope = parseEnvelope(remote.text);
            return this.adopt(envelope, remote.etag);
        }
        catch (error) {
            this.ctx.logger.warn('dsh-oss-sync: could not read %s; running from the local cache', this.key);
            this.ctx.logger.warn(error);
            return await this.loadCache() ?? {};
        }
    }
    /**
     * This machine's own copy of the document: what a start without a bucket and
     * an unreachable bucket both fall back to.
     * @returns the cached document, or `undefined` while this machine has none.
     */
    async loadCache() {
        const cached = await this.state.readCache(OBJECT_NAME);
        if (cached === undefined)
            return undefined;
        this.local = cached.doc;
        this.revision = cached.rev;
        return cached.doc;
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
    async persist(ns, section) {
        // The sync namespace's own section carries runtime facts and this machine's
        // bucket credentials; storage keeps the connection parameters and drops the
        // rest.
        const next = ns === SYNC_NAMESPACE ? storedSection(section) : section;
        if (ns === SYNC_NAMESPACE)
            await this.syncStoredConnection(section);
        if (!this.store.configured)
            return this.commitLocally(ns, section, next);
        return this.enqueue(async () => {
            for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
                let remote;
                try {
                    remote = await this.store.read(this.key);
                }
                catch (error) {
                    // The sync namespace carries the connection itself: refusing its
                    // write would leave a machine whose store broke with no way to
                    // repair the connection from the page. The commit lands locally and
                    // the reconcile it triggers moves the document to what was saved.
                    // Other namespaces keep refusing: their edit must not look saved
                    // while it never reached storage.
                    if (ns === SYNC_NAMESPACE) {
                        this.ctx.logger.warn('dsh-oss-sync: cannot read %s before writing it; committing locally', this.key);
                        this.ctx.logger.warn(error);
                        return this.commitLocally(ns, section, next);
                    }
                    throw new Error(`dsh-oss-sync: cannot read ${this.key} before writing it: ${String(error)}`);
                }
                const stored = remote === undefined ? undefined : parseEnvelope(remote.text);
                // A vanished object with a revision already observed means another
                // machine deleted the document; without one, a machine that started
                // offline seeds storage from the state it already carries. Either way
                // the runtime fields come off: the seam's document holds this process's
                // status, and storage keeps configuration only.
                const base = remote === undefined
                    ? (this.etag === undefined ? storedDocument(this.local) : {})
                    : stored === undefined ? {} : storedDocument(stored.doc);
                const document = { ...base, [ns]: next };
                const envelope = {
                    v: ENVELOPE_VERSION,
                    rev: (stored?.rev ?? 0) + 1,
                    writer: await this.state.deviceId(),
                    updatedAt: new Date().toISOString(),
                    doc: document,
                };
                try {
                    const written = await this.store.write(this.key, encodeEnvelope(envelope), remote === undefined
                        ? { ifNoneMatch: true }
                        : { ifMatch: remote.etag });
                    this.etag = written.etag;
                    this.revision = envelope.rev;
                    // The seam holds the section it was handed, runtime fields included;
                    // only storage is narrowed.
                    this.local = { ...document, [ns]: section };
                    await this.state.writeCache(OBJECT_NAME, envelope);
                    this.report(STATUS_LABEL, { lastWriteAt: envelope.updatedAt, lastError: undefined, state: 'idle' });
                    // Deferred: the seam commits this namespace only after persist
                    // returns, so publishing synchronously would emit the pre-write
                    // value first. By the time this runs, a later local write has also
                    // landed in `local`, so republishing it cannot resurrect a stale one.
                    setImmediate(() => {
                        if (!this.closed)
                            this.publishDocument();
                    });
                    return;
                }
                catch (error) {
                    if (error instanceof PreconditionFailedError && attempt < MAX_WRITE_ATTEMPTS)
                        continue;
                    this.report(STATUS_LABEL, { state: 'error', lastError: String(error) });
                    throw error;
                }
            }
        });
    }
    /**
     * Commit one edit without storage, for the machine that has no bucket yet.
     *
     * The seam is what the page configures the connection through, so it has to
     * work before a connection exists: the document stays in memory and in the
     * cache, and the first bucket saved here seeds it to that location.
     * @param ns - the namespace being written.
     * @param section - the section as the seam holds it, runtime fields included.
     * @param stored - the section narrowed to what storage would keep.
     */
    commitLocally(ns, section, stored) {
        return this.enqueue(async () => {
            const envelope = {
                v: ENVELOPE_VERSION,
                rev: this.revision + 1,
                writer: await this.state.deviceId(),
                updatedAt: new Date().toISOString(),
                doc: { ...storedDocument(this.local), [ns]: stored },
            };
            this.revision = envelope.rev;
            this.local = { ...envelope.doc, [ns]: section };
            await this.state.writeCache(OBJECT_NAME, envelope);
            this.report(STATUS_LABEL, { state: 'idle', lastError: undefined });
            setImmediate(() => {
                if (!this.closed)
                    this.publishDocument();
            });
        });
    }
    /**
     * Put this machine's saved bucket credentials in force, before the first read.
     *
     * They are deliberately local: reading the document is what needs them, so
     * they cannot live in it. A hand-edited half pair is ignored rather than
     * fatal — the entry config still applies and the card can repair it.
     */
    async adoptStoredConnection() {
        this.connection = await this.state.readConnection();
        const merged = mergeConnection(this.bootstrap, this.connection);
        if (sameConnection(merged, this.spec))
            return;
        try {
            const replacement = new ObjectStore(merged);
            this.store.destroy();
            this.store = replacement;
            this.spec = merged;
        }
        catch (error) {
            this.ctx.logger.error('dsh-oss-sync: ignoring the bucket credentials saved on this machine');
            this.ctx.logger.error(error);
            this.connection = undefined;
        }
    }
    /** The composition layer the sync namespace resolves over. */
    baseLayer() {
        const { stateDir: _stateDir, ...base } = { ...this.bootstrap, ...this.connection };
        return base;
    }
    /**
     * Keep this machine's copy of the bucket credentials in step with the page.
     *
     * A half-filled pair is left alone until the save is complete, so the store
     * is never rebuilt around half a credential.
     * @param section - the merged user section as the seam holds it.
     */
    async syncStoredConnection(section) {
        if (!('accessKeyId' in section) && !('secretAccessKey' in section))
            return;
        const text = (field) => {
            const value = section[field];
            return typeof value === 'string' && value.length > 0 ? value : undefined;
        };
        const accessKeyId = text('accessKeyId');
        const secretAccessKey = text('secretAccessKey');
        if (accessKeyId === undefined && secretAccessKey === undefined) {
            this.connection = undefined;
            await this.state.writeConnection();
            return;
        }
        if (accessKeyId === undefined || secretAccessKey === undefined)
            return;
        this.connection = { accessKeyId, secretAccessKey };
        await this.state.writeConnection(this.connection);
    }
    async *[Service.init]() {
        // This machine's own copy of the bucket credentials is a bootstrap layer:
        // the store needs them before the first read, which happens before any
        // namespace resolves.
        await this.adoptStoredConnection();
        // A bucket this process cannot authenticate against is a status line, not
        // a reason to refuse to boot: the cache still serves this machine, and the
        // settings card reports the variables that are missing.
        const preflightError = await this.preflight();
        // The base init loads and publishes; an unreadable bucket has already
        // fallen back to the cache there, so this cannot fail on an offline host.
        yield* super[Service.init]();
        this.scope = this.register(SYNC_NAMESPACE, SyncSettingsSchema, { base: this.baseLayer() });
        this.ctx.provide('ossSyncControl', this.createControl());
        await this.reconcileOrReport(this.scope.get());
        this.scope.watch(next => this.onSettings(next));
        this.report(STATUS_LABEL, {
            state: preflightError === undefined ? 'idle' : 'error',
            ...preflightError === undefined ? {} : { lastError: preflightError },
            revision: this.revision,
            writer: '',
            updatedAt: '',
            deviceId: await this.state.deviceId(),
            objectKey: this.key,
        });
        this.applyPoll();
        yield async () => {
            this.closed = true;
            await this.poll.stop();
            await this.operations;
            this.store.destroy();
        };
    }
    /** The coordination handle the credentials provider joins. */
    createControl() {
        return {
            join: (label, participant) => {
                this.participants.set(label, participant);
                return () => { this.participants.delete(label); };
            },
            report: (label, patch) => { this.report(label, patch); },
        };
    }
    /**
     * React to a committed `oss-sync` section: run a requested sync, then adopt
     * any connection parameter the user changed.
     */
    async onSettings(next) {
        if (next.request !== undefined && next.request !== this.handled) {
            this.handled = next.request;
            await this.runRequested(next.request);
            return;
        }
        await this.reconcileOrReport(next);
    }
    /**
     * Report a bucket this process cannot use yet.
     * @returns the failure's text, or `undefined` when storage preflight passed
     *   (including the local-only start, which contacts nothing).
     */
    async preflight() {
        try {
            await this.store.preflight();
            return undefined;
        }
        catch (error) {
            this.ctx.logger.error('dsh-oss-sync: storage is not usable yet; serving this machine\'s cached document');
            this.ctx.logger.error(error);
            return String(error);
        }
    }
    /**
     * Adopt the settings the page resolved. A connection the page asked for may
     * be unreachable or lack credentials; that is a status line the card shows,
     * never a reason to take the host or the page down.
     * @param next - the namespace value as the seam resolved it.
     */
    async reconcileOrReport(next) {
        try {
            await this.reconcile(next);
        }
        catch (error) {
            this.ctx.logger.error('dsh-oss-sync: could not apply the sync settings');
            this.ctx.logger.error(error);
            this.report(STATUS_LABEL, { state: 'error', lastError: String(error) });
        }
    }
    /** Poll only while a bucket is configured; a cleared bucket suspends the loop. */
    applyPoll() {
        if (this.spec.bucket.length === 0)
            this.poll.pause();
        else
            this.poll.start();
    }
    /** Run the verb a card asked for on this provider and every participant. */
    async runRequested(request) {
        const verb = requestVerb(request);
        this.ctx.logger.info('dsh-oss-sync: %s requested from the settings page', verb);
        const participants = [...this.participants.values()];
        if (verb === 'push') {
            await Promise.allSettled([this.push(), ...participants.map(participant => participant.push())]);
            return;
        }
        await Promise.allSettled([this.refresh(), ...participants.map(participant => participant.refresh())]);
    }
    /**
     * Adopt the parameters the namespace now resolves to. A poll interval
     * applies immediately; a changed connection or prefix moves the providers
     * to the new location, carrying the document this process holds when the
     * target is empty.
     */
    async reconcile(next) {
        const desired = applyOverrides(this.bootstrap, next);
        if (desired.pollMs !== this.spec.pollMs)
            this.poll.restart(desired.pollMs);
        if (sameConnection(desired, this.spec) && desired.prefix === this.spec.prefix) {
            this.spec = desired;
            this.applyPoll();
            return;
        }
        await this.relocate(desired);
    }
    /** Move both documents' home to the parameters the settings page asked for. */
    relocate(desired) {
        return this.enqueue(async () => {
            const carried = storedDocument(this.local);
            const connectionChanged = !sameConnection(desired, this.spec);
            // Build the replacement before anything is swapped: a store that cannot
            // be built must leave this provider on the connection it still serves.
            const replacement = connectionChanged ? new ObjectStore(desired) : undefined;
            const target = replacement ?? this.store;
            const nextKey = objectKey(desired);
            try {
                if (!target.configured) {
                    // The page cleared the bucket: keep serving this machine's document
                    // and stop reaching for a service until one is set again.
                    this.adoptRelocation(desired, replacement, nextKey);
                    this.etag = undefined;
                    this.applyPoll();
                    this.report(STATUS_LABEL, { state: 'idle', lastError: undefined });
                    return;
                }
                // The target proves itself before it is adopted — the credential chain
                // resolves, then the bucket answers a read — so a location this
                // machine cannot reach leaves the working connection in place, and a
                // later page save can still repair it.
                if (replacement !== undefined)
                    await replacement.preflight();
                const remote = await target.read(nextKey);
                if (remote === undefined) {
                    // The target starts from nothing: seed it from the document already
                    // in hand, so switching buckets or prefixes carries the
                    // configuration instead of appearing to lose it.
                    const envelope = {
                        v: ENVELOPE_VERSION,
                        rev: this.revision + 1,
                        writer: await this.state.deviceId(),
                        updatedAt: new Date().toISOString(),
                        doc: carried,
                    };
                    const written = await target.write(nextKey, encodeEnvelope(envelope), { ifNoneMatch: true });
                    this.adoptRelocation(desired, replacement, nextKey);
                    this.etag = written.etag;
                    this.revision = envelope.rev;
                    await this.state.writeCache(OBJECT_NAME, envelope);
                    this.local = this.withLocalFields(carried);
                    this.ctx.logger.info('dsh-oss-sync: moved to %s and seeded it from this machine', this.key);
                }
                else {
                    const envelope = parseEnvelope(remote.text);
                    this.adoptRelocation(desired, replacement, nextKey);
                    this.adopt(envelope, remote.etag);
                    await this.state.writeCache(OBJECT_NAME, envelope);
                    this.ctx.logger.info('dsh-oss-sync: moved to %s and adopted revision %d', this.key, envelope.rev);
                }
            }
            catch (error) {
                replacement?.destroy();
                this.report(STATUS_LABEL, { state: 'error', lastError: String(error), objectKey: nextKey });
                throw error;
            }
            this.publishDocument();
            await this.follow();
        });
    }
    /** Swap in a relocation target that has proven reachable, releasing the store it replaces. */
    adoptRelocation(desired, replacement, nextKey) {
        if (replacement !== undefined) {
            this.store.destroy();
            this.store = replacement;
        }
        this.spec = desired;
        this.key = nextKey;
    }
    /**
     * Move every participant to the location this provider just adopted.
     *
     * The credentials half follows the same namespace, and the seam offers no
     * cross-namespace observer, so without this poke a connection saved on the
     * page would reach the settings document now and the credential document
     * only at the next poll — or never, while the local-only start has the poll
     * suspended.
     */
    async follow() {
        await Promise.allSettled([...this.participants.values()].map(participant => participant.refresh()));
    }
    /** Adopt one stored revision as this process's document. */
    adopt(envelope, etag) {
        this.etag = etag;
        this.revision = envelope.rev;
        this.local = this.withLocalFields(envelope.doc);
        return this.local;
    }
    /**
     * Adopt a document that came from storage, keeping the fields that only ever
     * live here.
     *
     * Storage never carries this machine's bucket credentials, so a poll that
     * overwrote the seam with the stored document would erase the pair the page
     * saved — and the next reconcile would then lose the connection with it.
     * @param document - the document as stored.
     * @returns the document the seam holds.
     */
    withLocalFields(document) {
        const current = this.local[SYNC_NAMESPACE];
        if (current === undefined)
            return document;
        const fields = Object.fromEntries(LOCAL_CREDENTIAL_FIELDS
            .filter(field => current[field] !== undefined)
            .map(field => [field, current[field]]));
        if (Object.keys(fields).length === 0)
            return document;
        return { ...document, [SYNC_NAMESPACE]: { ...document[SYNC_NAMESPACE], ...fields } };
    }
    /** Publish the seam's document with the runtime status merged in. */
    publishDocument() {
        // `configured` is a fact about the store in force, not about the last time
        // a provider reported: the page saving a bucket must not keep showing the
        // local-only line until the next poll. Only this provider's own label is
        // stamped — the credentials half reports its own store, and a bucket saved
        // here must not make its line claim a connection that half has not made.
        const status = Object.fromEntries(Object.entries(this.status).map(([label, entry]) => ([label, label === STATUS_LABEL ? { ...entry, configured: this.store.configured } : entry])));
        const section = { ...(this.local[SYNC_NAMESPACE] ?? {}), status };
        const document = { ...this.local, [SYNC_NAMESPACE]: section };
        this.local = document;
        this.publish(document);
    }
    /** Merge one participant's status and republish the namespace. */
    report(label, patch) {
        const previous = this.status[label];
        this.status[label] = {
            state: 'idle',
            configured: this.store.configured,
            revision: this.revision,
            writer: '',
            updatedAt: '',
            deviceId: previous?.deviceId ?? '',
            objectKey: this.key,
            ...previous,
            ...patch,
        };
        if (!this.closed)
            this.publishDocument();
    }
    /**
     * Re-commit this machine's document, which is what a `push` request asks
     * for. The write keeps the same precondition as any other, so a remote that
     * moved first wins and this machine reports the pull instead of erasing it.
     */
    async push() {
        if (!this.store.configured) {
            this.ctx.logger.info('dsh-oss-sync: no bucket configured; there is nowhere to push to yet');
            return;
        }
        const document = storedDocument(this.local);
        await this.enqueue(async () => {
            const remote = await this.store.read(this.key);
            const envelope = {
                v: ENVELOPE_VERSION,
                rev: (remote === undefined ? this.revision : parseEnvelope(remote.text).rev) + 1,
                writer: await this.state.deviceId(),
                updatedAt: new Date().toISOString(),
                doc: document,
            };
            try {
                const written = await this.store.write(this.key, encodeEnvelope(envelope), remote === undefined
                    ? { ifNoneMatch: true }
                    : { ifMatch: remote.etag });
                this.etag = written.etag;
                this.revision = envelope.rev;
                await this.state.writeCache(OBJECT_NAME, envelope);
                this.report(STATUS_LABEL, { state: 'idle', revision: envelope.rev, lastWriteAt: envelope.updatedAt });
            }
            catch (error) {
                if (!(error instanceof PreconditionFailedError))
                    throw error;
                this.ctx.logger.warn('dsh-oss-sync: %s moved while pushing; adopting the stored revision', this.key);
                await this.refresh();
            }
        });
    }
    /** Read storage once and publish a revision this process did not commit. */
    refresh() {
        return this.enqueue(async () => {
            if (this.closed)
                return;
            if (!this.store.configured)
                return;
            let remote;
            try {
                remote = await this.store.read(this.key);
            }
            catch (error) {
                this.ctx.logger.warn('dsh-oss-sync: could not read %s; keeping the last good document', this.key);
                this.ctx.logger.warn(error);
                this.report(STATUS_LABEL, { state: 'error', lastError: String(error) });
                return;
            }
            this.report(STATUS_LABEL, { lastReadAt: new Date().toISOString(), lastError: undefined });
            if (remote === undefined)
                return;
            if (this.etag !== undefined && remote.etag === this.etag)
                return;
            const envelope = parseEnvelope(remote.text);
            if (envelope.writer === await this.state.deviceId() && envelope.rev === this.revision)
                return;
            this.adopt(envelope, remote.etag);
            await this.state.writeCache(OBJECT_NAME, envelope);
            this.ctx.logger.info('dsh-oss-sync: applying settings revision %d from %s', envelope.rev, envelope.writer);
            // The stored revision is newer, so it is authoritative for every
            // namespace: a section it dropped stays dropped here.
            this.report(STATUS_LABEL, { state: 'idle', updatedAt: envelope.updatedAt, writer: envelope.writer });
        });
    }
    /** Set while the exclusive section runs, so a nested step joins it instead of queueing behind it. */
    exclusive = false;
    /** Queue one exclusive operation behind every earlier one. */
    enqueue(operation) {
        // A step the running operation awaits — a refresh reconciling a connection
        // change, whose move is itself exclusive — must run inline: queueing it
        // would wait for the very operation that is waiting for it.
        if (this.exclusive)
            return operation();
        const task = this.operations.then(async () => {
            this.exclusive = true;
            try {
                return await operation();
            }
            finally {
                this.exclusive = false;
            }
        });
        this.operations = task.then(() => undefined, () => undefined);
        return task;
    }
}
export default OssSettingsProvider;
