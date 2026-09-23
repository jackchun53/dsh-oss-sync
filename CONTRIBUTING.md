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

- **a CLI-profile plugin** — installable from a registry spec, a git remote,
  or a local path, which is what `scripts/install.mjs` uses by default;
- **a Desktop plugin** — installed from the application's Plugins page into
  `$DSH_HOME/profiles/desktop`, which the CLI refuses to touch;
- **a host-plus-browser bundle** — `lib/` and `lib/client.js` are committed and
  the tarball carries them, so no install path ever has to build.

Before publishing, confirm the committed build is not stale:

```sh
pnpm build
git diff --exit-code -- lib    # empty means lib/ matches src/
pnpm test
```

Then boot a real Harness 0.1.7+ profile with the packed tarball installed and
check that no `oss-*` entry reports "did not activate" or "failed to import",
that `settings/describe` answers, and that `oss-settings` is among its entries.

### Versions

0.2.x requires Harness 0.1.7 and later; 0.1.x serves Harness 0.1.5–0.1.6.
Publish 0.2.0 as `latest` only once the Harness release it needs is the one
users run: a 0.1.x Harness that picks up 0.2.0 cannot start the settings sync,
and a 0.1.7 Harness that keeps 0.1.x cannot start its settings pages. A
maintenance fix for old Harness goes out as `0.1.x` under a separate dist-tag
(`pnpm publish --tag harness-0.1.6`).

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

### Manifest properties worth re-checking

- `@deepseek-ai/*` must stay `peerDependencies`. Harness resolves a plugin's
  declared peers from the installation itself, so the plugin runs against the
  host's own `cordis`, `cosmokit`, and `schemastery` — a second copy would give
  the providers a different base class, and volatile references a different
  protocol, than the host checks against. The ranges state the 0.1.7 floor.
- Ordinary dependencies must resolve inside the profile and ship no install
  scripts.
- Nothing may need to build at install time.

`pnpm-workspace.yaml` sets `autoInstallPeers: false` deliberately, for the same
reason: a second `@deepseek-ai/dsh-credentials` next to the plugin would make
the credential provider extend a different base class than the host checks
against.

## The build

```sh
pnpm build       # tsc -p tsconfig.json && tsc -p tsconfig.client.json && node scripts/build-client.mjs
pnpm typecheck   # host half only, no emit
pnpm test        # smoke + card
pnpm clean       # rm -rf lib/
```

Details that are not obvious from the source:

**`lib/client.js` is not an ES module.** The harness's combo route concatenates
several packages into one script, so a top-level `import` in any one of them is
invalid at that position and takes the whole script down. tsc cannot emit that
envelope, so `scripts/build-client.mjs` bundles the client entry with esbuild
and wraps it in `window.__ModuleLoader__.load({ id, factory })`. Externals are
exactly the browser's baseline module table; `require` inside the factory is
that table, which is why nothing is inlined.

**The package root is the settings sync.** The browser module scan resolves a
package's `dsh.client` bundle from a Loader row named by a **bare package
specifier**; a row named `dsh-oss-sync/settings` is permanently not a client
row. Only the credentials row carries a subpath.

**A new import in the browser half has to be a seeded word.** Externals are the
shell's frozen module table (`packages/client/web/src/seed.ts`: React and its
JSX runtime, cordis, the store, and the slots, primitives, and dockkit
packages), and the factory's `require` resolves against exactly that table —
anything else throws at materialization, in the browser, with no build-time
warning. Everything else the section needs arrives as a service: `ctx.slots`
and `ctx.configForms` (from `@deepseek-ai/dsh-client-ui-settings`, which the
manifest's `dsh.client.inject` loads first). `pnpm test:card` fails if a
require ever leaves the table, and `tsconfig.client.json` needs a `paths`
entry per type-only package so the half still type-checks.

**Volatile Config is the page's channel.** `oss-settings` declares every field
the page edits `.volatile()`, which is what puts it in `settings.describe()`
and lets a save reach the running plugin as `loader/volatile-update` without a
remount. `status` is volatile for a different reason: the plugin writes it into
its own running reference (`updateVolatile` from `@deepseek-ai/cosmokit`) so the
describe answer carries it to the page, and emits `settings/document-updated`
for its own entry when something the page shows changes. The Loader resets
that reference whenever the row's raw config changes; the plugin republishes on
the `loader/volatile-update` that follows.

`tsconfig.json` resolves the `@deepseek-ai/*` peer packages through `paths`
into a sibling `deepseek-harness` checkout's built declarations
(`lib/types/*.d.ts`), so that checkout has to be built
(`pnpm install && pnpm run build:lib:host`) before this one compiles. The client
half also type-checks against the harness's client packages, which is why
`tsconfig.client.json` lists `ui-slots`, `ui-primitives`, `ui-settings`,
`ui-plugin-manager`, and `ui-renderer` as well.

`lib/` is what the loader loads: rebuild after every source change, then
restart the profile.

## Tests

`pnpm smoke` drives the settings sync against an in-process fake S3
(`test/fake-s3.mjs`) and a stand-in for the Harness settings service
(`test/fake-settings.mjs`: entries with form fields, user layers, secret slots,
revisions, and the `settings/document-updated` event). It covers the cases that
are easy to get wrong: the first machine seeding an empty bucket without
secrets, expressions, excluded entries, or this plugin's rows; a second machine
adopting the bucket while keeping its own secret and merging an entry only it
held; no echo after an apply or a quiet sync; a local edit uploaded after it
settles and applied on the other machine; a hand edit to the stored document,
with 0.1.x keys mapped to their entries; resets; two machines editing different
entries; `include`; request tokens for pull and push; a connection saved from
the page moving both halves; the one-time 0.1.x migration; a stale revision
refused; and the credential provider's legacy import, resolution, shadowing,
record lifecycle, and poll.

`test/serve-fake-s3.mjs` serves the same fake over HTTP for manual poking — or
for booting a real profile against it with `DSH_SYNC_ENDPOINT` pointed there.

`pnpm test:card` materializes `lib/client.js` the way the shell does — through
`window.__ModuleLoader__`, against a table of the nine seeded words, with a React
stand-in carrying the three hooks the section calls and a `ctx.configForms`
stand-in that, like the Host, never sends a saved secret back — and drives it
from the element records that produces: the page view renders the fields and
controls, the summary view is the one-liner alone, a staged edit marks the
section and a Host-confirmed save clears it, a refused save says so, list
fields save as arrays, an unconfigured or read-only deployment is legible in
place, an empty secret input keeps the saved secret, clearing the pair is
explicit, and the masked field can be revealed and copied. It needs no DOM and
no browser.

## Layout

```
src/            host half; lib/index.js is the settings sync
src/client/     browser half; single file, bundled to lib/client.js
cordis.patch.yml  inserts the settings sync, replaces the credentials row
scripts/        build-client.mjs, install.mjs
test/           fake S3, fake settings service, the smoke checks, the card checks
lib/            committed build output — the published tarball carries it
```
