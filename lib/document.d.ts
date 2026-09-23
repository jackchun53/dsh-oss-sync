/**
 * The settings document and the per-entry reconciliation between a profile
 * and the bucket.
 *
 * The document maps a profile entry id (`llm-pi-ai`, `agent-default-model`,
 * …) to that entry's form section: the user-layer values of its volatile
 * Config fields as `ctx.settings.describe()` reports them, secrets redacted
 * and `!!js` expressions left out. It is the same namespace-to-section shape
 * the 0.1.x document had, so a bucket written by 0.1.x is read as-is.
 *
 * Reconciliation is three-way per entry, against the baseline recorded at the
 * last sync: an entry this profile changed is uploaded, an entry only the
 * bucket changed is applied, and an entry neither changed is left alone. The
 * baseline is recorded after the apply, so an apply is never read back as a
 * local change and uploaded again.
 *
 * @module dsh-oss-sync/document
 */
/** One settings document: profile entry id to form section. */
export type SettingsDocument = Record<string, Record<string, unknown>>;
/**
 * Keys the 0.1.x document used for sections whose owning entry now carries
 * another id — the same mapping Harness applies when it imports
 * `settings.yaml`.
 */
export declare const LEGACY_ENTRY_ALIASES: Readonly<Record<string, string>>;
/** What one profile's sync last agreed with the bucket on. */
export interface SyncBaseline {
    /** State layout version. */
    v: 1;
    /** The storage location this baseline belongs to (see `locationKey`). */
    location: string;
    /** ETag of the revision last read or written. */
    etag?: string;
    /** Revision number of that ETag. */
    rev: number;
    /** The bucket's sections at the last sync, aliased to entry ids. */
    remote: SettingsDocument;
    /** This profile's sections right after the last sync. */
    local: SettingsDocument;
}
/** The work one reconciliation decided on. */
export interface SyncPlan {
    /** Sections to write into the profile, by entry id. */
    apply: SettingsDocument;
    /** Sections to write into the bucket, by entry id. */
    upload: SettingsDocument;
}
/** Whether a value is a plain mapping rather than a scalar or sequence. */
export declare function isMapping(value: unknown): value is Record<string, unknown>;
/**
 * Whether a raw config node is an unevaluated `!!js` expression. The profile
 * patch keeps expressions whole, and they are this machine's: an expression
 * typically reads the local environment.
 * @param value - one raw config node.
 * @returns whether the node is an expression.
 */
export declare function isExpression(value: unknown): boolean;
/**
 * Detach a section, leaving out every expression node.
 * @param value - the section or one of its nodes.
 * @returns the detached value, or `undefined` for an expression node.
 */
export declare function withoutExpressions(value: unknown): unknown;
/**
 * Every path inside a section that holds an expression node.
 * @param value - the section.
 * @param path - the path walked so far.
 * @returns the expression paths.
 */
export declare function expressionPaths(value: unknown, path?: string[]): string[][];
/**
 * Read the value at one path.
 * @param value - the root.
 * @param path - object keys from the root.
 * @returns the value, or `undefined` when a step is missing.
 */
export declare function getPath(value: unknown, path: readonly string[]): unknown;
/**
 * Write the value at one path, creating intermediate mappings.
 * @param root - the mapping to modify in place.
 * @param path - object keys from the root; must be non-empty.
 * @param value - the value to store.
 */
export declare function setPath(root: Record<string, unknown>, path: readonly string[], value: unknown): void;
/**
 * Whether two sections hold the same values; an absent section equals an
 * empty one, because both mean "nothing overridden".
 * @param left - one section.
 * @param right - the other section.
 * @returns whether they are equal.
 */
export declare function sameSection(left: Record<string, unknown> | undefined, right: Record<string, unknown> | undefined): boolean;
/**
 * Read a stored document as entry-id sections: legacy keys map to their
 * entry id unless the entry id is also present, the 0.1.x connection section
 * is dropped, and non-mapping sections are ignored.
 * @param document - the document as stored.
 * @returns the aliased view.
 */
export declare function aliasDocument(document: Record<string, unknown>): SettingsDocument;
/**
 * Decide, per entry, what moves where.
 *
 * - An entry this profile does not run is left alone in both directions: the
 *   bucket keeps it for the machines that do.
 * - An entry the baseline has not seen (the first sync at this location, or
 *   an entry that just appeared) takes the bucket's section when the bucket
 *   has one and seeds the bucket otherwise — an existing bucket wins on a
 *   fresh machine, and this profile's state seeds an empty one.
 * - Otherwise a local change is uploaded (it is the later write), and a
 *   remote-only change is applied, a removed remote section as a reset.
 * @param local - this profile's sections now.
 * @param remote - the bucket's sections now, aliased.
 * @param baseline - the last sync at this location, when there was one.
 * @param force - `push` uploads every non-empty local section instead.
 * @returns the plan.
 */
export declare function planSync(local: SettingsDocument, remote: SettingsDocument, baseline: SyncBaseline | undefined, force?: 'push'): SyncPlan;
/**
 * Whether an entry id takes part in the sync.
 * @param entry - the profile entry id.
 * @param include - the configured include list; empty includes everything.
 * @param exclude - the configured exclude list.
 * @param own - this plugin's own rows, excluded whatever the lists say.
 * @returns whether the entry is synced.
 */
export declare function isSynced(entry: string, include: readonly string[], exclude: readonly string[], own: readonly string[]): boolean;
