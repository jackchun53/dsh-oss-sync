/**
 * One-time import of the file-backed credential store this bundle replaces.
 *
 * Installing the bundle disables `.credentials.yaml`, but the file remains on
 * disk. A first boot must therefore seed the credential cache from it instead
 * of presenting an empty provider and making every model API key appear to
 * have vanished.
 *
 * `$DSH_HOME/settings.yaml` is not read here any more: Harness 0.1.7 imports
 * it into the active profile itself and renames it `settings.yaml.imported`.
 *
 * @module dsh-oss-sync/legacy
 */
import type { CredentialRecord } from '@deepseek-ai/dsh-credentials';
/** Reference and record maps used by the local credential provider. */
export interface LegacyCredentialDocument {
    refs: Record<string, string>;
    records: Record<string, CredentialRecord>;
}
/**
 * Read the credential document the replaced local provider left behind.
 * Version 1 is the current layout; the old prerelease flat map is also
 * recognized so upgrading this bundle never becomes the step that hides it.
 * @returns the document, or `undefined` when the file does not exist.
 */
export declare function readLegacyCredentials(): Promise<LegacyCredentialDocument | undefined>;
