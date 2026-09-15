/**
 * The revision envelope every synced object carries, plus the two pieces of
 * per-machine state a conditional writer needs: a stable device id, and a
 * cache of the last document read so an offline launch still starts from the
 * configuration this machine last saw.
 *
 * @module dsh-oss-sync/envelope
 */
/** Wire version this plugin writes and accepts; an unknown version is refused. */
export declare const ENVELOPE_VERSION = 1;
/**
 * The bucket's own credentials, held on the machine that typed them.
 *
 * They are deliberately outside the document: a machine needs them to read the
 * document at all, so putting them in the bucket would be a circle.
 */
export interface StoredConnection {
    /** Access key id for the bucket. */
    accessKeyId?: string;
    /** Secret access key for the bucket. */
    secretAccessKey?: string;
}
/** One synced document with the facts a concurrent writer needs. */
export interface Envelope<T> {
    /** Wire version. */
    v: number;
    /** Monotonic revision, incremented by whichever machine commits. */
    rev: number;
    /** Device that committed this revision, so a poll can recognise its own write. */
    writer: string;
    /** ISO timestamp of the commit, for humans reading the bucket. */
    updatedAt: string;
    /** The document itself. */
    doc: T;
}
/**
 * Serialize one envelope as YAML so the bucket stays readable and diffable.
 * @param envelope - the envelope to write.
 * @returns the object text.
 */
export declare function encodeEnvelope<T>(envelope: Envelope<T>): string;
/**
 * Parse one object read back into an envelope.
 * @param text - the object text.
 * @returns the parsed envelope.
 * @throws {Error} when the document is not an envelope this plugin understands.
 */
export declare function parseEnvelope<T>(text: string): Envelope<T>;
/** Per-machine state under the configured state directory. */
export declare class SyncState {
    private readonly dir;
    private device;
    constructor(dir: string);
    /**
     * Read the connection credentials the settings page saved on this machine.
     *
     * They are the one thing that cannot travel in the document: reading the
     * document needs them. The file stays on this machine at mode 0600 and is
     * never part of what syncs.
     * @returns the stored pair, or `undefined` while this machine holds none.
     */
    readConnection(): Promise<StoredConnection | undefined>;
    /**
     * Replace this machine's copy, or remove the file when the page cleared both.
     * @param connection - the pair to store; omitting one, or both, is a clear.
     */
    writeConnection(connection?: StoredConnection): Promise<void>;
    /** Path of the local connection credentials. */
    private connectionPath;
    /**
     * Read this machine's stable device id, creating it on first use. One
     * machine keeps one id across every profile and restart, so a poll can tell
     * its own committed revision from another machine's.
     * @returns the device id.
     */
    deviceId(): Promise<string>;
    /** Whether this machine already imported the file-backed store replaced by one object. */
    legacyImported(name: string): Promise<boolean>;
    /** Mark one file-backed store as imported, so later deletes are not resurrected on restart. */
    markLegacyImported(name: string): Promise<void>;
    /**
     * Read the cached envelope for one object.
     * @param name - object name inside the prefix (`settings.yaml`).
     * @returns the cached envelope, or `undefined` while none is cached.
     */
    readCache<T>(name: string): Promise<Envelope<T> | undefined>;
    /**
     * Replace the cached envelope for one object.
     * @param name - object name inside the prefix.
     * @param envelope - the envelope last read from or written to storage.
     */
    writeCache<T>(name: string, envelope: Envelope<T>): Promise<void>;
    /** Cache path for one object; the prefix is already part of the configured directory. */
    private cachePath;
    /** One-time import marker for the file-backed provider this object replaced. */
    private legacyMarkerPath;
}
