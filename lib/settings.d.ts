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
     * Store one namespace's next user section.
     *
     * The write re-reads the object, keeps every section the newer revision
     * carries, overlays this namespace's section, and commits under the ETag it
     * read. A refusal means another machine committed in between: the loop
     * re-reads and re-applies, so the loser of the race retries against the
     * winner's document rather than overwriting it.
     */
    protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void>;
    [Service.init](): AsyncGenerator<() => Promise<void> | void, void, void>;
    /** The coordination handle the credentials provider joins. */
    private createControl;
    /**
     * React to a committed `oss-sync` section: run a requested sync, then adopt
     * any connection parameter the user changed.
     */
    private onSettings;
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
    /** Adopt one stored revision as this process's document. */
    private adopt;
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
    /** Queue one exclusive operation behind every earlier one. */
    private enqueue;
}
export default OssSettingsProvider;
