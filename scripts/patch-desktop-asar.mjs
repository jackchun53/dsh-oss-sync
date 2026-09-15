#!/usr/bin/env node
/**
 * Make an installed DeepSeek Harness Desktop app accept plugin peer ranges that
 * are declared against prerelease host packages.
 *
 * This is the workaround for the validator gap the README's Desktop section
 * describes. The application checks every enabled plugin's `peerDependencies`
 * with `satisfies(version, range)` from semver, and semver never matches a
 * prerelease version (the app ships `0.1.5-rc.2`) against a range such as `*`.
 * A plugin declaring the host packages the way Desktop requires therefore fails
 * to install, and once enabled it makes startup fail with
 * "plugin tree failed to load" — so no range a plugin could declare is safe,
 * and the fix has to land in the application's compiled validator.
 *
 * Exactly one argument in the compiled `lib/main.js` inside
 * `resources/app.asar` changes:
 *
 *     satisfies(dependency.version, range)
 *   becomes
 *     satisfies(dependency.version, range, { includePrerelease: true })
 *
 * The archive is rewritten in place, with a `.bak` copy beside it. The asar
 * header keeps its own per-file integrity entries, recomputed for the file that
 * changed, so the result is structurally identical to the original.
 *
 * Needs Node, and nothing else. Desktop already ships one, so a machine with
 * the application on it needs no separate install:
 *
 *   node scripts/patch-desktop-asar.mjs "<path to resources/app.asar>"
 *   node scripts/patch-desktop-asar.mjs --app "<path to the unpacked app directory>"
 *   node scripts/patch-desktop-asar.mjs          # ./resources/app.asar, the cwd's app
 */

import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'

const FROM = 'satisfies(dependency.version, range)'
const TO = 'satisfies(dependency.version, range, { includePrerelease: true })'

const USAGE = `Patch an installed Desktop app to accept prerelease host packages.

  node scripts/patch-desktop-asar.mjs [options] [<path to app.asar>]

  --app <dir>        the unpacked application directory, whose resources/app.asar
                     is patched; the installed app is
                     %LOCALAPPDATA%\\Programs\\DeepSeek Harness, or wherever you
                     pointed the installer
  -h, --help         show this message

  With no path, ./resources/app.asar is patched, which is what running this from
  an unpacked build directory does.
`

/**
 * Resolve the app.asar to patch from the command line.
 * @param argv - arguments after the script path.
 * @returns the archive to patch.
 */
function archivePath(argv) {
  const flag = argv.indexOf('--app')
  if (flag !== -1) {
    const app = argv[flag + 1]
    if (app === undefined) throw new Error('--app needs a directory')
    const candidate = join(resolve(app), 'resources', 'app.asar')
    if (!existsSync(candidate)) throw new Error(`no app.asar under ${app}`)
    return candidate
  }
  const given = argv.find(argument => !argument.startsWith('-'))
  if (given !== undefined) return resolve(given)
  const candidate = resolve('resources', 'app.asar')
  if (existsSync(candidate)) return candidate
  throw new Error('usage: node scripts/patch-desktop-asar.mjs "<path to resources/app.asar>"')
}

/** Round a length up to the next 4-byte boundary, the pickle layout's padding. */
function pad4(length) {
  return length + ((4 - (length % 4)) % 4)
}

/**
 * Read an asar archive: its header object, and the byte range holding file data.
 * @param buffer - the whole archive.
 * @returns the header and where its file data begins.
 */
function readArchive(buffer) {
  if (buffer.readUInt32LE(0) !== 4) throw new Error('not an asar archive: unexpected prefix')
  const headerBufferLength = buffer.readUInt32LE(4)
  const payloadLength = buffer.readUInt32LE(8)
  const jsonLength = buffer.readUInt32LE(12)
  if (headerBufferLength !== payloadLength + 4) throw new Error('not an asar archive: inconsistent header sizes')
  const header = JSON.parse(buffer.subarray(16, 16 + jsonLength).toString('utf8'))
  const dataStart = 8 + headerBufferLength
  if (pad4(jsonLength) + 16 !== dataStart) throw new Error('not an asar archive: unexpected header padding')
  return { header, dataStart }
}

/**
 * Visit every packed file in the archive, depth first.
 * @param node - the directory node to walk.
 * @param prefix - the archive path of that node.
 * @param visit - called with each file's archive path and its header entry.
 */
function eachFile(node, prefix, visit) {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const path = `${prefix}/${name}`
    if (entry.files !== undefined) eachFile(entry, path, visit)
    else visit(path, entry)
  }
}

/**
 * SHA-256 integrity as electron-builder writes it: one hash per 4 MiB block.
 * @param buffer - the file's bytes.
 * @returns the integrity entry for that file.
 */
function integrityOf(buffer) {
  const blockSize = 4194304
  const blocks = []
  for (let offset = 0; offset < buffer.length; offset += blockSize) {
    blocks.push(createHash('sha256').update(buffer.subarray(offset, offset + blockSize)).digest('hex'))
  }
  return { algorithm: 'SHA256', hash: blocks[0] ?? createHash('sha256').update(buffer).digest('hex'), blockSize, blocks }
}

/**
 * Rewrite one archive with `files` replaced, keeping every other entry byte-identical.
 * @param source - the original archive bytes.
 * @param replacements - archive path (leading slash) to its new bytes.
 * @returns the new archive bytes.
 */
function writeArchive(source, replacements) {
  const { header, dataStart } = readArchive(source)
  const packed = []
  eachFile(header, '', (path, entry) => {
    if (entry.unpacked === true) return
    packed.push({ path, entry, offset: Number(entry.offset), size: entry.size })
  })
  packed.sort((left, right) => left.offset - right.offset)
  const chunks = []
  let offset = 0
  for (const file of packed) {
    const original = source.subarray(dataStart + file.offset, dataStart + file.offset + file.size)
    const bytes = replacements.get(file.path) ?? original
    file.entry.offset = String(offset)
    file.entry.size = bytes.length
    file.entry.integrity = integrityOf(bytes)
    chunks.push(bytes)
    offset += bytes.length
  }
  const json = Buffer.from(JSON.stringify(header), 'utf8')
  const padding = pad4(json.length) - json.length
  const prefix = Buffer.alloc(16)
  prefix.writeUInt32LE(4, 0)
  prefix.writeUInt32LE(4 + 4 + pad4(json.length), 4)
  prefix.writeUInt32LE(4 + pad4(json.length), 8)
  prefix.writeUInt32LE(json.length, 12)
  return Buffer.concat([prefix, json, Buffer.alloc(padding), ...chunks])
}

function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE)
    return
  }
  const path = archivePath(argv)
  const source = readFileSync(path)
  if (source.includes(TO)) {
    console.log(`${path}\n  already patched; nothing to do`)
    return
  }
  const occurrences = source.toString('latin1').split(FROM).length - 1
  if (occurrences !== 1) {
    throw new Error(`expected exactly one "${FROM}" in ${path}, found ${occurrences}`)
  }
  const { header, dataStart } = readArchive(source)
  const replacements = new Map()
  const patched = []
  eachFile(header, '', (filePath, entry) => {
    if (entry.unpacked === true) return
    const bytes = source.subarray(dataStart + Number(entry.offset), dataStart + Number(entry.offset) + entry.size)
    const text = bytes.toString('utf8')
    if (!text.includes(FROM)) return
    const next = Buffer.from(text.replace(FROM, TO), 'utf8')
    replacements.set(filePath, next)
    patched.push(`${filePath} (${String(entry.size)} -> ${String(next.length)} bytes)`)
  })
  const written = writeArchive(source, replacements)
  const backup = `${path}.bak`
  if (!existsSync(backup)) copyFileSync(path, backup)
  const mode = statSync(path).mode
  writeFileSync(path, written, { mode })
  console.log([
    `patched ${path}`,
    `  backup:   ${backup}`,
    `  files:    ${patched.join(', ')}`,
    `  size:     ${String(source.length)} -> ${String(written.length)} bytes`,
    '',
    'Close the application before patching if it is running, then start it again.',
  ].join('\n'))
}

try {
  main()
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
