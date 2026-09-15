/**
 * Round-trip check for `scripts/patch-desktop-asar.mjs`, on a synthetic archive
 * rather than a real build: the target call gains its argument exactly once,
 * every other entry survives byte for byte, the header stays self-consistent,
 * and a second run is a no-op. Run with `node test/patch-asar.mjs`. It needs no
 * build, no network, and no fixture on disk.
 */

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(PACKAGE_DIR, 'scripts', 'patch-desktop-asar.mjs')
const FROM = 'satisfies(dependency.version, range)'
const TO = 'satisfies(dependency.version, range, { includePrerelease: true })'

/** Round a length up to the 4-byte boundary the asar pickle layout pads to. */
function pad4(length) {
  return length + ((4 - (length % 4)) % 4)
}

/** electron-builder's per-file integrity: one SHA-256 per 4 MiB block. */
function integrityOf(buffer) {
  const blockSize = 4194304
  const blocks = []
  for (let offset = 0; offset < buffer.length; offset += blockSize) {
    blocks.push(createHash('sha256').update(buffer.subarray(offset, offset + blockSize)).digest('hex'))
  }
  return { algorithm: 'SHA256', hash: blocks[0] ?? createHash('sha256').update(buffer).digest('hex'), blockSize, blocks }
}

/**
 * Assemble an asar the way electron-builder lays one out, so the patcher can be
 * exercised without a 2 MB build to hand.
 * @param files - archive path (leading slash) to that file's bytes.
 * @returns the archive.
 */
function buildArchive(files) {
  const paths = [...files.keys()].sort()
  const header = { files: {} }
  let offset = 0
  for (const path of paths) {
    const bytes = files.get(path)
    const parts = path.split('/').filter(part => part.length > 0)
    let node = header
    for (const part of parts.slice(0, -1)) {
      node.files[part] ??= { files: {} }
      node = node.files[part]
    }
    node.files[parts.at(-1)] = { size: bytes.length, offset: String(offset), integrity: integrityOf(bytes) }
    offset += bytes.length
  }
  const json = Buffer.from(JSON.stringify(header), 'utf8')
  const prefix = Buffer.alloc(16)
  prefix.writeUInt32LE(4, 0)
  prefix.writeUInt32LE(4 + 4 + pad4(json.length), 4)
  prefix.writeUInt32LE(4 + pad4(json.length), 8)
  prefix.writeUInt32LE(json.length, 12)
  const data = paths.map(path => files.get(path))
  return Buffer.concat([prefix, json, Buffer.alloc(pad4(json.length) - json.length), ...data])
}

/**
 * Read an archive the way the application does, asserting the header invariants
 * a hand-built archive is most likely to get wrong.
 * @param archive - the whole archive.
 * @returns the header object and where its file data begins.
 */
function openArchive(archive) {
  assert.equal(archive.readUInt32LE(0), 4, 'prefix should be 4')
  const headerBufferLength = archive.readUInt32LE(4)
  const jsonLength = archive.readUInt32LE(12)
  assert.equal(headerBufferLength, archive.readUInt32LE(8) + 4, 'header sizes should be consistent')
  const dataStart = 8 + headerBufferLength
  assert.equal(pad4(jsonLength) + 16, dataStart, 'header padding should be exactly pad4')
  const header = JSON.parse(archive.subarray(16, 16 + jsonLength).toString('utf8'))
  return { header, dataStart }
}

/**
 * Extract one entry's header node.
 * @param archive - the whole archive.
 * @param path - archive path, with a leading slash.
 * @returns the header node for that file.
 */
function entryOf(archive, path) {
  const { header } = openArchive(archive)
  let node = header
  for (const part of path.split('/').filter(part => part.length > 0)) {
    node = node.files[part]
    assert.ok(node !== undefined, `${path} should be present`)
  }
  return node
}

/**
 * Extract one packed file.
 * @param archive - the whole archive.
 * @param path - archive path, with a leading slash.
 * @returns that file's bytes.
 */
function fileOf(archive, path) {
  const { dataStart } = openArchive(archive)
  const entry = entryOf(archive, path)
  const start = dataStart + Number(entry.offset)
  return archive.subarray(start, start + entry.size)
}

const root = mkdtempSync(join(tmpdir(), 'dsh-oss-sync-asar-'))
try {
  // A stand-in for the unpacked application: --app resolves <dir>/resources/app.asar.
  const app = join(root, 'app')
  const resources = join(app, 'resources')
  mkdirSync(resources, { recursive: true })

  const original = buildArchive(new Map([
    ['/lib/main.js', Buffer.from(`const accepts = ${FROM}\n`)],
    ['/lib/other.js', Buffer.from('// untouched, and offsets around it must not shift\n')],
    ['/package.json', Buffer.from('{"name":"fixture"}\n')],
  ]))
  const asar = join(resources, 'app.asar')
  writeFileSync(asar, original)

  const first = execFileSync(process.execPath, [SCRIPT, '--app', app], { encoding: 'utf8' })
  assert.match(first, /patched /, 'the first run should report a patch')

  const patched = readFileSync(asar)
  const main = fileOf(patched, '/lib/main.js').toString('utf8')
  assert.ok(main.includes(TO), 'the call should gain includePrerelease')
  assert.equal(patched.length, original.length + (TO.length - FROM.length), 'only the argument should be added')
  assert.equal(fileOf(patched, '/lib/other.js').toString('utf8'), '// untouched, and offsets around it must not shift\n')
  assert.equal(fileOf(patched, '/package.json').toString('utf8'), '{"name":"fixture"}\n')

  // The header is what makes the application trust the archive, so the changed
  // entry has to be restated and the untouched ones left alone.
  assert.deepEqual(entryOf(patched, '/lib/main.js').integrity, integrityOf(fileOf(patched, '/lib/main.js')))
  assert.deepEqual(entryOf(patched, '/lib/other.js').integrity, entryOf(original, '/lib/other.js').integrity)
  assert.equal(entryOf(patched, '/lib/main.js').offset, entryOf(original, '/lib/main.js').offset, 'a longer file should still start where it did')

  // The backup is the original, byte for byte, and is written once.
  assert.deepEqual(readFileSync(`${asar}.bak`), original)

  const second = execFileSync(process.execPath, [SCRIPT, asar], { encoding: 'utf8' })
  assert.match(second, /already patched/, 'a second run should do nothing')
  assert.deepEqual(readFileSync(asar), patched, 'the second run should not rewrite the archive')
  assert.deepEqual(readFileSync(`${asar}.bak`), original, 'the second run should not overwrite the backup')

  // An archive with no such call is refused rather than rewritten, and refused
  // before anything is written beside it.
  const clean = join(root, 'clean.asar')
  writeFileSync(clean, buildArchive(new Map([['/lib/main.js', Buffer.from('const accepts = true\n')]])))
  const refused = spawnSync(process.execPath, [SCRIPT, clean], { encoding: 'utf8' })
  assert.equal(refused.status, 1, 'a target-free archive should fail')
  assert.match(refused.stderr, /expected exactly one/, 'and say why')
  assert.ok(!existsSync(`${clean}.bak`), 'a refused patch should leave no backup')

  console.log('patch-desktop-asar: synthetic asar round trip ok')
} finally {
  rmSync(root, { recursive: true, force: true })
}
