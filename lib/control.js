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
/**
 * The bucket's own credentials: fields that stay on this machine because
 * storage cannot hold the credentials that reading storage needs.
 */
export const LOCAL_CREDENTIAL_FIELDS = ['accessKeyId', 'secretAccessKey'];
/**
 * Fields that stay on this machine: the runtime facts a provider reports, and
 * the bucket's own credentials.
 */
const LOCAL_FIELDS = ['status', 'request', ...LOCAL_CREDENTIAL_FIELDS];
/**
 * Remove the local-only fields from a namespace section.
 * @param section - the section as the seam holds it.
 * @returns a detached copy carrying only what storage should keep.
 */
export function storedSection(section) {
    const stored = { ...section };
    for (const field of LOCAL_FIELDS)
        delete stored[field];
    return stored;
}
/**
 * Read the verb out of a request token.
 * @param request - the token a card wrote.
 * @returns the verb, defaulting to `pull` for a token that names none.
 */
export function requestVerb(request) {
    return request.startsWith('push:') ? 'push' : 'pull';
}
/**
 * Strip the local-only fields from a whole document before it is written to
 * storage — the seed a provider carries to a new location is the seam's
 * document, which holds this process's status.
 * @param document - the document as the seam holds it.
 * @returns a detached copy carrying only what belongs in the bucket.
 */
export function storedDocument(document) {
    const section = document[SYNC_NAMESPACE];
    if (section === undefined)
        return document;
    return { ...document, [SYNC_NAMESPACE]: storedSection(section) };
}
