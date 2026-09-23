/**
 * An in-process stand-in for Harness 0.1.7's settings service
 * (`@deepseek-ai/dsh-settings`): profile entries with a form schema, a user
 * layer, secret slots, and a revision, served through the same `describe`,
 * `update`, and `replace` surface and the same `settings/document-updated`
 * event. The real service writes the profile's `cordis.patch.yml` through the
 * configuration editor; this one keeps the user layers in memory, which is all
 * the sync reads and writes. The runtime check against a real profile covers
 * the rest.
 */

import { Service } from '@deepseek-ai/cordis'

/** Whether a value is a plain mapping. */
function isMapping(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Deep merge, arrays and scalars replacing, the way `settings.update` merges. */
function merge(under, over) {
  if (!isMapping(under) || !isMapping(over)) return structuredClone(over)
  const result = { ...under }
  for (const [key, value] of Object.entries(over)) result[key] = key in result ? merge(result[key], value) : structuredClone(value)
  return result
}

/** Remove the value at one path from a detached copy. */
function without(value, path) {
  if (!isMapping(value) || path.length === 0) return value
  const [head, ...rest] = path
  if (!(head in value)) return value
  const copy = { ...value }
  if (rest.length === 0) delete copy[head]
  else copy[head] = without(copy[head], rest)
  return copy
}

/** Read the value at one path. */
function at(value, path) {
  return path.reduce((node, key) => (isMapping(node) ? node[key] : undefined), value)
}

/**
 * The fake service. Construct it through `ctx.plugin(FakeSettings, { entries })`
 * with `entries` mapping an entry id to `{ fields, user?, secrets? }`: the
 * form's top-level field names, the starting user layer, and secret paths.
 */
export class FakeSettings extends Service {
  constructor(ctx, config) {
    super(ctx, 'settings')
    this.owner = ctx
    this.entries = new Map(Object.entries(config?.entries ?? {}).map(([ns, entry]) => [ns, {
      fields: entry.fields,
      user: structuredClone(entry.user ?? {}),
      secrets: entry.secrets ?? [],
      revision: 0,
    }]))
    /** Every write, in order, as `{ mode, ns, input }`. */
    this.writes = []
  }

  get writable() { return true }

  describe(options) {
    return [...this.entries].map(([ns, entry]) => {
      let user = structuredClone(entry.user)
      if (options?.redactSecrets) for (const path of entry.secrets) user = without(user, path)
      const dict = Object.fromEntries(entry.fields.map((field, index) => [field, index + 2]))
      return {
        ns,
        autoGenerate: true,
        schema: { uid: 1, refs: { 1: { type: 'object', dict } } },
        value: user,
        user,
        revision: entry.revision,
        applies: 'live',
        ...options?.redactSecrets
          ? { secrets: entry.secrets.map(path => ({ path, set: at(entry.user, path) !== undefined })) }
          : {},
      }
    })
  }

  async update(ns, patch, expectedRevision) {
    this.write('update', ns, patch, expectedRevision, current => merge(current, patch))
  }

  async replace(ns, section, expectedRevision) {
    this.write('replace', ns, section, expectedRevision, () => structuredClone(section))
  }

  write(mode, ns, input, expected, change) {
    const entry = this.entries.get(ns)
    if (entry === undefined) throw new Error(`No configurable plugin entry "${ns}"`)
    if (expected !== undefined && expected !== entry.revision) {
      const error = new Error(`settings namespace "${ns}" changed since it was read`)
      error.code = 'SETTINGS_CONFLICT'
      throw error
    }
    for (const key of Object.keys(input)) {
      if (!entry.fields.includes(key)) throw new Error(`Config field "${key}" is not volatile`)
    }
    entry.user = change(entry.user)
    entry.revision += 1
    this.writes.push({ mode, ns, input: structuredClone(input) })
    this.owner.emit('settings/document-updated', ns, entry.revision)
  }

  /** Test helper: a user edit in this profile, as the page would make it. */
  edit(ns, patch) {
    return this.update(ns, patch)
  }

  /** Test helper: the user layer of one entry, secrets included. */
  user(ns) {
    return structuredClone(this.entries.get(ns)?.user)
  }
}
