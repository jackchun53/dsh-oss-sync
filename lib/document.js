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
import { LEGACY_SYNC_NAMESPACE } from './control.js';
/**
 * Keys the 0.1.x document used for sections whose owning entry now carries
 * another id — the same mapping Harness applies when it imports
 * `settings.yaml`.
 */
export const LEGACY_ENTRY_ALIASES = {
    'ui-developer-tools': 'ui-settings',
    'ui-onboarding': 'ui-settings-general',
};
/** Whether a value is a plain mapping rather than a scalar or sequence. */
export function isMapping(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/**
 * Whether a raw config node is an unevaluated `!!js` expression. The profile
 * patch keeps expressions whole, and they are this machine's: an expression
 * typically reads the local environment.
 * @param value - one raw config node.
 * @returns whether the node is an expression.
 */
export function isExpression(value) {
    return isMapping(value) && Object.keys(value).length === 1 && typeof value['__jsExpr'] === 'string';
}
/**
 * Detach a section, leaving out every expression node.
 * @param value - the section or one of its nodes.
 * @returns the detached value, or `undefined` for an expression node.
 */
export function withoutExpressions(value) {
    if (isExpression(value))
        return undefined;
    if (Array.isArray(value))
        return value.map(item => withoutExpressions(item) ?? null);
    if (!isMapping(value))
        return value;
    const result = {};
    for (const [key, child] of Object.entries(value)) {
        const next = withoutExpressions(child);
        if (next !== undefined)
            result[key] = next;
    }
    return result;
}
/**
 * Every path inside a section that holds an expression node.
 * @param value - the section.
 * @param path - the path walked so far.
 * @returns the expression paths.
 */
export function expressionPaths(value, path = []) {
    if (isExpression(value))
        return [path];
    if (!isMapping(value))
        return [];
    return Object.entries(value).flatMap(([key, child]) => expressionPaths(child, [...path, key]));
}
/**
 * Read the value at one path.
 * @param value - the root.
 * @param path - object keys from the root.
 * @returns the value, or `undefined` when a step is missing.
 */
export function getPath(value, path) {
    let node = value;
    for (const key of path) {
        if (!isMapping(node) || !Object.hasOwn(node, key))
            return undefined;
        node = node[key];
    }
    return node;
}
/**
 * Write the value at one path, creating intermediate mappings.
 * @param root - the mapping to modify in place.
 * @param path - object keys from the root; must be non-empty.
 * @param value - the value to store.
 */
export function setPath(root, path, value) {
    let node = root;
    for (const key of path.slice(0, -1)) {
        const next = node[key];
        if (!isMapping(next))
            node[key] = {};
        node = node[key];
    }
    const last = path.at(-1);
    if (last !== undefined)
        node[last] = value;
}
/**
 * Serialize with sorted keys, so two sections compare by content only.
 * @param value - plain data.
 * @returns the canonical text.
 */
function canonical(value) {
    if (Array.isArray(value))
        return `[${value.map(canonical).join(',')}]`;
    if (isMapping(value)) {
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
}
/**
 * Whether two sections hold the same values; an absent section equals an
 * empty one, because both mean "nothing overridden".
 * @param left - one section.
 * @param right - the other section.
 * @returns whether they are equal.
 */
export function sameSection(left, right) {
    return canonical(left ?? {}) === canonical(right ?? {});
}
/**
 * Read a stored document as entry-id sections: legacy keys map to their
 * entry id unless the entry id is also present, the 0.1.x connection section
 * is dropped, and non-mapping sections are ignored.
 * @param document - the document as stored.
 * @returns the aliased view.
 */
export function aliasDocument(document) {
    const view = {};
    for (const [key, section] of Object.entries(document)) {
        if (key === LEGACY_SYNC_NAMESPACE || !isMapping(section))
            continue;
        const alias = LEGACY_ENTRY_ALIASES[key];
        if (alias !== undefined) {
            if (!Object.hasOwn(document, alias))
                view[alias] = section;
            continue;
        }
        view[key] = section;
    }
    return view;
}
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
export function planSync(local, remote, baseline, force) {
    const plan = { apply: {}, upload: {} };
    for (const [entry, section] of Object.entries(local)) {
        const stored = remote[entry];
        if (force === 'push') {
            if (!sameSection(section, stored) && (Object.keys(section).length > 0 || stored !== undefined)) {
                plan.upload[entry] = section;
            }
            continue;
        }
        const known = baseline !== undefined && Object.hasOwn(baseline.local, entry);
        if (!known) {
            if (stored !== undefined) {
                if (!sameSection(section, stored))
                    plan.apply[entry] = stored;
            }
            else if (Object.keys(section).length > 0) {
                plan.upload[entry] = section;
            }
            continue;
        }
        const localChanged = !sameSection(section, baseline.local[entry]);
        const remoteChanged = !sameSection(stored, baseline.remote[entry]);
        if (localChanged) {
            if (!sameSection(section, stored))
                plan.upload[entry] = section;
        }
        else if (remoteChanged && !sameSection(section, stored)) {
            plan.apply[entry] = stored ?? {};
        }
    }
    return plan;
}
/**
 * Whether an entry id takes part in the sync.
 * @param entry - the profile entry id.
 * @param include - the configured include list; empty includes everything.
 * @param exclude - the configured exclude list.
 * @param own - this plugin's own rows, excluded whatever the lists say.
 * @returns whether the entry is synced.
 */
export function isSynced(entry, include, exclude, own) {
    if (own.includes(entry))
        return false;
    if (include.length > 0)
        return include.includes(entry);
    return !exclude.includes(entry);
}
