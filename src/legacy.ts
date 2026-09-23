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

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { parseDocument } from 'yaml'
import { resolveDshHome } from './config.js'

/** Reference and record maps used by the local credential provider. */
export interface LegacyCredentialDocument {
  refs: Record<string, string>
  records: Record<string, CredentialRecord>
}

/** Whether a value is a plain mapping rather than a scalar or sequence. */
function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read an optional UTF-8 file; every failure except absence is surfaced. */
async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return undefined
    throw error
  }
}

/** Parse YAML without ever copying a source line (which may contain a secret) into an error. */
function parseYaml(text: string, subject: string): unknown {
  const document = parseDocument(text, { prettyErrors: true, uniqueKeys: true })
  if (document.errors.length > 0) {
    const positions = document.errors.map((error) => {
      const at = error.linePos?.[0]
      return at === undefined ? error.code : `${error.code} at line ${String(at.line)}, column ${String(at.col)}`
    })
    throw new Error(`dsh-oss-sync: cannot import ${subject}: ${positions.join('; ')}`)
  }
  return document.toJS()
}

/** Admit one reference map without quoting any stored value. */
function readRefs(value: unknown, path: string): Record<string, string> {
  if (value === undefined || value === null) return {}
  if (!isMapping(value)) throw new Error(`dsh-oss-sync: cannot import ${path}: "refs" must be a mapping`)
  const refs: Record<string, string> = {}
  for (const [name, secret] of Object.entries(value)) {
    if (typeof secret !== 'string' || secret.length === 0) {
      throw new Error(`dsh-oss-sync: cannot import ${path}: reference "${name}" must hold a non-empty string`)
    }
    refs[name] = secret
  }
  return refs
}

/** Admit the record map at the structural boundary; record owners validate payloads when they read them. */
function readRecords(value: unknown, path: string): Record<string, CredentialRecord> {
  if (value === undefined || value === null) return {}
  if (!isMapping(value)) throw new Error(`dsh-oss-sync: cannot import ${path}: "records" must be a mapping`)
  const records: Record<string, CredentialRecord> = {}
  for (const [key, record] of Object.entries(value)) {
    if (!isMapping(record) || (record['kind'] !== 'api-key' && record['kind'] !== 'grant')) {
      throw new Error(`dsh-oss-sync: cannot import ${path}: record "${key}" has an unsupported shape`)
    }
    records[key] = structuredClone(record) as unknown as CredentialRecord
  }
  return records
}

/**
 * Read the credential document the replaced local provider left behind.
 * Version 1 is the current layout; the old prerelease flat map is also
 * recognized so upgrading this bundle never becomes the step that hides it.
 * @returns the document, or `undefined` when the file does not exist.
 */
export async function readLegacyCredentials(): Promise<LegacyCredentialDocument | undefined> {
  const path = join(resolveDshHome(), '.credentials.yaml')
  const text = await readOptional(path)
  if (text === undefined) return undefined
  const root = parseYaml(text, path) ?? {}
  if (!isMapping(root)) throw new Error(`dsh-oss-sync: cannot import ${path}: root must be a mapping`)
  const keys = Object.keys(root)
  if (keys.length === 0) return { refs: {}, records: {} }
  if (!('version' in root)) return { refs: readRefs(root, path), records: {} }
  if (root['version'] !== 1) {
    throw new Error(`dsh-oss-sync: cannot import ${path}: unsupported document version`)
  }
  for (const key of keys) {
    if (key !== 'version' && key !== 'refs' && key !== 'records') {
      throw new Error(`dsh-oss-sync: cannot import ${path}: unknown top-level key "${key}"`)
    }
  }
  return { refs: readRefs(root['refs'], path), records: readRecords(root['records'], path) }
}
