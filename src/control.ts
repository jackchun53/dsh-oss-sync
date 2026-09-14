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

import type {} from '@deepseek-ai/cordis'

/** The settings namespace carrying configuration, status, and actions. */
export const SYNC_NAMESPACE = 'oss-sync'

/** Whether a provider's runtime fields are present, or the last failure it hit. */
export interface SyncStatus {
  /** `idle` after a settled operation, `error` after a failed one. */
  state: 'idle' | 'error'
  /** Revision this provider last read or wrote. */
  revision: number
  /** Device that committed that revision. */
  writer: string
  /** Commit time recorded in the envelope. */
  updatedAt: string
  /** This machine's device id, which is what tells a revision of our own apart. */
  deviceId: string
  /** Object key this provider reads and writes. */
  objectKey: string
  /** When this machine last read storage successfully. */
  lastReadAt?: string
  /** When this machine last committed to storage. */
  lastWriteAt?: string
  /** The last failure, kept until the next success clears it. */
  lastError?: string
}

/** Per-provider status, keyed by the provider's own label. */
export type SyncStatusMap = Record<string, SyncStatus>

/** Runtime fields carried in the namespace but never stored in the bucket. */
export interface SyncRuntime {
  /** Status each provider last reported. */
  status?: SyncStatusMap
  /** A card's sync request; any change to this value runs every refresher. */
  request?: string
}

/** The editable connection settings, as the settings page sees them. */
export interface SyncSettings extends SyncRuntime {
  /** Bucket holding the documents; defaults to the entry config. */
  bucket?: string
  /** S3-compatible endpoint; defaults to the entry config. */
  endpoint?: string
  /** Signature region; defaults to the entry config. */
  region?: string
  /** Key prefix inside the bucket; changing it moves both documents. */
  prefix?: string
  /** Poll interval in milliseconds. */
  pollMs?: number
  /** Path-style addressing, which self-hosted gateways require. */
  forcePathStyle?: boolean
  /** Environment variable holding the access key id. */
  accessKeyIdEnv?: string
  /** Environment variable holding the secret access key. */
  secretAccessKeyEnv?: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Coordination handle the settings half provides for the sync namespace. */
    ossSyncControl: SyncControl
  }
}

/** Runtime facts that never reach storage. */
const RUNTIME_FIELDS = ['status', 'request'] as const

/**
 * Remove the runtime fields from a namespace section.
 * @param section - the section as the seam holds it.
 * @returns a detached copy carrying only what belongs in the bucket.
 */
export function storedSection(section: Record<string, unknown>): Record<string, unknown> {
  const stored = { ...section }
  for (const field of RUNTIME_FIELDS) delete stored[field]
  return stored
}

/**
 * One provider's seat in the sync: what a card's request runs, and where the
 * provider's status goes.
 */
export interface SyncParticipant {
  /** Run one refresh on request, bypassing the poll interval. */
  refresh: () => Promise<void>
}

/**
 * Coordination between the two providers and the status they publish.
 *
 * The settings provider owns the namespace and provides this service; the
 * credentials provider joins it, so one card action refreshes both without
 * either provider knowing the other exists.
 */
export interface SyncControl {
  /**
   * Join the sync under one status label.
   * @param label - key this participant's status occupies in the namespace.
   * @param participant - the participant's refresh hook.
   * @returns the disposer removing the participant.
   */
  join: (label: string, participant: SyncParticipant) => () => void
  /**
   * Merge one participant's status into the published namespace.
   * @param label - the participant's status key.
   * @param patch - fields to merge over its last reported status.
   */
  report: (label: string, patch: Partial<SyncStatus>) => void
}

/**
 * Strip the runtime fields from a whole document before it is written to
 * storage — the seed a provider carries to a new location is the seam's
 * document, which holds the status this process last published.
 * @param document - the document as the seam holds it.
 * @returns a detached copy carrying only what belongs in the bucket.
 */
export function storedDocument(
  document: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  const section = document[SYNC_NAMESPACE]
  if (section === undefined) return document
  return { ...document, [SYNC_NAMESPACE]: storedSection(section) }
}
