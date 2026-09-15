/**
 * One-time import of the file-backed stores this bundle replaces.
 *
 * Installing the bundle disables `settings.yaml` and `.credentials.yaml`, but
 * those files remain on disk. A first boot must therefore seed the sync cache
 * from them instead of presenting an empty provider and making every model API
 * key appear to have vanished.
 *
 * @module dsh-oss-sync/legacy
 */
import type { CredentialRecord } from '@deepseek-ai/dsh-credentials';
/** Namespace-to-section document used by the file settings provider. */
export type LegacySettingsDocument = Record<string, Record<string, unknown>>;
/** Reference and record maps used by the local credential provider. */
export interface LegacyCredentialDocument {
    refs: Record<string, string>;
    records: Record<string, CredentialRecord>;
}
/**
 * Read the settings document the replaced file provider left behind.
 * @returns the document, or `undefined` when the file does not exist.
 */
export declare function readLegacySettings(): Promise<LegacySettingsDocument | undefined>;
/**
 * Read the credential document the replaced local provider left behind.
 * Version 1 is the current layout; the old prerelease flat map is also
 * recognized so upgrading this bundle never becomes the step that hides it.
 * @returns the document, or `undefined` when the file does not exist.
 */
export declare function readLegacyCredentials(): Promise<LegacyCredentialDocument | undefined>;
