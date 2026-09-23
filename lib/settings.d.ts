/**
 * Settings sync over the Harness 0.1.7 settings service.
 *
 * Harness 0.1.7 has no settings document store to replace: every configurable
 * value is a plugin's volatile Config field, `ctx.settings` projects those
 * fields into forms, and a write lands in the active profile's
 * `cordis.patch.yml` through the configuration editor. So this half no longer
 * sits under the seam. It sits beside it, as a client of the public API:
 *
 * - it reads the profile's form sections with `describe({ redactSecrets })`,
 *   so secrets never leave the machine, and leaves `!!js` expressions out;
 * - it keeps one object in the bucket mapping entry id to section, wrapped in
 *   the revision envelope and written under an ETag precondition;
 * - it applies a section another machine committed with `replace()` fenced by
 *   the entry's describe revision, restoring this profile's own secrets and
 *   expressions into the section first;
 * - it reconciles per entry against the baseline of its last sync, recorded
 *   after every apply, so an applied change is never uploaded back.
 *
 * It also owns the connection: its own Config is what the Plugins-page
 * section edits, and it provides `ossSyncControl`, through which the credential
 * provider follows that connection and reports its status.
 *
 * @module dsh-oss-sync/settings
 */
import type { Context } from '@deepseek-ai/cordis';
import { Service } from '@deepseek-ai/cordis';
import { SyncConfigSchema, type ResolvedConfig } from './config.js';
import { type SyncControl, type SyncParticipant, type SyncStatus } from './control.js';
declare module '@deepseek-ai/cordis' {
    interface Events {
        /** Instance-local notice from the Loader after it committed volatile Config values. */
        'loader/volatile-update'(paths: readonly (readonly string[])[]): void;
    }
}
/** The Config the Loader hands this plugin: volatile references for every live field. */
type SyncConfigInput = ReturnType<typeof SyncConfigSchema>;
/**
 * The settings sync and the connection owner.
 *
 * It needs `ctx.settings` to sync and runs local-only without it; the
 * coordination handle is provided either way, so the credential provider can
 * always follow the connection.
 */
export declare class OssSettingsSync extends Service implements SyncControl {
    private readonly config;
    static Config: import("@deepseek-ai/schemastery").default<Schemastery.ObjectS<NoInfer<{
        stateDir: import("@deepseek-ai/schemastery").default<string, string, "plain">;
        bucket: import("@deepseek-ai/schemastery").default<string, string, "volatile-defined">;
        endpoint: import("@deepseek-ai/schemastery").default<string, string, "volatile">;
        region: import("@deepseek-ai/schemastery").default<string, string, "volatile-defined">;
        prefix: import("@deepseek-ai/schemastery").default<string, string, "volatile-defined">;
        forcePathStyle: import("@deepseek-ai/schemastery").default<boolean, boolean, "volatile-defined">;
        accessKeyIdEnv: import("@deepseek-ai/schemastery").default<string, string, "volatile-defined">;
        secretAccessKeyEnv: import("@deepseek-ai/schemastery").default<string, string, "volatile-defined">;
        pollMs: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
        accessKeyId: import("@deepseek-ai/schemastery").default<string, string, "volatile">;
        secretAccessKey: import("@deepseek-ai/schemastery").default<string, string, "volatile">;
        include: import("@deepseek-ai/schemastery").default<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
        exclude: import("@deepseek-ai/schemastery").default<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
        request: import("@deepseek-ai/schemastery").default<string, string, "volatile">;
        status: import("@deepseek-ai/schemastery").default<any, any, "volatile">;
    }>>, Schemastery.ObjectT<NoInfer<{
        stateDir: import("@deepseek-ai/schemastery").default<string, string, "plain">;
        bucket: import("@deepseek-ai/schemastery").default<string, string, "volatile-defined">;
        endpoint: import("@deepseek-ai/schemastery").default<string, string, "volatile">;
        region: import("@deepseek-ai/schemastery").default<string, string, "volatile-defined">;
        prefix: import("@deepseek-ai/schemastery").default<string, string, "volatile-defined">;
        forcePathStyle: import("@deepseek-ai/schemastery").default<boolean, boolean, "volatile-defined">;
        accessKeyIdEnv: import("@deepseek-ai/schemastery").default<string, string, "volatile-defined">;
        secretAccessKeyEnv: import("@deepseek-ai/schemastery").default<string, string, "volatile-defined">;
        pollMs: import("@deepseek-ai/schemastery").default<number, number, "volatile-defined">;
        accessKeyId: import("@deepseek-ai/schemastery").default<string, string, "volatile">;
        secretAccessKey: import("@deepseek-ai/schemastery").default<string, string, "volatile">;
        include: import("@deepseek-ai/schemastery").default<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
        exclude: import("@deepseek-ai/schemastery").default<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
        request: import("@deepseek-ai/schemastery").default<string, string, "volatile">;
        status: import("@deepseek-ai/schemastery").default<any, any, "volatile">;
    }>>, "plain">;
    /** The plugin's own context: the one its listeners and logs belong to. */
    private readonly owner;
    private readonly state;
    /** The machine-wide bucket pair a 0.1.x install saved, read as a fallback layer. */
    private legacyConnection;
    /** Parameters in force now. */
    private spec;
    /** The store in force; `undefined` while the configured connection cannot be built. */
    private store;
    /** Why the configured connection cannot be built, when it cannot. */
    private storeError;
    private key;
    private readonly poll;
    /** The settings service while it is mounted. */
    private settings;
    /** Set once the migration and the first sync may run: the Loader settled every entry. */
    private started;
    /** The baseline of the last sync at the current location, once read. */
    private baseline;
    private baselineLoaded;
    /** Last request token acted on; the one present at boot counts as handled. */
    private handled;
    private readonly status;
    /** Canonical text of the status last announced to the page, timestamps aside. */
    private announced;
    private readonly participants;
    private readonly connectionListeners;
    private operations;
    private settleTimer;
    private closed;
    /** Settles once the migration and the first sync ran, for callers that must observe them. */
    private startedSignal;
    readonly whenStarted: Promise<void>;
    constructor(ctx: Context, config: SyncConfigInput);
    join(label: string, participant: SyncParticipant): () => void;
    report(label: string, patch: Partial<SyncStatus>): void;
    connection(): ResolvedConfig;
    onConnection(listener: () => void): () => void;
    [Service.init](): AsyncGenerator<() => Promise<void> | void, void, void>;
    /**
     * Begin syncing once the Loader settled every entry: the forms describe only
     * active entries, and Harness imports `settings.yaml` at the same point.
     * @param settings - the settings service this start belongs to.
     */
    private start;
    /**
     * Let Harness's own one-time `settings.yaml` import run first, so the
     * migration below lands over it rather than under it.
     */
    private awaitHarnessImport;
    /** The profile this process runs, as far as it can be told. */
    private profile;
    /** Read a service this plugin does not declare types for. */
    private lookup;
    /** State path of one file belonging to this profile's sync. */
    private profileState;
    /**
     * Carry what a 0.1.x install held only in its own cache into this profile,
     * once per profile: the connection the page saved (when this profile has no
     * bucket yet), and the settings sections of a machine that never had a
     * bucket, whose cache was their only copy.
     * @param settings - the settings service.
     */
    private migrate;
    /** The parameters Config and the machine-wide fallback resolve to now. */
    private desiredSpec;
    /** Retire the machine-wide pair a 0.1.x install saved; the page cleared the pair. */
    private forgetLegacyConnection;
    /**
     * Build the store for one parameter set. A connection that cannot be built —
     * half a credential pair — is a status line, not a failure: the page is
     * where it gets repaired.
     * @param desired - the parameters to adopt.
     */
    private adoptConnection;
    /** Whether a bucket is set and a store could be built for it. */
    private get configured();
    /**
     * Report a bucket this process cannot authenticate against yet.
     * @returns the failure's text, or `undefined` when preflight passed (including local-only).
     */
    private preflight;
    /** Poll only while a bucket is configured. */
    private applyPoll;
    /**
     * React to the Loader committing new volatile values: the page saved a
     * connection, a poll interval, the scope, or a request token.
     * @param paths - the changed Config paths.
     */
    private onVolatileUpdate;
    /**
     * Move to the connection the page saved. A new location starts the sync
     * over there: an existing document wins, and an empty one is seeded.
     * @param plain - the Config values now in force.
     */
    private reconnect;
    /** Tell every participant the connection moved. */
    private notifyConnection;
    /** Run the verb the page asked for on this half and every participant. */
    private runRequested;
    /** Whether one profile entry takes part in the sync under the current scope. */
    private syncs;
    /** Sync after a burst of local edits settles. */
    private schedule;
    /**
     * This profile's synced sections: the user layer of every described entry,
     * secrets redacted and expressions left out. An entry with no user layer
     * contributes an empty section, which is how a reset propagates.
     * @param settings - the settings service.
     * @returns the local document.
     */
    private snapshot;
    /**
     * Write one section another machine committed into this profile.
     *
     * `replace` resets the entry's live fields to what the bundles supply and
     * sets the section over them, so a field the other machine cleared clears
     * here too. The section never carries this profile's secrets or `!!js`
     * expressions, so both are restored into it first; fields this Harness does
     * not declare are dropped rather than refused.
     * @param settings - the settings service.
     * @param entry - the profile entry id.
     * @param section - the section to apply.
     */
    private apply;
    /** Read this profile's baseline once per location. */
    private loadBaseline;
    /** Record what this profile and the bucket agree on now. */
    private saveBaseline;
    /**
     * Reconcile this profile with the bucket once.
     * @param force - `push` re-commits every local section over the bucket's.
     */
    sync(force?: 'push'): Promise<void>;
    /**
     * Publish the status map into this entry's own volatile `status` reference,
     * which `describe()` reads, and tell the page when something it shows moved.
     * The reference is this process's alone: nothing here writes the profile.
     */
    private publishStatus;
    /**
     * Queue one exclusive operation behind every earlier one. Nothing queued
     * here queues again, so a poll can never interleave an apply or an upload.
     */
    private enqueue;
}
export default OssSettingsSync;
