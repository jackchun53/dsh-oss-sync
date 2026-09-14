/**
 * End-to-end smoke test against the fake S3 service: bootstrap, merge across
 * two machines, conditional-write refusal, credential resolution, and the
 * shadowing rule. Run with `node test/smoke.mjs` after `pnpm build`.
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { startFakeS3 } from './fake-s3.mjs'
import OssSettingsProvider from '../lib/settings.js'
import OssCredentialProvider from '../lib/credentials.js'
import { ObjectStore, PreconditionFailedError } from '../lib/store.js'
import { resolveConfig } from '../lib/config.js'

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

const Schema = z.object({ value: z.number().default(0) })

/**
 * Wait until a condition holds. Watcher invocations run asynchronously after
 * the commit that triggered them, so a provider's reaction to a settings write
 * is never observable on the line that performed it.
 */
async function waitFor(condition, label) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (condition()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function boot(Plugin, config) {
  const ctx = new Context()
  const fiber = ctx.plugin(Plugin, config)
  await fiber
  return { ctx, fiber }
}

const cleanups = []
try {
  process.env['SMOKE_ACCESS_KEY_ID'] = 'test'
  process.env['SMOKE_SECRET_ACCESS_KEY'] = 'test'

  // ── settings: two machines, one document ──────────────────────────────────
  const machineA = join(root, 'a')
  const machineB = join(root, 'b')
  const a = await boot(OssSettingsProvider, machineConfig(machineA))
  const b = await boot(OssSettingsProvider, machineConfig(machineB))
  cleanups.push(() => a.fiber.dispose(), () => b.fiber.dispose())

  // Both machines read the empty bucket before either writes: the second
  // writer holds a stale revision and must still keep the first one's section.
  const alpha = a.ctx.settings.register('alpha', Schema)
  const beta = b.ctx.settings.register('beta', Schema)
  await alpha.update({ value: 1 })
  await beta.update({ value: 2 })

  const stored = service.objects.get('dsh-sync/settings.yaml')
  assert.ok(stored, 'the settings object was written')
  assert.match(stored, /alpha:/u, 'the first machine\'s section survived the second machine\'s write')
  assert.match(stored, /beta:/u, 'the second machine\'s section was written')
  assert.match(stored, /rev: 2/u, 'the revision advanced once per committed write')
  assert.ok(!/status:/u.test(stored), 'the runtime status never reaches the bucket')
  assert.ok(!/request:/u.test(stored), 'a sync request never reaches the bucket')
  console.log('ok  settings: two stale writers merged into one document')

  // A write presenting a stale ETag must be refused, not applied.
  const store = new ObjectStore(resolveConfig(machineConfig(machineA)))
  await store.write('dsh-sync/probe.yaml', 'first\n', { ifNoneMatch: true })
  const current = await store.read('dsh-sync/probe.yaml')
  await store.write('dsh-sync/probe.yaml', 'second\n', { ifMatch: current.etag })
  await assert.rejects(
    () => store.write('dsh-sync/probe.yaml', 'stale\n', { ifMatch: current.etag }),
    error => error instanceof PreconditionFailedError,
  )
  assert.equal(service.objects.get('dsh-sync/probe.yaml'), 'second\n', 'the refused write changed nothing')
  store.destroy()
  console.log('ok  settings: a stale revision is refused with PreconditionFailedError')

  // A fresh machine picks the committed document up on its first poll.
  const machineC = join(root, 'c')
  const c = await boot(OssSettingsProvider, machineConfig(machineC))
  cleanups.push(() => c.fiber.dispose())
  const gamma = c.ctx.settings.register('gamma', Schema)
  assert.equal(gamma.get().value, 0, 'a fresh machine starts from the document it booted with')
  await c.fiber.dispose()
  cleanups.pop()
  console.log('ok  settings: a fresh machine boots from storage')

  // ── credentials: values, shadowing, records ──────────────────────────────
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

  // ── the maintenance namespace: settings, status, and the request token ────
  const panel = await boot(OssSettingsProvider, machineConfig(join(root, 'panel')))
  cleanups.push(() => panel.fiber.dispose())
  const panelSchema = panel.ctx.settings.register('panel-probe', Schema)
  await panelSchema.update({ value: 7 })

  const namespace = panel.ctx.settings.get('oss-sync')
  assert.equal(namespace.bucket, 'test', 'the namespace carries the entry config as its base layer')
  const descriptor = panel.ctx.settings.describe().find(entry => String(entry.ns) === 'oss-sync')
  assert.ok(descriptor, 'the namespace is served to the settings page')
  assert.equal(descriptor.value.status.settings.objectKey, 'dsh-sync/settings.yaml',
    'the provider published its status into the namespace')
  assert.ok(descriptor.value.status.settings.deviceId.length > 0, 'the status names this machine')
  console.log('ok  panel: the sync namespace exposes configuration and live status')

  // A connection parameter written from the page moves the documents and
  // carries the configuration with them.
  await panel.ctx.settings.update('oss-sync', { prefix: 'moved' })
  await waitFor(() => service.objects.has('moved/settings.yaml'), 'the document to move')
  const moved = service.objects.get('moved/settings.yaml')
  assert.ok(moved, 'the document moved to the prefix the page asked for')
  assert.match(moved, /panel-probe:/u, 'the move carried the configuration instead of losing it')
  assert.match(moved, /oss-sync:/u, 'the connection parameters are stored as configuration')
  assert.ok(!/status:/u.test(moved), 'the runtime status never reaches the bucket')
  assert.ok(!/request:/u.test(moved), 'a sync request never reaches the bucket')
  console.log('ok  panel: editing the connection moves both documents and keeps runtime facts out')

  // A request token runs a sync; the poll would take a full interval otherwise.
  const before = panel.ctx.settings.get('oss-sync').status.settings.lastReadAt
  await panel.ctx.settings.update('oss-sync', { request: 'r1' })
  await waitFor(
    () => panel.ctx.settings.get('oss-sync').status.settings.lastReadAt !== before,
    'the request token to run a sync',
  )
  const after = panel.ctx.settings.get('oss-sync').status.settings.lastReadAt
  assert.notEqual(after, before, 'the request token ran a sync')
  console.log('ok  panel: the request token triggers a sync on demand')

  // ── the local-only start: boot, configure from the page, then sync ────────
  const draftDir = join(root, 'draft')
  const draft = await boot(OssSettingsProvider, { ...machineConfig(draftDir), bucket: '' })
  cleanups.push(() => draft.fiber.dispose())
  const draftStatus = () => draft.ctx.settings.get('oss-sync').status.settings
  assert.equal(draftStatus().configured, false, 'a machine with no bucket reports the local-only start')
  assert.equal(draftStatus().state, 'idle', 'starting without a bucket is not an error')

  // The seam is what the page configures the connection through, so it has to
  // work before a connection exists.
  const draftProbe = draft.ctx.settings.register('draft-probe', Schema)
  await draftProbe.update({ value: 11 })
  assert.equal(draftProbe.get().value, 11, 'a namespace resolves with no bucket configured')
  assert.ok(![...service.objects.keys()].some(key => key.startsWith('draft/')), 'nothing reached a service')

  // Saving the bucket from the page is what gives this machine a remote home.
  await draft.ctx.settings.update('oss-sync', { bucket: 'test', prefix: 'draft' })
  await waitFor(() => draftStatus().configured === true, 'the provider to report the bucket the page saved')
  const seeded = service.objects.get('draft/settings.yaml')
  assert.ok(seeded, 'the bucket saved from the page was seeded from this machine')
  assert.match(seeded, /draft-probe:/u, 'the section written before the bucket existed was carried into it')
  assert.match(seeded, /bucket: test/u, 'the connection parameters are stored as configuration')
  console.log('ok  local-only: a machine boots with no bucket, is configured from the page, and seeds it')

  // The bucket the page saved survives a restart, which is what makes the
  // settings page the configuration entry point rather than the environment.
  await draft.fiber.dispose()
  cleanups.pop()
  const restarted = await boot(OssSettingsProvider, { ...machineConfig(draftDir), bucket: '' })
  cleanups.push(() => restarted.fiber.dispose())
  assert.equal(restarted.ctx.settings.get('oss-sync').bucket, 'test',
    'a restart reads the connection parameters back from this machine\'s cache')
  assert.equal(restarted.ctx.settings.get('oss-sync').status.settings.configured, true,
    'the restarted machine reaches the bucket the page saved')
  assert.equal(restarted.ctx.settings.register('draft-probe', Schema).get().value, 11,
    'the cached document survives the restart')
  console.log('ok  local-only: the bucket saved from the page survives a restart')

  // The credential half has the same local-only start: a key pasted before the
  // bucket exists is kept here and seeds the bucket later.
  const localCredentials = await boot(OssCredentialProvider, { ...machineConfig(join(root, 'local-creds')), bucket: '' })
  cleanups.push(() => localCredentials.fiber.dispose())
  await localCredentials.ctx.credentials.set('LOCAL_ONLY_KEY', 'sk-local')
  assert.deepEqual(await localCredentials.ctx.credentials.resolve('LOCAL_ONLY_KEY'), { value: 'sk-local', source: 'oss' },
    'a key pasted before the bucket exists is kept on this machine')
  assert.ok(![...service.objects.keys()].some(key => key.startsWith('dsh-sync/') && key.includes('local-creds')),
    'the local-only credential write reached no service')
  console.log('ok  local-only: credentials accept a value before a bucket exists')

  // ── both halves in one context, which is what a surface mounts ────────────
  const joinedCtx = new Context()
  const joinedSettings = joinedCtx.plugin(OssSettingsProvider, { ...machineConfig(join(root, 'joined')), bucket: '' })
  const joinedCredentials = joinedCtx.plugin(OssCredentialProvider, { ...machineConfig(join(root, 'joined-creds')), bucket: '' })
  await joinedSettings
  await joinedCredentials
  cleanups.push(() => joinedSettings.dispose(), () => joinedCredentials.dispose())
  await joinedCtx.credentials.set('JOINED_KEY', 'sk-joined')
  assert.equal(joinedCtx.settings.get('oss-sync').status.settings.configured, false,
    'both halves start local-only together')
  await joinedCtx.settings.update('oss-sync', { bucket: 'test', prefix: 'joined' })
  await waitFor(() => joinedCtx.settings.get('oss-sync').status.credentials.configured === true,
    'the credential half to follow the settings half')
  assert.match(service.objects.get('joined/credentials.yaml'), /sk-joined/u,
    'the value pasted while local-only was carried to the bucket the page saved')
  assert.match(service.objects.get('joined/settings.yaml'), /oss-sync:/u,
    'the settings document reached the same bucket')
  console.log('ok  local-only: saving a bucket on the page moves both documents at once')

  // ── a pair typed on the page stays on this machine ──────────────────────
  // Deliberately nothing to fall back on: the pair saved from the page is the
  // only thing that can make this machine reach the bucket.
  delete process.env['AWS_ACCESS_KEY_ID']
  delete process.env['AWS_SECRET_ACCESS_KEY']
  delete process.env['AWS_SESSION_TOKEN']
  delete process.env['AWS_PROFILE']
  process.env['AWS_SHARED_CREDENTIALS_FILE'] = join(root, 'absent-credentials')
  process.env['AWS_CONFIG_FILE'] = join(root, 'absent-config')
  const keyedDir = join(root, 'keyed')
  const keyed = await boot(OssSettingsProvider, {
    ...machineConfig(keyedDir),
    bucket: '',
    accessKeyIdEnv: 'KEYED_ACCESS_KEY_ID',
    secretAccessKeyEnv: 'KEYED_SECRET_ACCESS_KEY',
  })
  cleanups.push(() => keyed.fiber.dispose())
  const keyedStatus = () => keyed.ctx.settings.get('oss-sync').status.settings
  const connectionFile = join(keyedDir, 'connection.yaml')
  await keyed.ctx.settings.update('oss-sync', {
    bucket: 'test', prefix: 'keyed', accessKeyId: 'AKIA-LOCAL', secretAccessKey: 'sk-local',
  })
  await waitFor(() => service.objects.has('keyed/settings.yaml'), 'the keyed machine to seed the bucket')
  assert.equal(keyedStatus().state, 'idle', `the saved pair reached the bucket: ${String(keyedStatus().lastError)}`)
  const keyedStored = service.objects.get('keyed/settings.yaml')
  assert.ok(!/accessKeyId|secretAccessKey|sk-local|AKIA-LOCAL/u.test(keyedStored),
    'the bucket credentials never reach the bucket')
  assert.match(readFileSync(connectionFile, 'utf8'), /AKIA-LOCAL/u, 'the pair is kept on this machine')
  console.log('ok  credentials: a pair typed on the page authenticates without reaching the bucket')

  // The stored pair is what a cold start reads, so a machine that never sees
  // the environment still reaches its bucket.
  await keyed.fiber.dispose()
  cleanups.pop()
  const keyedRestart = await boot(OssSettingsProvider, {
    ...machineConfig(keyedDir),
    bucket: '',
    accessKeyIdEnv: 'KEYED_ACCESS_KEY_ID',
    secretAccessKeyEnv: 'KEYED_SECRET_ACCESS_KEY',
  })
  cleanups.push(() => keyedRestart.fiber.dispose())
  const restartedStatus = () => keyedRestart.ctx.settings.get('oss-sync').status.settings
  assert.equal(restartedStatus().configured, true, 'the restart reads the bucket back from its cache')
  await keyedRestart.ctx.settings.update('oss-sync', { request: 'read-now' })
  await waitFor(() => restartedStatus().lastReadAt !== undefined, 'the restarted machine to read the bucket')
  assert.equal(restartedStatus().state, 'idle',
    `the stored pair authenticated the restart: ${String(restartedStatus().lastError)}`)
  console.log('ok  credentials: a restart authenticates from the pair saved on this machine')

  // Emptying both fields deletes the local file, which is the only way back to
  // the environment or the SDK chain.
  await keyedRestart.ctx.settings.update('oss-sync', { accessKeyId: '', secretAccessKey: '' })
  await waitFor(() => !existsSync(connectionFile), 'clearing the pair to remove the local file')
  console.log('ok  credentials: clearing both fields removes the locally saved pair')

  // The card saves field by field, so the bucket commit's relocation can run
  // while no credential is stored yet. That attempt must leave the local-only
  // store in place: swapping to the unreachable one would refuse every later
  // save at its read, and the pair could never arrive.
  const racedDir = join(root, 'raced')
  const raced = await boot(OssSettingsProvider, {
    ...machineConfig(racedDir),
    bucket: '',
    accessKeyIdEnv: 'KEYED_ACCESS_KEY_ID',
    secretAccessKeyEnv: 'KEYED_SECRET_ACCESS_KEY',
  })
  cleanups.push(() => raced.fiber.dispose())
  const racedStatus = () => raced.ctx.settings.get('oss-sync').status.settings
  await raced.ctx.settings.update('oss-sync', { bucket: 'test', prefix: 'raced' })
  await waitFor(() => racedStatus().state === 'error', 'the credential-less relocation to fail')
  assert.equal(racedStatus().configured, false, 'the failed relocation kept the working store')
  await raced.ctx.settings.update('oss-sync', { accessKeyId: 'AKIA-LOCAL' })
  await raced.ctx.settings.update('oss-sync', { secretAccessKey: 'sk-local' })
  await waitFor(() => service.objects.has('raced/settings.yaml'), 'the saved pair to complete the connection')
  assert.equal(racedStatus().state, 'idle', `the saved pair repaired the connection: ${String(racedStatus().lastError)}`)
  console.log('ok  settings: a bucket saved before its credentials still converges')

  // ── the status stamp belongs to one provider ────────────────────────────
  // The page saving a bucket must update this provider's line without making
  // another provider's line claim a connection that half has not made.
  const stamp = await boot(OssSettingsProvider, { ...machineConfig(join(root, 'stamp')), bucket: '' })
  cleanups.push(() => stamp.fiber.dispose())
  stamp.ctx.ossSyncControl.report('ghost', { configured: true })
  const stamped = stamp.ctx.settings.get('oss-sync').status
  assert.equal(stamped.settings.configured, false, 'this provider reports its own store')
  assert.equal(stamped.ghost.configured, true, 'another provider\'s line keeps what it reported')
  console.log('ok  status: `configured` is stamped per provider, not across them')

  // ── another machine's write reaches this one through the poll ────────────
  const observer = await boot(OssCredentialProvider, { ...machineConfig(join(root, 'creds-b')), pollMs: 1000 })
  cleanups.push(() => observer.fiber.dispose())
  const seen = []
  observer.ctx.on('credentials/reference-updated', value => seen.push(String(value)))
  const writer = await boot(OssCredentialProvider, machineConfig(join(root, 'creds-a')))
  cleanups.push(() => writer.fiber.dispose())
  await writer.ctx.credentials.set('POLLED_KEY', 'from-the-other-machine')
  const deadline = Date.now() + 10_000
  while (!seen.includes('POLLED_KEY') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
  assert.ok(seen.includes('POLLED_KEY'), 'the observer notified the reference another machine changed')
  assert.deepEqual(await observer.ctx.credentials.resolve('POLLED_KEY'),
    { value: 'from-the-other-machine', source: 'oss' }, 'the polled value is resolvable on this machine')
  console.log('ok  credentials: the poll applies and notifies another machine\'s committed write')
} finally {
  for (const cleanup of cleanups.reverse()) await cleanup()
  await service.stop()
  await rm(root, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
}
console.log('\nall smoke checks passed')
