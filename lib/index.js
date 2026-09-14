/**
 * Package root entry.
 *
 * This is the settings provider, and it is the root rather than a `./settings`
 * subpath on purpose: the browser module scan resolves a package's `dsh.client`
 * bundle from a Loader row named by a bare package specifier, and a row named
 * by a subpath is permanently not a client row. Serving the settings half under
 * the package's own name is what makes the card in `./client` discoverable.
 *
 * @module dsh-oss-sync
 */
export { OssSettingsProvider, default } from './settings.js';
export { SYNC_NAMESPACE } from './control.js';
