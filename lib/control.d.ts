/**
 * The coordination handle between the two halves, and the runtime status the
 * Plugins-page section renders.
 *
 * The settings sync owns the connection — its Config is what the page edits —
 * and provides this handle; the credential provider joins it, follows the
 * connection it reports, and publishes its status through it. Status is a
 * runtime fact: it rides the sync entry's own volatile `status` reference to
 * the page and never reaches the bucket or the profile patch.
 *
 * @module dsh-oss-sync/control
 */
import type { ResolvedConfig } from './config.js';
/** Profile entry id of the settings sync row; the Plugins-page section edits it. */
export declare const SYNC_ENTRY = "oss-settings";
/** Key the 0.1.x settings document used for the connection; retired in 0.2.0. */
export declare const LEGACY_SYNC_NAMESPACE = "oss-sync";
/** Whether a provider's runtime fields are present, or the last failure it hit. */
export interface SyncStatus {
    /** `idle` after a settled operation, `error` after a failed one. */
    state: 'idle' | 'error';
    /**
     * Whether this provider has a bucket to reach. `false` is the local-only
     * start: nothing is read or written, and the first bucket the page saves
     * becomes the remote home.
     */
    configured: boolean;
    /** Revision this provider last read or wrote. */
    revision: number;
    /** Device that committed that revision. */
    writer: string;
    /** Commit time recorded in the envelope. */
    updatedAt: string;
    /** This machine's device id, which is what tells a revision of our own apart. */
    deviceId: string;
    /** Object key this provider reads and writes. */
    objectKey: string;
    /** When this machine last read storage successfully. */
    lastReadAt?: string;
    /** When this machine last committed to storage. */
    lastWriteAt?: string;
    /** The last failure, kept until the next success clears it. */
    lastError?: string;
    /** Profile entries the last settings sync that moved anything applied from the bucket. */
    applied?: string[];
    /** Profile entries the last settings sync that moved anything uploaded to the bucket. */
    uploaded?: string[];
}
/** Per-provider status, keyed by the provider's own label. */
export type SyncStatusMap = Record<string, SyncStatus>;
/** One provider's seat in the sync: what a page request runs on it. */
export interface SyncParticipant {
    /** Adopt the stored revision now, bypassing the poll interval. */
    refresh: () => Promise<void>;
    /** Re-commit this provider's document now. */
    push: () => Promise<void>;
}
/** The verbs a request token may name. */
export type SyncVerb = 'pull' | 'push';
/**
 * Read the verb out of a request token.
 * @param request - the token the page wrote.
 * @returns the verb, defaulting to `pull` for a token that names none.
 */
export declare function requestVerb(request: string): SyncVerb;
/**
 * Coordination between the two halves.
 *
 * The settings sync provides it; the credential provider joins, so one page
 * action refreshes both documents and one saved connection moves both.
 */
export interface SyncControl {
    /**
     * Join the sync under one status label.
     * @param label - key this participant's status occupies in the status map.
     * @param participant - the participant's refresh and push hooks.
     * @returns the disposer removing the participant.
     */
    join: (label: string, participant: SyncParticipant) => () => void;
    /**
     * Merge one participant's status into the published status map.
     * @param label - the participant's status key.
     * @param patch - fields to merge over its last reported status.
     */
    report: (label: string, patch: Partial<SyncStatus>) => void;
    /** @returns the connection the page configured, as the settings sync resolved it. */
    connection: () => ResolvedConfig;
    /**
     * Observe connection changes the page saves.
     * @param listener - invoked after the settings sync adopted a new connection.
     * @returns the disposer removing the listener.
     */
    onConnection: (listener: () => void) => () => void;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        /** Coordination handle the settings sync provides. */
        ossSyncControl: SyncControl;
    }
}
