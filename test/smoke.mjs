/**
 * End-to-end smoke test against the fake S3 service and a stand-in for the
 * Harness 0.1.7 settings service: settings seeding and adoption across two
 * machines, echo suppression, local and remote edits, secret and expression
 * preservation, legacy document keys, scope, the 0.1.x migration, connection
 * changes from the page, request tokens, conditional-write refusal, and the
 * credential provider's resolution, shadowing, records, and poll.
 *
 * Run with `node test/smoke.mjs` after `pnpm build`.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createVolatile, updateVolatile } from '@deepseek-ai/cosmokit'
import { parse as parseYaml } from 'yaml'
import { startFakeS3 } from './fake-s3.mjs'
import { FakeHmr, FakeSettings } from './fake-settings.mjs'
import OssSettingsSync from '../lib/settings.js'
import OssCredentialProvider from '../lib/credentials.js'
import { ObjectStore, PreconditionFailedError } from '../lib/store.js'
import { resolveConfig } from '../lib/config.js'
import { SyncState, encodeEnvelope } from '../lib/envelope.js'

const service = await startFakeS3()
const root = await mkdtemp(join(tmpdir(), 'dsh-oss-sync-'))
const home = await mkdtemp(join(tmpdir(), 'dsh-oss-sync-home-'))

/** One machine's config: same bucket, its own state directory and device id. */
function machineConfig(stateDir, prefix = 'dsh-sync') {
  return {
    bucket: 'test',
    endpoint: service.url,
    forcePathStyle: true,
    prefix,
    pollMs: 60_000,
    stateDir,
    accessKeyIdEnv: 'SMOKE_ACCESS_KEY_ID',
    secretAccessKeyEnv: 'SMOKE_SECRET_ACCESS_KEY',
  }
}

/**
 * Wait until a condition holds: the sync reacts to settings events after a
 * settle delay, so its effect is never observable on the line that caused it.
 */
async function waitFor(condition, label, ms = 10_000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await condition()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** Let queued work settle when nothing is expected to change. */
function pause(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function boot(Plugin, config) {
  const ctx = new Context()
  const fiber = ctx.plugin(Plugin, config)
  await fiber
  return { ctx, fiber }
}

/** The stored settings envelope under one prefix, parsed. */
function storedSettings(prefix = 'dsh-sync') {
  const text = service.objects.get(`${prefix}/settings.yaml`)
  return text === undefined ? undefined : parseYaml(text)
}

/** Profile entries a typical machine runs, with the form fields they declare. */
function profileEntries(overrides = {}) {
  return {
    'agent-default-model': { fields: ['provider', 'model'] },
    'web-search-deepseek': { fields: ['apiKey', 'apiKeyEnv', 'model'], secrets: [['apiKey']] },
    'ui-settings': { fields: ['developerTools'] },
    'ui-theme': { fields: ['theme'] },
    'pwsh-sandbox': { fields: ['cwd', 'pwshPath'] },
    'oss-settings': { fields: ['bucket', 'prefix'] },
    ...overrides,
  }
}

/**
 * One machine running a profile: the settings stand-in plus the sync, in one
 * context, the way a surface mounts them.
 */
async function machine(name, entries, config = {}) {
  const ctx = new Context()
  const settingsFiber = ctx.plugin(FakeSettings, { entries })
  await settingsFiber
  const fiber = ctx.plugin(OssSettingsSync, { ...machineConfig(join(root, name)), ...config })
  await fiber
  const sync = ctx.ossSyncControl
  const settings = ctx.settings
  const status = () => fiber.config.status.get()?.settings
  // The migration and the first sync run once the start settles.
  await sync.whenStarted
  return {
    ctx, fiber, settings, sync, status,
    /** Change live Config the way the Loader commits a saved page edit. */
    configure(patch) {
      for (const [field, value] of Object.entries(patch)) updateVolatile(fiber.config[field], createVolatile(value))
      ctx.emit('loader/volatile-update', Object.keys(patch).map(field => [field]))
    },
    dispose: async () => {
      await fiber.dispose()
      await settingsFiber.dispose()
    },
  }
}

const cleanups = []
const previousDshHome = process.env['DSH_HOME']
try {
  process.env['DSH_HOME'] = home
  process.env['SMOKE_ACCESS_KEY_ID'] = 'test'
  process.env['SMOKE_SECRET_ACCESS_KEY'] = 'test'

  // Standard S3-compatible services use virtual-hosted addressing. In
  // particular, TOS rejects /bucket/key with InvalidPathAccess.
  const normalized = resolveConfig({ endpoint: 'tos-s3-cn-shanghai.volces.com' })
  assert.equal(normalized.endpoint, 'https://tos-s3-cn-shanghai.volces.com')
  assert.equal(normalized.forcePathStyle, false)
  assert.equal(resolveConfig({ forcePathStyle: true }).forcePathStyle, true)
  console.log('ok  config: endpoints are absolute and virtual-hosted addressing is the default')

  // ── settings: the first machine seeds an empty bucket ─────────────────────
  const a = await machine('a', profileEntries({
    'agent-default-model': { fields: ['provider', 'model'], user: { provider: 'deepseek-official', model: 'deepseek-pro' } },
    'web-search-deepseek': {
      fields: ['apiKey', 'apiKeyEnv', 'model'],
      secrets: [['apiKey']],
      user: { apiKey: 'sk-web-a', apiKeyEnv: { __jsExpr: 'process.env.WEB_KEY_NAME' }, model: 'm1' },
    },
    'pwsh-sandbox': { fields: ['cwd', 'pwshPath'], user: { cwd: 'C:\\machine-a', pwshPath: 'C:\\pwsh.exe' } },
    'oss-settings': { fields: ['bucket', 'prefix'], user: { bucket: 'test' } },
  }))
  cleanups.push(() => a.dispose())
  let stored = storedSettings()
  assert.ok(stored, 'the first machine seeded the empty bucket')
  assert.equal(stored.rev, 1)
  assert.deepEqual(stored.doc['agent-default-model'], { provider: 'deepseek-official', model: 'deepseek-pro' })
  assert.deepEqual(stored.doc['web-search-deepseek'], { model: 'm1' },
    'a secret and a !!js expression stay on the machine')
  assert.ok(!('pwsh-sandbox' in stored.doc), 'an entry holding machine paths is excluded by default')
  assert.ok(!('oss-settings' in stored.doc), 'this plugin\'s own connection is never synced')
  assert.ok(!('ui-theme' in stored.doc), 'an entry with nothing overridden seeds nothing')
  assert.ok(!/sk-web-a|status:|request:/u.test(service.objects.get('dsh-sync/settings.yaml')),
    'no secret and no runtime status reaches the bucket')
  assert.equal(a.status().revision, 1, 'the status names the revision the sync wrote')
  assert.deepEqual(a.status().uploaded, ['agent-default-model', 'web-search-deepseek'])
  console.log('ok  settings: the first machine seeds an empty bucket, without secrets, expressions, or machine paths')

  // ── a second machine: the existing bucket wins, local-only entries merge in ─
  const b = await machine('b', profileEntries({
    'agent-default-model': { fields: ['provider', 'model'], user: { provider: 'other', model: 'other-model' } },
    'web-search-deepseek': { fields: ['apiKey', 'apiKeyEnv', 'model'], secrets: [['apiKey']], user: { apiKey: 'sk-web-b' } },
    'ui-theme': { fields: ['theme'], user: { theme: 'dark' } },
  }))
  cleanups.push(() => b.dispose())
  assert.deepEqual(b.settings.user('agent-default-model'), { provider: 'deepseek-official', model: 'deepseek-pro' },
    'the bucket\'s section wins on a machine syncing for the first time')
  assert.deepEqual(b.settings.user('web-search-deepseek'), { apiKey: 'sk-web-b', model: 'm1' },
    'applying a section keeps this machine\'s own secret')
  stored = storedSettings()
  assert.equal(stored.rev, 2, 'the second machine committed once')
  assert.deepEqual(stored.doc['ui-theme'], { theme: 'dark' }, 'an entry only this machine held is merged into the bucket')
  assert.deepEqual(stored.doc['agent-default-model'], { provider: 'deepseek-official', model: 'deepseek-pro' },
    'the adopted section is not written back')
  assert.deepEqual([...b.status().applied].sort(), ['agent-default-model', 'web-search-deepseek'])
  console.log('ok  settings: a fresh machine adopts the bucket and merges what only it held')

  // ── no echo: a sync with nothing new writes nothing ───────────────────────
  const writesBefore = b.settings.writes.length
  await b.sync.sync()
  await a.sync.sync()
  assert.equal(storedSettings().rev, 2, 'neither machine re-uploads what it just applied or wrote')
  assert.deepEqual(a.settings.user('ui-theme'), { theme: 'dark' }, 'the first machine applied the merged entry')
  await pause(1300)
  await a.sync.sync()
  assert.equal(storedSettings().rev, 2, 'the apply\'s own settings event did not come back as an upload')
  assert.equal(b.settings.writes.length, writesBefore, 'a quiet sync writes nothing into the profile')
  console.log('ok  settings: applying and syncing again is quiet in both directions')

  // ── a local edit reaches the other machine ─────────────────────────────────
  await a.settings.edit('agent-default-model', { model: 'deepseek-flash' })
  await waitFor(() => storedSettings().doc['agent-default-model'].model === 'deepseek-flash',
    'the local edit to reach the bucket')
  assert.equal(storedSettings().rev, 3)
  await b.sync.sync()
  assert.deepEqual(b.settings.user('agent-default-model'), { provider: 'deepseek-official', model: 'deepseek-flash' },
    'the other machine applied the edit on its next sync')
  await pause(1300)
  assert.equal(storedSettings().rev, 3, 'the applied edit was not echoed back')
  console.log('ok  settings: an edit on one machine is uploaded after it settles and applied on the other')

  // ── a hand edit to the stored document applies too, with legacy keys ───────
  const writer = new ObjectStore(resolveConfig(machineConfig(join(root, 'hand'))))
  const current = await writer.read('dsh-sync/settings.yaml')
  const edited = parseYaml(current.text)
  edited.rev += 1
  edited.writer = 'hand-edit'
  edited.doc['ui-theme'] = { theme: 'light' }
  edited.doc['ui-developer-tools'] = { developerTools: true }
  edited.doc['oss-sync'] = { bucket: 'legacy' }
  await writer.write('dsh-sync/settings.yaml', encodeEnvelope(edited), { ifMatch: current.etag })
  writer.destroy()
  await b.sync.sync()
  assert.deepEqual(b.settings.user('ui-theme'), { theme: 'light' }, 'a stored change applies on the next sync')
  assert.deepEqual(b.settings.user('ui-settings'), { developerTools: true },
    'a 0.1.x section key is applied to the entry that owns it now')
  assert.deepEqual(b.settings.user('oss-settings'), {}, 'the 0.1.x connection section is never applied')
  console.log('ok  settings: a stored change applies, with 0.1.x keys mapped to their entries')

  // ── a reset propagates, and an expression survives an apply ────────────────
  await a.sync.sync()
  assert.deepEqual(a.settings.user('ui-theme'), { theme: 'light' })
  await a.settings.replace('ui-theme', {})
  await waitFor(() => JSON.stringify(storedSettings().doc['ui-theme']) === '{}', 'the reset to reach the bucket')
  await b.sync.sync()
  assert.deepEqual(b.settings.user('ui-theme'), {}, 'resetting an entry resets it on the other machine')
  await b.settings.edit('web-search-deepseek', { model: 'm2' })
  await waitFor(() => storedSettings().doc['web-search-deepseek'].model === 'm2', 'the web-search edit to reach the bucket')
  await a.sync.sync()
  assert.deepEqual(a.settings.user('web-search-deepseek'),
    { apiKey: 'sk-web-a', apiKeyEnv: { __jsExpr: 'process.env.WEB_KEY_NAME' }, model: 'm2' },
    'an applied section keeps this machine\'s secret and its !!js expression')
  console.log('ok  settings: resets propagate, and secrets and expressions survive an apply')

  // ── concurrent edits to different entries merge ────────────────────────────
  await a.settings.edit('agent-default-model', { model: 'from-a' })
  await b.settings.edit('ui-theme', { theme: 'from-b' })
  await waitFor(() => {
    const doc = storedSettings().doc
    return doc['agent-default-model'].model === 'from-a' && doc['ui-theme'].theme === 'from-b'
  }, 'both machines\' edits to land')
  console.log('ok  settings: two machines editing different entries both land')

  // ── scope: include narrows the sync ────────────────────────────────────────
  b.configure({ include: ['ui-theme'] })
  await b.settings.edit('agent-default-model', { model: 'b-only' })
  await b.settings.edit('ui-theme', { theme: 'scoped' })
  await waitFor(() => storedSettings().doc['ui-theme'].theme === 'scoped', 'the included entry to sync')
  assert.equal(storedSettings().doc['agent-default-model'].model, 'from-a', 'an entry outside include stays local')
  b.configure({ include: [] })
  console.log('ok  settings: include narrows the sync to the entries it names')

  // ── the request token runs a sync on demand ────────────────────────────────
  const polledBefore = a.status().lastReadAt
  await pause(5)
  a.configure({ request: 'pull:1' })
  await waitFor(() => a.status().lastReadAt !== polledBefore, 'the request token to run a sync')
  console.log('ok  settings: the request token triggers a sync on demand')

  // ── push re-commits this profile over the bucket ───────────────────────────
  await a.settings.update('agent-default-model', { model: 'pushed' })
  a.configure({ request: 'push:2' })
  await waitFor(() => storedSettings().doc['agent-default-model'].model === 'pushed', 'push to commit this profile')
  console.log('ok  settings: push commits this profile\'s sections over the bucket')

  // ── a connection saved on the page moves the sync, and the credentials follow
  const joined = await machine('joined', profileEntries({ 'ui-theme': { fields: ['theme'], user: { theme: 'joined' } } }),
    { bucket: '' })
  cleanups.push(() => joined.dispose())
  const joinedCredentials = joined.ctx.plugin(OssCredentialProvider, { ...machineConfig(join(root, 'joined-creds')), bucket: '' })
  await joinedCredentials
  cleanups.push(() => joinedCredentials.dispose())
  assert.equal(joined.status().configured, false, 'a machine with no bucket starts local-only')
  await joined.ctx.credentials.set('JOINED_KEY', 'sk-joined')
  assert.ok(![...service.objects.keys()].some(key => key.startsWith('joined/')), 'nothing reached a service')
  joined.configure({ bucket: 'test', prefix: 'joined' })
  await waitFor(() => storedSettings('joined') !== undefined, 'the saved bucket to be seeded with the profile')
  assert.deepEqual(storedSettings('joined').doc['ui-theme'], { theme: 'joined' })
  await waitFor(() => service.objects.get('joined/credentials.yaml')?.includes('sk-joined') === true,
    'the credential provider to follow the saved connection')
  const statusMap = joined.fiber.config.status.get()
  assert.equal(statusMap.settings.configured, true, 'the settings status reports the saved bucket')
  assert.equal(statusMap.credentials.objectKey, 'joined/credentials.yaml', 'the credential status rides the same map')
  console.log('ok  connection: saving a bucket moves both halves and seeds the new location')

  // ── the 0.1.x migration: cached connection and settings, once per profile ──
  const migrated = join(root, 'migrated')
  await new SyncState(migrated).writeCache('settings.yaml', {
    v: 1,
    rev: 4,
    writer: 'old-plugin',
    updatedAt: new Date().toISOString(),
    doc: {
      'oss-sync': { bucket: 'test', prefix: 'migrated', status: { settings: {} } },
      'agent-default-model': { model: 'from-cache' },
      'ui-onboarding': { welcomeNoticeVersion: '1' },
    },
  })
  const old = await machine('migrated', profileEntries({
    'oss-settings': { fields: ['bucket', 'prefix', 'region', 'endpoint', 'forcePathStyle', 'pollMs', 'accessKeyIdEnv', 'secretAccessKeyEnv'] },
    'ui-settings-general': { fields: ['welcomeNoticeVersion'] },
  }), { bucket: '', stateDir: migrated })
  cleanups.push(() => old.dispose())
  assert.deepEqual(old.settings.user('oss-settings'), { bucket: 'test', prefix: 'migrated' },
    'the connection a 0.1.x page saved is carried into the profile, runtime fields left behind')
  assert.deepEqual(old.settings.user('agent-default-model'), { model: 'from-cache' },
    'a section only the 0.1.x cache held is imported')
  assert.deepEqual(old.settings.user('ui-settings-general'), { welcomeNoticeVersion: '1' },
    'a 0.1.x section key is imported into the entry that owns it now')
  await old.dispose()
  cleanups.pop()
  const again = await machine('migrated', profileEntries(), { bucket: '', stateDir: migrated })
  cleanups.push(() => again.dispose())
  assert.equal(again.settings.writes.length, 0, 'the migration runs once per profile')
  console.log('ok  migration: a 0.1.x cache seeds the profile once, connection included')

  // ── a stale revision is refused ────────────────────────────────────────────
  const store = new ObjectStore(resolveConfig(machineConfig(join(root, 'probe'))))
  await store.write('dsh-sync/probe.yaml', 'first\n', { ifNoneMatch: true })
  const probe = await store.read('dsh-sync/probe.yaml')
  await store.write('dsh-sync/probe.yaml', 'second\n', { ifMatch: probe.etag })
  await assert.rejects(
    () => store.write('dsh-sync/probe.yaml', 'stale\n', { ifMatch: probe.etag }),
    error => error instanceof PreconditionFailedError,
  )
  assert.equal(service.objects.get('dsh-sync/probe.yaml'), 'second\n', 'the refused write changed nothing')
  store.destroy()
  console.log('ok  store: a stale revision is refused with PreconditionFailedError')

  // ── enabled from the Plugins page, inside an HMR transaction ───────────────
  const seed = new ObjectStore(resolveConfig(machineConfig(join(root, 'hmr-seed'), 'hmr-sync')))
  const seedEnvelope = (rev, theme) => encodeEnvelope({
    v: 1, rev, writer: 'other-machine', updatedAt: new Date().toISOString(), doc: { 'ui-theme': { theme } },
  })
  await seed.write('hmr-sync/settings.yaml', seedEnvelope(1, 'from-bucket'), { ifNoneMatch: true })
  const hmrCtx = new Context()
  await hmrCtx.plugin(FakeHmr)
  const hmrSettings = hmrCtx.plugin(FakeSettings, { entries: profileEntries() })
  await hmrSettings
  let hmrFiber
  // The plugin manager enables a plugin inside `hmr.runExclusive`, so the
  // start, the poll timer, and every promise they chain inherit its flag.
  await hmrCtx.get('hmr').runExclusive(async () => {
    hmrFiber = hmrCtx.plugin(OssSettingsSync, { ...machineConfig(join(root, 'hmr'), 'hmr-sync'), pollMs: 1000 })
    await hmrFiber
  })
  cleanups.push(async () => {
    await hmrFiber.dispose()
    await hmrSettings.dispose()
  })
  await hmrCtx.ossSyncControl.whenStarted
  const hmrStatus = () => hmrFiber.config.status.get()?.settings
  assert.equal(hmrStatus().lastError, undefined, 'the first sync after enabling applies without a nesting error')
  assert.deepEqual(hmrCtx.settings.user('ui-theme'), { theme: 'from-bucket' })
  const seeded = await seed.read('hmr-sync/settings.yaml')
  await seed.write('hmr-sync/settings.yaml', seedEnvelope(2, 'from-poll'), { ifMatch: seeded.etag })
  seed.destroy()
  await waitFor(() => hmrCtx.settings.user('ui-theme')?.theme === 'from-poll' || hmrStatus().lastError !== undefined,
    'the poll started inside the transaction to apply')
  assert.equal(hmrStatus().lastError, undefined, 'a poll tick started inside the transaction applies too')
  assert.deepEqual(hmrCtx.settings.user('ui-theme'), { theme: 'from-poll' })
  console.log('ok  settings: enabled inside an HMR transaction, the sync still writes the profile')

  // ── credentials: first install imports the file store this bundle replaces ─
  await writeFile(join(home, '.credentials.yaml'), [
    'version: 1',
    'refs:',
    '  LEGACY_PROVIDER_KEY: sk-from-old-store',
    'records:',
    '  legacy-owner/grant:',
    '    kind: grant',
    '    payload:',
    '      token: old-record',
    '',
  ].join('\n'))
  const legacyCredentialsDir = join(root, 'legacy-credentials')
  // Reproduce the released 0.1.5 failure exactly: it already created a cache,
  // but that cache contains no model-provider refs from .credentials.yaml.
  await new SyncState(legacyCredentialsDir).writeCache('credentials.yaml', {
    v: 1,
    rev: 1,
    writer: 'early-plugin',
    updatedAt: new Date().toISOString(),
    doc: { refs: {}, records: {} },
  })
  const legacyCredentials = await boot(OssCredentialProvider, { ...machineConfig(legacyCredentialsDir), bucket: '' })
  cleanups.push(() => legacyCredentials.fiber.dispose())
  assert.deepEqual(await legacyCredentials.ctx.credentials.resolve('LEGACY_PROVIDER_KEY'),
    { value: 'sk-from-old-store', source: 'oss' },
    'the model-provider API key in .credentials.yaml is visible after installation')
  assert.deepEqual(await legacyCredentials.ctx.credentials.readRecord('legacy-owner/grant'),
    { kind: 'grant', payload: { token: 'old-record' } },
    'credential records are imported with provider API keys')
  await legacyCredentials.ctx.credentials.unset('LEGACY_PROVIDER_KEY')
  await legacyCredentials.fiber.dispose()
  cleanups.pop()
  const legacyRestart = await boot(OssCredentialProvider, { ...machineConfig(legacyCredentialsDir), bucket: '' })
  cleanups.push(() => legacyRestart.fiber.dispose())
  assert.equal(await legacyRestart.ctx.credentials.resolve('LEGACY_PROVIDER_KEY'), undefined,
    'the one-time marker prevents a deliberately deleted key from being resurrected')
  await rm(join(home, '.credentials.yaml'))
  console.log('ok  migration: existing model-provider API keys survive installation exactly once')

  // ── credentials: values, shadowing, records ────────────────────────────────
  const credentials = await boot(OssCredentialProvider, machineConfig(join(root, 'creds')))
  cleanups.push(() => credentials.fiber.dispose())
  const credentialsService = credentials.ctx.credentials
  const ref = 'MY_GATEWAY_KEY'

  assert.deepEqual(await credentialsService.resolve(ref), undefined, 'an unset reference resolves to nothing')
  await credentialsService.set(ref, 'sk-secret')
  assert.deepEqual(await credentialsService.resolve(ref), { value: 'sk-secret', source: 'oss' })
  assert.deepEqual(await credentialsService.describe(ref), { configured: true, source: 'oss', writable: true })
  assert.match(service.objects.get('dsh-sync/credentials.yaml'), /sk-secret/u, 'the value reached storage')

  process.env[ref] = 'from-env'
  assert.deepEqual(await credentialsService.resolve(ref), { value: 'from-env', source: 'env' },
    'the launching environment shadows the stored value')
  assert.deepEqual(await credentialsService.describe(ref), { configured: true, source: 'env', writable: false })
  await assert.rejects(() => credentialsService.set(ref, 'other'), /launching environment/u)
  delete process.env[ref]

  const key = 'llm-pi-ai/my-gateway'
  assert.deepEqual(await credentialsService.listRecords(), [], 'no records yet')
  await credentialsService.modifyRecord(key, async (current) => {
    assert.equal(current, undefined, 'the mutation sees no record yet')
    return { kind: 'grant', payload: { token: 't1' } }
  })
  const refreshed = await credentialsService.modifyRecord(key, async (current) => {
    assert.deepEqual(current, { kind: 'grant', payload: { token: 't1' } }, 'the mutation sees the stored record')
    return { kind: 'grant', payload: { token: 't2' } }
  })
  assert.deepEqual(refreshed, { kind: 'grant', payload: { token: 't2' } })
  assert.deepEqual(await credentialsService.listRecords(), [{ key, kind: 'grant' }])
  assert.deepEqual(await credentialsService.describeRecord(key), { configured: true, kind: 'grant', writable: true })
  await credentialsService.modifyRecord(key, () => Promise.resolve(undefined))
  assert.deepEqual(await credentialsService.readRecord(key), { kind: 'grant', payload: { token: 't2' } },
    'a declining mutation leaves the record alone')
  await credentialsService.deleteRecord(key)
  assert.deepEqual(await credentialsService.readRecord(key), undefined)
  console.log('ok  credentials: values, environment shadowing, and record lifecycle')

  // ── credentials: another machine's write reaches this one through the poll ─
  const observer = await boot(OssCredentialProvider, { ...machineConfig(join(root, 'creds-b')), pollMs: 1000 })
  cleanups.push(() => observer.fiber.dispose())
  const seen = []
  observer.ctx.on('credentials/reference-updated', value => seen.push(String(value)))
  const credentialWriter = await boot(OssCredentialProvider, machineConfig(join(root, 'creds-a')))
  cleanups.push(() => credentialWriter.fiber.dispose())
  await credentialWriter.ctx.credentials.set('POLLED_KEY', 'from-the-other-machine')
  await waitFor(() => seen.includes('POLLED_KEY'), 'the observer to notify the reference another machine changed')
  assert.deepEqual(await observer.ctx.credentials.resolve('POLLED_KEY'),
    { value: 'from-the-other-machine', source: 'oss' }, 'the polled value is resolvable on this machine')
  console.log('ok  credentials: the poll applies and notifies another machine\'s committed write')
} finally {
  for (const cleanup of cleanups.reverse()) await cleanup()
  await service.stop()
  await rm(root, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
  if (previousDshHome === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = previousDshHome
}
console.log('\nall smoke checks passed')
