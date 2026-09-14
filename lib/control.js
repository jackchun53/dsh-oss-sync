/**
 * The channel the settings page reads and drives the sync through.
 *
 * The seam already carries live values to the browser: a registered settings
 * namespace re-resolves on every commit and the client mirror forwards it. So
 * the sync reuses that channel instead of adding a second one — one namespace
 * holds the editable connection settings, the runtime status the providers
 * publish, and the action token a card writes to ask for a sync.
 *
 * Status and request are runtime facts: they live in the seam's in-memory
 * document and are stripped before anything reaches the bucket.
 *
 * @module dsh-oss-sync/control
 */
/** The settings namespace carrying configuration, status, and actions. */
export const SYNC_NAMESPACE = 'oss-sync';
/** Runtime facts that never reach storage. */
const RUNTIME_FIELDS = ['status', 'request'];
/**
 * Remove the runtime fields from a namespace section.
 * @param section - the section as the seam holds it.
 * @returns a detached copy carrying only what belongs in the bucket.
 */
export function storedSection(section) {
    const stored = { ...section };
    for (const field of RUNTIME_FIELDS)
        delete stored[field];
    return stored;
}
/**
 * Strip the runtime fields from a whole document before it is written to
 * storage — the seed a provider carries to a new location is the seam's
 * document, which holds the status this process last published.
 * @param document - the document as the seam holds it.
 * @returns a detached copy carrying only what belongs in the bucket.
 */
export function storedDocument(document) {
    const section = document[SYNC_NAMESPACE];
    if (section === undefined)
        return document;
    return { ...document, [SYNC_NAMESPACE]: storedSection(section) };
}
