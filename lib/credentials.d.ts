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
import type { Context } from '@deepseek-ai/cordis';
import { Service } from '@deepseek-ai/cordis';
import { CredentialProvider, type CredentialInfo, type CredentialKey, type CredentialRecord, type CredentialRecordEntry, type CredentialRecordInfo, type CredentialRef, type ResolvedCredential } from '@deepseek-ai/dsh-credentials';
import z from '@deepseek-ai/schemastery';
import { type Config } from './config.js';
/**
 * Credential provider backed by one object in an S3-compatible bucket.
 *
 * Resolution is layered: the launching environment wins and is read-only, so
 * `DEEPSEEK_API_KEY=… dsh` keeps working exactly as it does with the local
 * store and a stored value can never appear to take effect while an ambient
 * one shadows it. Everything else comes from the bucket, refreshed by the
 * poll loop.
 */
export declare class OssCredentialProvider extends CredentialProvider {
    static Config: z<Config>;
    /** Parameters the entry config supplies; the namespace overrides them. */
    private readonly bootstrap;
    private readonly state;
    /** Parameters in force now. */
    private spec;
    private store;
    private key;
    private readonly poll;
    /** Coordination handle, present once the settings half has provided it. */
    private control;
    /** The document this process considers current. */
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
    /**
     * Resolve one reference per call: the ambient environment first, then the
     * stored value. Nothing is cached across calls, so a rotated key reaches
     * the next model request without a restart.
     * @param ref - the reference to resolve.
     * @returns the value and its source, or `undefined` while unconfigured.
     */
    resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined>;
    /**
     * Describe one reference without exposing its value.
     * @param ref - the reference to describe.
     * @returns configured state, supplying source, and writability.
     */
    describe(ref: CredentialRef): Promise<CredentialInfo>;
    /**
     * Store one value in the bucket.
     * @param ref - the reference to store.
     * @param value - the non-empty secret value.
     */
    set(ref: CredentialRef, value: string): Promise<void>;
    /**
     * Remove one reference from the bucket; removing an absent reference is a no-op.
     * @param ref - the reference to remove.
     */
    unset(ref: CredentialRef): Promise<void>;
    /**
     * Read one stored record.
     * @param key - the record to read.
     * @returns the record as its owner wrote it, or `undefined` while none is stored.
     */
    readRecord(key: CredentialKey): Promise<CredentialRecord | undefined>;
    /**
     * Describe one record without exposing its value.
     * @param key - the record to describe.
     * @returns presence, discriminant, and writability.
     */
    describeRecord(key: CredentialKey): Promise<CredentialRecordInfo>;
    /**
     * Enumerate every stored record's address and tag.
     * @returns every stored record, values excluded.
     */
    listRecords(): Promise<readonly CredentialRecordEntry[]>;
    /**
     * Serialized read-modify-write over one record. The read, the mutation, and
     * the write run inside one exclusive section here, and the write presents
     * the ETag of the document the mutation saw — so a refresh racing another
     * machine's refresh re-reads and re-applies instead of dropping a token.
     * @param key - the record to modify.
     * @param mutate - receives the current record and returns its replacement, or `undefined` to leave it.
     * @returns the record after the write, or the current one when `mutate` declined.
     */
    modifyRecord(key: CredentialKey, mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>): Promise<CredentialRecord | undefined>;
    /**
     * Remove one record; removing an absent record is a no-op.
     * @param key - the record to remove.
     */
    deleteRecord(key: CredentialKey): Promise<void>;
    /**
     * Read the stored document once at registration, falling back to this
     * machine's cache when the service is unreachable.
     */
    private load;
    [Service.init](): AsyncGenerator<() => Promise<void> | void, void, void>;
    /** The `oss-sync` namespace value, when the settings half serves it. */
    private settings;
    /**
     * Adopt the parameters the namespace resolves to. A poll interval applies
     * immediately; a changed connection or prefix moves this provider to the
     * new location, carrying the document it holds when the target is empty.
     */
    private reconcile;
    /** Move this provider's document home to the parameters the page asked for. */
    private relocate;
    /** Merge this provider's status into the published sync namespace. */
    private report;
    /**
     * Apply one edit to the stored document and commit it under the ETag of the
     * revision the edit saw, retrying against a newer revision when another
     * machine committed in between. An edit that returns `undefined` declines
     * the write, so a `modifyRecord` that leaves its record alone costs no
     * revision and notifies no observer.
     * @param edit - the edit, applied to the revision read inside the exclusive section.
     * @returns the resulting document and whether storage was written.
     */
    private commit;
    /** Read storage once and notify every reference and record another machine changed. */
    private refresh;
    /** Refuse a write while a read-only ambient value shadows the reference. */
    private refuseShadowed;
    /** Queue one exclusive operation behind every earlier one. */
    private enqueue;
}
export default OssCredentialProvider;
