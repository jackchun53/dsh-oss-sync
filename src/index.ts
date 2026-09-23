/**
 * Package root entry.
 *
 * This is the settings sync, and it is the root rather than a `./settings`
 * subpath on purpose: the browser module scan resolves a package's `dsh.client`
 * bundle from a Loader row named by a bare package specifier, and a row named
 * by a subpath is permanently not a client row. Serving the settings half under
 * the package's own name is what makes the section in `./client` discoverable.
 *
 * @module dsh-oss-sync
 */

export { OssSettingsSync, default } from './settings.js'
export type { Config } from './config.js'
export { DEFAULT_EXCLUDE } from './config.js'
export { SYNC_ENTRY } from './control.js'
