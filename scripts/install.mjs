#!/usr/bin/env node
/**
 * Install dsh-oss-sync into the profiles this machine boots.
 *
 * Web (and every other CLI profile) is installed by invoking `dsh plugin`,
 * which forwards to pnpm inside the profile directory. Desktop is not: the
 * `dsh` CLI refuses `--profile desktop` outright — the Electron application
 * owns that profile and installs plugins through its own window — so this
 * script prints the exact spec to install there instead of touching it.
 *
 * Cross-platform by construction: it is Node, and every dsh host already has
 * Node. Run it from anywhere:
 *
 *   node scripts/install.mjs --profile web --desktop
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE_NAME = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8')).name

/** Profile the web UI boots from, and the one this plugin's card lives behind. */
const DEFAULT_PROFILES = ['web']

/** Environment variables the providers read; the script reports which are in force. */
const BUCKET_ENV = 'DSH_SYNC_BUCKET'
const OPTIONAL_ENV = [
  'DSH_SYNC_ENDPOINT',
  'DSH_SYNC_REGION',
  'DSH_SYNC_PREFIX',
  'DSH_SYNC_POLL_MS',
  'DSH_SYNC_ACCESS_KEY_ID',
  'DSH_SYNC_SECRET_ACCESS_KEY',
]

/**
 * Parse the command line.
 * @param argv - arguments after the script path.
 * @returns the requested profiles, package spec, launcher, and modes.
 */
function parseArgs(argv) {
  const options = {
    profiles: [],
    spec: undefined,
    dsh: undefined,
    desktop: false,
    check: false,
    dryRun: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--profile') {
      const value = argv[index += 1]
      if (value === undefined) throw new Error('--profile needs a name')
      options.profiles.push(value)
    } else if (arg === '--spec') {
      const value = argv[index += 1]
      if (value === undefined) throw new Error('--spec needs a package spec')
      options.spec = value
    } else if (arg === '--dsh') {
      const value = argv[index += 1]
      if (value === undefined) throw new Error('--dsh needs a command')
      options.dsh = value
    } else if (arg === '--desktop') options.desktop = true
    else if (arg === '--check') options.check = true
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`unknown argument "${arg}"`)
  }
  if (options.profiles.length === 0) options.profiles = [...DEFAULT_PROFILES]
  if (options.profiles.includes('desktop')) {
    throw new Error('profile "desktop" is owned by the Desktop application; pass --desktop to print its steps instead')
  }
  return options
}

const USAGE = `Install ${PACKAGE_NAME} into dsh profiles.

  node scripts/install.mjs [options]

  --profile <name>   CLI profile to install into; repeatable (default: web)
  --spec <spec>      package spec to install; defaults to this checkout, or its
                     git remote when it has one
  --dsh <command>    how to invoke dsh; detected by default
  --desktop          also print the Desktop application's install steps
  --check            verify the installed layers without changing anything
  --dry-run          print every command without running it
  -h, --help         show this message
`

/**
 * Whether a command exists on PATH.
 * @param command - the executable name.
 * @returns whether the platform's lookup succeeds.
 */
function onPath(command) {
  const finder = process.platform === 'win32' ? 'where' : 'which'
  const result = spawnSync(finder, [command], { stdio: 'ignore', shell: false })
  return result.status === 0
}

/**
 * Decide how to run dsh: an explicit command, an installed CLI, or a sibling
 * source checkout (which the harness develops against).
 * @param explicit - the `--dsh` value, when given.
 * @returns the command's argv prefix and the directory to run it in.
 */
function resolveLauncher(explicit) {
  if (explicit !== undefined) return { argv: explicit.split(' '), cwd: PACKAGE_DIR }
  if (onPath('dsh')) return { argv: ['dsh'], cwd: PACKAGE_DIR }
  const checkout = resolve(PACKAGE_DIR, '..', 'deepseek-harness')
  if (existsSync(join(checkout, 'apps', 'cli', 'src', 'bin.ts'))) {
    return { argv: ['pnpm', 'dsh'], cwd: checkout }
  }
  throw new Error('no dsh launcher found: install the dsh CLI, or pass --dsh "<command>"')
}

/**
 * The package spec to install: an explicit one, this checkout's git remote, or
 * the checkout itself.
 * @param explicit - the `--spec` value, when given.
 * @returns the spec to hand to `dsh plugin add`.
 */
function resolveSpec(explicit) {
  if (explicit !== undefined) return explicit
  try {
    const remote = execFileSync('git', ['-C', PACKAGE_DIR, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    const match = /github\.com[:/](?<owner>[^/]+)\/(?<repo>[^/.]+)(?:\.git)?$/u.exec(remote)
    if (match?.groups !== undefined) return `github:${match.groups.owner}/${match.groups.repo}`
  } catch {
    // Not a git checkout, or no remote: fall through to the local directory.
  }
  return PACKAGE_DIR
}

/**
 * Run one command, or print it in dry-run mode.
 * @param launcher - the dsh argv prefix and working directory.
 * @param args - arguments after the prefix.
 * @param options - dry-run flag and whether output is captured.
 * @returns the command's stdout, or an empty string when it was not run.
 */
function run(launcher, args, options) {
  const line = [...launcher.argv, ...args].join(' ')
  if (options.dryRun) {
    console.log(`  $ ${line}`)
    return ''
  }
  const result = spawnSync(launcher.argv[0], [...launcher.argv.slice(1), ...args], {
    cwd: launcher.cwd,
    encoding: 'utf8',
    stdio: options.capture === true ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.status !== 0) {
    const detail = options.capture === true ? (result.stderr ?? '').trim() : ''
    throw new Error(`command failed (${String(result.status)}): ${line}${detail.length === 0 ? '' : `\n${detail}`}`)
  }
  return result.stdout ?? ''
}

/**
 * Whether the composed profile carries this plugin's two rows.
 * @param launcher - the dsh argv prefix and working directory.
 * @param profile - the profile to inspect.
 * @param options - dry-run flag.
 * @returns whether both inserted rows are present.
 */
function verify(launcher, profile, options) {
  const dump = run(launcher, ['--profile', profile, '--dump-config'], { ...options, capture: true })
  // The settings sync row is named by the bare package specifier (the browser
  // module scan needs that); only the credentials row carries a subpath.
  return dump.includes(`name: ${PACKAGE_NAME}
`) && dump.includes(`${PACKAGE_NAME}/credentials`)
}

/** Report the environment the providers read. */
function reportEnvironment() {
  const bucket = (process.env[BUCKET_ENV] ?? '').length > 0
  const set = OPTIONAL_ENV.filter(name => (process.env[name] ?? '').length > 0)
  console.log('\nEnvironment (read at launch, by every machine):')
  console.log(`  ${BUCKET_ENV}=<bucket>${bucket ? '' : '   (not set: both halves start local-only; set it here or on Plugins → dsh-oss-sync)'}`)
  console.log(`  DSH_SYNC_ENDPOINT / DSH_SYNC_REGION / DSH_SYNC_PREFIX / DSH_SYNC_POLL_MS, or the Plugins-page section${set.length === 0 ? '' : `   (already set: ${set.join(', ')})`}`)
  console.log('  DSH_SYNC_ACCESS_KEY_ID / DSH_SYNC_SECRET_ACCESS_KEY, or the AWS SDK chain')
}

/** Print what the Desktop application needs, since the CLI cannot touch its profile. */
function reportDesktop(spec) {
  console.log('\nDesktop application:')
  console.log('  The CLI refuses `--profile desktop`; Electron owns that profile and')
  console.log('  installs plugins through its own window. Open the plugin manager and')
  console.log('  install this spec:')
  console.log(`\n    ${spec}\n`)
  console.log('  lib/ is committed, so the package arrives built: no build script, and')
  console.log('  therefore no allowBuilds approval step.')
  console.log('  Desktop and CLI profiles each keep their own settings (Harness 0.1.7 stores')
  console.log('  them in the profile); both sync with the same bucket document, and share')
  console.log('  the credential cache under $DSH_HOME.')
  console.log('\n  This version needs Harness 0.1.7 or later; use dsh-oss-sync@0.1 before that.')
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help === true) {
    console.log(USAGE)
    return
  }
  const launcher = resolveLauncher(options.dsh)
  const spec = resolveSpec(options.spec)
  console.log(`package: ${PACKAGE_NAME}\nspec:    ${spec}\ndsh:     ${launcher.argv.join(' ')}\n`)

  let failed = false
  for (const profile of options.profiles) {
    console.log(`Profile "${profile}":`)
    try {
      if (options.check) {
        console.log('  checking the composed layers')
      } else {
        run(launcher, ['plugin', '--profile', profile, 'add', spec], options)
      }
      // The layer list lives in the profile manifest; --dump-config is what
      // proves the patch applied, not that the package was merely installed.
      const present = verify(launcher, profile, options)
      console.log(present
        ? '  ok: the settings sync is mounted and the credentials row is replaced by this plugin'
        : '  ! the plugin layer is not composed into this profile')
      if (!present && options.dryRun !== true) failed = true
    } catch (error) {
      failed = true
      console.log(`  ! ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  if (options.desktop) reportDesktop(spec)
  reportEnvironment()
  console.log('\nRestart the surface after installing: the providers are mounted at boot.')
  if (failed) process.exitCode = 1
}

try {
  main()
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
