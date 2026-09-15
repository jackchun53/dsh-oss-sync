/**
 * The revision envelope every synced object carries, plus the two pieces of
 * per-machine state a conditional writer needs: a stable device id, and a
 * cache of the last document read so an offline launch still starts from the
 * configuration this machine last saw.
 *
 * @module dsh-oss-sync/envelope
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

/** Wire version this plugin writes and accepts; an unknown version is refused. */
export const ENVELOPE_VERSION = 1

/** File holding this machine's own bucket credentials, never synced. */
const CONNECTION_FILE = 'connection.yaml'

/**
 * The bucket's own credentials, held on the machine that typed them.
 *
 * They are deliberately outside the document: a machine needs them to read the
 * document at all, so putting them in the bucket would be a circle.
 */
export interface StoredConnection {
  /** Access key id for the bucket. */
  accessKeyId?: string
  /** Secret access key for the bucket. */
  secretAccessKey?: string
}

/** One synced document with the facts a concurrent writer needs. */
export interface Envelope<T> {
  /** Wire version. */
  v: number
  /** Monotonic revision, incremented by whichever machine commits. */
  rev: number
  /** Device that committed this revision, so a poll can recognise its own write. */
  writer: string
  /** ISO timestamp of the commit, for humans reading the bucket. */
  updatedAt: string
  /** The document itself. */
  doc: T
}

/**
 * Serialize one envelope as YAML so the bucket stays readable and diffable.
 * @param envelope - the envelope to write.
 * @returns the object text.
 */
export function encodeEnvelope<T>(envelope: Envelope<T>): string {
  return stringifyYaml(envelope, { lineWidth: 0 })
}

/**
 * Parse one object read back into an envelope.
 * @param text - the object text.
 * @returns the parsed envelope.
 * @throws {Error} when the document is not an envelope this plugin understands.
 */
export function parseEnvelope<T>(text: string): Envelope<T> {
  let root: unknown
  try {
    root = parseYaml(text)
  } catch (error) {
    throw new Error(`dsh-oss-sync: stored object is not valid YAML: ${String(error)}`)
  }
  if (typeof root !== 'object' || root === null || Array.isArray(root)) {
    throw new Error('dsh-oss-sync: stored object must be a mapping')
  }
  const candidate = root as Partial<Envelope<T>>
  if (candidate.v !== ENVELOPE_VERSION) {
    throw new Error(`dsh-oss-sync: stored object has version ${String(candidate.v)}, expected ${String(ENVELOPE_VERSION)}`)
  }
  if (typeof candidate.rev !== 'number' || !Number.isInteger(candidate.rev)) {
    throw new Error('dsh-oss-sync: stored object has no integer revision')
  }
  if (typeof candidate.writer !== 'string' || candidate.writer.length === 0) {
    throw new Error('dsh-oss-sync: stored object names no writer')
  }
  if (typeof candidate.doc !== 'object' || candidate.doc === null || Array.isArray(candidate.doc)) {
    throw new Error('dsh-oss-sync: stored object must carry a mapping document')
  }
  return {
    v: ENVELOPE_VERSION,
    rev: candidate.rev,
    writer: candidate.writer,
    updatedAt: typeof candidate.updatedAt === 'string' ? candidate.updatedAt : '',
    doc: candidate.doc,
  }
}

/** Per-machine state under the configured state directory. */
export class SyncState {
  private device: string | undefined

  constructor(private readonly dir: string) {}

  /**
   * Read the connection credentials the settings page saved on this machine.
   *
   * They are the one thing that cannot travel in the document: reading the
   * document needs them. The file stays on this machine at mode 0600 and is
   * never part of what syncs.
   * @returns the stored pair, or `undefined` while this machine holds none.
   */
  async readConnection(): Promise<StoredConnection | undefined> {
    let root: unknown
    try {
      root = parseYaml(await readFile(this.connectionPath(), 'utf8'))
    } catch {
      // Absence, or a file this plugin did not write, is "no local pair": the
      // environment and the SDK chain still apply.
      return undefined
    }
    if (typeof root !== 'object' || root === null || Array.isArray(root)) return undefined
    const candidate = root as StoredConnection
    const text = (field: unknown): string | undefined =>
      typeof field === 'string' && field.length > 0 ? field : undefined
    const connection: StoredConnection = {
      accessKeyId: text(candidate.accessKeyId),
      secretAccessKey: text(candidate.secretAccessKey),
    }
    return connection.accessKeyId === undefined && connection.secretAccessKey === undefined
      ? undefined
      : connection
  }

  /**
   * Replace this machine's copy, or remove the file when the page cleared both.
   * @param connection - the pair to store; omitting one, or both, is a clear.
   */
  async writeConnection(connection: StoredConnection = {}): Promise<void> {
    if (connection.accessKeyId === undefined && connection.secretAccessKey === undefined) {
      await rm(this.connectionPath(), { force: true })
      return
    }
    await mkdir(this.dir, { recursive: true })
    await writeFile(this.connectionPath(), stringifyYaml(connection, { lineWidth: 0 }), {
      encoding: 'utf8', mode: 0o600,
    })
  }

  /** Path of the local connection credentials. */
  private connectionPath(): string {
    return join(this.dir, CONNECTION_FILE)
  }

  /**
   * Read this machine's stable device id, creating it on first use. One
   * machine keeps one id across every profile and restart, so a poll can tell
   * its own committed revision from another machine's.
   * @returns the device id.
   */
  async deviceId(): Promise<string> {
    if (this.device !== undefined) return this.device
    const path = join(this.dir, 'device-id')
    try {
      const existing = (await readFile(path, 'utf8')).trim()
      if (existing.length > 0) {
        this.device = existing
        return existing
      }
    } catch (error) {
      // Absence is the first run; any other failure is a real filesystem problem.
      if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error
    }
    const created = randomUUID()
    await mkdir(this.dir, { recursive: true })
    await writeFile(path, `${created}\n`, { encoding: 'utf8', mode: 0o600 })
    this.device = created
    return created
  }

  /** Whether this machine already imported the file-backed store replaced by one object. */
  async legacyImported(name: string): Promise<boolean> {
    try {
      await readFile(this.legacyMarkerPath(name), 'utf8')
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return false
      throw error
    }
  }

  /** Mark one file-backed store as imported, so later deletes are not resurrected on restart. */
  async markLegacyImported(name: string): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    await writeFile(this.legacyMarkerPath(name), '1\n', { encoding: 'utf8', mode: 0o600 })
  }

  /**
   * Read the cached envelope for one object.
   * @param name - object name inside the prefix (`settings.yaml`).
   * @returns the cached envelope, or `undefined` while none is cached.
   */
  async readCache<T>(name: string): Promise<Envelope<T> | undefined> {
    try {
      return parseEnvelope<T>(await readFile(this.cachePath(name), 'utf8'))
    } catch (error) {
      // Absence is an empty cache; an unreadable or foreign cache is treated
      // the same way, because the cache only ever serves an offline launch.
      return undefined
    }
  }

  /**
   * Replace the cached envelope for one object.
   * @param name - object name inside the prefix.
   * @param envelope - the envelope last read from or written to storage.
   */
  async writeCache<T>(name: string, envelope: Envelope<T>): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    await writeFile(this.cachePath(name), encodeEnvelope(envelope), { encoding: 'utf8', mode: 0o600 })
  }

  /** Cache path for one object; the prefix is already part of the configured directory. */
  private cachePath(name: string): string {
    return join(this.dir, `${name}.cache`)
  }

  /** One-time import marker for the file-backed provider this object replaced. */
  private legacyMarkerPath(name: string): string {
    return join(this.dir, `${name}.legacy-imported`)
  }
}
