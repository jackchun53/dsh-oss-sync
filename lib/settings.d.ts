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
import type { Context } from '@deepseek-ai/cordis';
import { Service } from '@deepseek-ai/cordis';
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings';
import z from '@deepseek-ai/schemastery';
import { type Config } from './config.js';
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
export declare class OssSettingsProvider extends SettingsProvider {
    static Config: z<Config>;
    /** Parameters the entry config supplies; the namespace overrides them. */
    private readonly bootstrap;
    /** The bucket credentials this machine saved from the settings page, if any. */
    private connection;
    private readonly state;
    /** Parameters in force now. */
    private spec;
    private store;
    private key;
    private readonly poll;
    private scope;
    /** Last request token this provider acted on. */
    private handled;
    /** Status each participant last reported. */
    private readonly status;
    private readonly participants;
    /**
     * The document this process considers current. It is what the seam holds
     * and what a deferred publish republishes, so a publish can never resurrect
     * a superseded local view.
     */
    private local;
    /** ETag of the revision {@link local} reflects; `undefined` until one is read. */
    private etag;
    /** Revision number {@link etag} belongs to. */
    private revision;
    /** Serializes remote reads and writes, so a poll never interleaves a write. */
    private operations;
    /** Set at dispose: refuse new work and let in-flight work settle. */
    private closed;
    constructor(ctx: Context, config: Config);
    /** Storage is always writable through {@link SettingsProvider.persist}. */
    get writable(): boolean;
    /**
     * Read the stored document once at registration. An unreachable service
     * falls back to the cache this machine last saw, because a laptop that
     * starts offline must still boot with its own configuration; a stored
     * object that is not an envelope this plugin understands is refused.
     */
    protected load(): Promise<Record<string, unknown>>;
    /**
     * This machine's own copy of the document: what a start without a bucket and
     * an unreachable bucket both fall back to.
     * @returns the cached document, or `undefined` while this machine has none.
     */
    private loadCache;
    /**
     * Store one namespace's next user section.
     *
     * The write re-reads the object, keeps every section the newer revision
     * carries, overlays this namespace's section, and commits under the ETag it
     * read. A refusal means another machine committed in between: the loop
     * re-reads and re-applies, so the loser of the race retries against the
     * winner's document rather than overwriting it.
     */
    protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void>;
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
    private commitLocally;
    /**
     * Put this machine's saved bucket credentials in force, before the first read.
     *
     * They are deliberately local: reading the document is what needs them, so
     * they cannot live in it. A hand-edited half pair is ignored rather than
     * fatal — the entry config still applies and the card can repair it.
     */
    private adoptStoredConnection;
    /** The composition layer the sync namespace resolves over. */
    private baseLayer;
    /**
     * Keep this machine's copy of the bucket credentials in step with the page.
     *
     * A half-filled pair is left alone until the save is complete, so the store
     * is never rebuilt around half a credential.
     * @param section - the merged user section as the seam holds it.
     */
    private syncStoredConnection;
    [Service.init](): AsyncGenerator<() => Promise<void> | void, void, void>;
    /** The coordination handle the credentials provider joins. */
    private createControl;
    /**
     * React to a committed `oss-sync` section: run a requested sync, then adopt
     * any connection parameter the user changed.
     */
    private onSettings;
    /**
     * Report a bucket this process cannot use yet.
     * @returns the failure's text, or `undefined` when storage preflight passed
     *   (including the local-only start, which contacts nothing).
     */
    private preflight;
    /**
     * Adopt the settings the page resolved. A connection the page asked for may
     * be unreachable or lack credentials; that is a status line the card shows,
     * never a reason to take the host or the page down.
     * @param next - the namespace value as the seam resolved it.
     */
    private reconcileOrReport;
    /** Poll only while a bucket is configured; a cleared bucket suspends the loop. */
    private applyPoll;
    /** Run the verb a card asked for on this provider and every participant. */
    private runRequested;
    /**
     * Adopt the parameters the namespace now resolves to. A poll interval
     * applies immediately; a changed connection or prefix moves the providers
     * to the new location, carrying the document this process holds when the
     * target is empty.
     */
    private reconcile;
    /** Move both documents' home to the parameters the settings page asked for. */
    private relocate;
    /** Swap in a relocation target that has proven reachable, releasing the store it replaces. */
    private adoptRelocation;
    /**
     * Move every participant to the location this provider just adopted.
     *
     * The credentials half follows the same namespace, and the seam offers no
     * cross-namespace observer, so without this poke a connection saved on the
     * page would reach the settings document now and the credential document
     * only at the next poll — or never, while the local-only start has the poll
     * suspended.
     */
    private follow;
    /** Adopt one stored revision as this process's document. */
    private adopt;
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
    private withLocalFields;
    /** Publish the seam's document with the runtime status merged in. */
    private publishDocument;
    /** Merge one participant's status and republish the namespace. */
    private report;
    /**
     * Re-commit this machine's document, which is what a `push` request asks
     * for. The write keeps the same precondition as any other, so a remote that
     * moved first wins and this machine reports the pull instead of erasing it.
     */
    private push;
    /** Read storage once and publish a revision this process did not commit. */
    private refresh;
    /** Set while the exclusive section runs, so a nested step joins it instead of queueing behind it. */
    private exclusive;
    /** Queue one exclusive operation behind every earlier one. */
    private enqueue;
}
export default OssSettingsProvider;
