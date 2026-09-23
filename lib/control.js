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
/** Profile entry id of the settings sync row; the Plugins-page section edits it. */
export const SYNC_ENTRY = 'oss-settings';
/** Key the 0.1.x settings document used for the connection; retired in 0.2.0. */
export const LEGACY_SYNC_NAMESPACE = 'oss-sync';
/**
 * Read the verb out of a request token.
 * @param request - the token the page wrote.
 * @returns the verb, defaulting to `pull` for a token that names none.
 */
export function requestVerb(request) {
    return request.startsWith('push:') ? 'push' : 'pull';
}
