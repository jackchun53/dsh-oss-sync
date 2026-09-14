/**
 * Object access with optimistic concurrency. Every write either replaces the
 * revision the caller read (`If-Match: <etag>`) or creates an absent object
 * (`If-None-Match: *`), so a machine that read a stale document is refused
 * instead of silently overwriting another machine's write.
 *
 * @module dsh-oss-sync/store
 */
import type { ResolvedConfig } from './config.js';
/** Raised when the object moved after the revision the caller read. */
export declare class PreconditionFailedError extends Error {
    constructor(key: string);
}
/** One object read: its text and the ETag a conditional write must present. */
export interface RemoteObject {
    text: string;
    etag: string;
}
/**
 * The precondition a write presents: exactly one of `ifMatch` (replace the
 * object as it was read) or `ifNoneMatch` (create an object that must not
 * exist). A service without conditional-write support cannot honour either,
 * and the plugin refuses to run against one rather than losing writes
 * silently.
 */
export interface WriteCondition {
    ifMatch?: string;
    ifNoneMatch?: boolean;
}
/** One bucket, reached through the S3 API. */
export declare class ObjectStore {
    private readonly config;
    private readonly client;
    /**
     * The SDK's own credential chain, present only when the plugin's variables
     * are unset. It resolves lazily per request, so the first request would
     * otherwise fail with the SDK's own message from inside an unrelated write;
     * {@link ObjectStore.preflight} resolves it once, at load.
     */
    private readonly ambient;
    constructor(config: ResolvedConfig);
    /**
     * Whether a bucket is set. An unconfigured store is never contacted: reads
     * and writes refuse it explicitly so a missing guard fails loudly here
     * rather than as an empty-bucket request.
     */
    get configured(): boolean;
    /**
     * Resolve the ambient credential chain once, so a host with no credentials
     * fails at load with the variables it should set instead of failing inside
     * whichever write reaches storage first.
     * @throws {Error} naming the variables that are missing.
     */
    preflight(): Promise<void>;
    /**
     * Read one object.
     * @param key - object key inside the configured bucket.
     * @returns the text and ETag, or `undefined` while the object does not exist.
     * @throws when the service is unreachable or refuses the request.
     */
    read(key: string): Promise<RemoteObject | undefined>;
    /**
     * Write one object under a precondition.
     * @param key - object key inside the configured bucket.
     * @param text - the object's complete next text.
     * @param condition - the precondition the write presents.
     * @returns the new object's ETag.
     * @throws {PreconditionFailedError} when the service refused the precondition.
     */
    write(key: string, text: string, condition: WriteCondition): Promise<{
        etag: string;
    }>;
    /** Release the HTTP agent held by the SDK client. */
    destroy(): void;
}
