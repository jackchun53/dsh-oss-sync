# Contributing

Maintainer-facing notes: publishing, and the build details that are not obvious
from the source. User-facing documentation lives in the [README](README.md).

## Publishing

```sh
pnpm build          # prepublishOnly runs this anyway
pnpm publish --access public
```

The package is three things at once, which is why the release has to be
checked by hand rather than by CI alone:

- **a CLI-profile plugin** — installable from a git remote or a local path,
  which is what `scripts/install.mjs` uses by default;
- **a Desktop plugin** — installable **only** from an npm registry spec, since
  the Electron plugin window validates specs with `packageNameFromSpec` and
  rejects anything with a URL scheme or `file:` (see below). A Desktop build
  whose plugin validator compares peer ranges without `includePrerelease`
  rejects this package outright (`requires @deepseek-ai/dsh-credentials@*,
  found 0.1.5-rc.2`), because the application's own host packages are
  prereleases; the fix is in the validator, not in the peer ranges.
- **a host-plus-browser bundle** — `lib/` and `lib/client.js` are committed and
  the tarball carries them, because Desktop installs with `--ignore-scripts`
  and therefore never builds.

Before publishing, confirm the committed build is not stale:

```sh
pnpm build
git diff --exit-code -- lib    # empty means lib/ matches src/
pnpm smoke
pnpm test:patch
```

### 2FA

The registry requires a one-time password for writes. npm's web-auth branch
refuses to run without a TTY:

```js
if (!process.stdin.isTTY || !process.stdout.isTTY) throw err
```

so publishing from a non-interactive shell needs a `--otp=<code>` from an
authenticator, or a wrapper that claims a TTY and lets npm print the authorize
URL and poll the done-URL (`--browser=false` stops it blocking on a readline
prompt for ENTER).

`pnpm publish` and `npm publish` produce slightly different manifests: pnpm
drops `prepublishOnly` and moves `scripts` to the end. Nothing else differs —
in particular both keep the `link:` devDependencies, which consumers never
install.

### Why Desktop can only take a registry spec

The plugin window runs `pnpm add <spec> --save-exact --ignore-scripts` inside
`$DSH_HOME/profiles/desktop`, after validating the spec, so three properties
have to hold and are worth re-checking on any manifest change:

- `@deepseek-ai/*` must stay `peerDependencies` with `*` ranges — that is what
  Desktop requires of host-owned packages, and it avoids shipping a second,
  older copy next to the running host.
- Ordinary dependencies must resolve inside the profile and ship no install
  scripts, so the reviewed-build list needs no entry.
- Nothing may need to build at install time.

The validator gap has a shipped workaround: `scripts/patch-desktop-asar.mjs`
rewrites that one `satisfies` call inside an installed `resources/app.asar`, and
is listed in `files` so it travels with the tarball. Keep it dependency-free and
single-file — it has to run on a machine where nothing from this package is
installed yet, using only whatever Node the application itself brought.

Also `peerDependencies` are not installed automatically here: `pnpm-workspace.yaml`
sets `autoInstallPeers: false` deliberately, so a second `@deepseek-ai/dsh-settings`
cannot end up next to the plugin and make the providers extend a different base
class than the host checks against.

## The build

```sh
pnpm build       # tsc -p tsconfig.json && tsc -p tsconfig.client.json && node scripts/build-client.mjs
pnpm typecheck   # host half only, no emit
pnpm smoke       # fake-S3 end-to-end checks
pnpm clean       # rm -rf lib/
```

Two details are not obvious from the source.

**`lib/client.js` is not an ES module.** The harness's combo route concatenates
several packages into one script, so a top-level `import` in any one of them is
invalid at that position and takes the whole script down. tsc cannot emit that
envelope, so `scripts/build-client.mjs` bundles the client entry with esbuild
and wraps it in `window.__ModuleLoader__.load({ id, factory })`. Externals are
exactly the browser's baseline module table; `require` inside the factory is
that table, which is why nothing is inlined.

**The package root is the settings provider.** The browser module scan resolves
a package's `dsh.client` bundle from a Loader row named by a **bare package
specifier**; a row named `dsh-oss-sync/settings` is permanently not a client
row. Only the credentials row carries a subpath.

`tsconfig.json` resolves the `@deepseek-ai/*` peer packages through `paths`
into a sibling `deepseek-harness` checkout's built declarations
(`lib/types/*.d.ts`), so that checkout has to be built
(`pnpm install && pnpm run build:lib:host`) before this one compiles. Change the
sibling path there, or add real dependencies, before publishing. Note that the
client half also type-checks against the harness's client packages, which is
why `tsconfig.client.json` lists `ui-slots`, `ui-settings`,
`ui-settings-plugins`, and `ui-renderer` as well.

`lib/` is what the loader loads: rebuild after every source change, then restart
the profile. When running the harness from source (`pnpm dsh` from the checkout,
which loads through tsx), a `--patch` overlay pointing straight at
`src/settings.ts` gives a faster loop than a rebuild.

## Tests

`pnpm smoke` drives both providers against an in-process fake S3
(`test/fake-s3.mjs`) and covers the cases that are easy to get wrong:
concurrent stale writers merging into one document, `PreconditionFailedError`
on a stale revision, a cold machine booting from storage, credential
environment shadowing and record lifecycle, the settings namespace exposing
configuration plus live status, a namespace edit moving both documents while
keeping runtime facts out, the `request` token triggering an on-demand sync,
and a poll applying another machine's committed write.

The local-only start has its own cases: a machine boots with no bucket, is
configured from what the page saves, seeds the bucket from what it already
held, and comes back configured after a restart — with both providers moving
together, and with a credential pair typed on the page authenticating a cold
start without ever reaching the bucket.

`test/serve-fake-s3.mjs` serves the same fake over HTTP for manual poking.

`pnpm test:patch` covers `scripts/patch-desktop-asar.mjs` on a synthetic asar
built in memory, so it needs neither a build nor the Desktop application: the
target call gains its argument exactly once, every other entry and offset
survives, the changed entry's integrity is restated while the untouched ones are
left alone, the `.bak` is the original, a second run is a no-op, and a target-free
archive is refused without leaving a backup beside it.

## Layout

```
src/            host half; lib/index.js is the settings provider
src/client/     browser half; single file, bundled to lib/client.js
cordis.patch.yml  disables the two base rows and inserts this plugin's
scripts/        build-client.mjs, install.mjs, patch-desktop-asar.mjs
test/           fake S3, the smoke checks, and the app.asar patcher round trip
lib/            committed build output — the published tarball carries it
```
