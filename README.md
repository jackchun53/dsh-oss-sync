# dsh-oss-sync

English | [中文](README.zh.md)

Keep one machine's DeepSeek Harness settings and API keys in an S3-compatible
bucket, so every other machine boots with the same configuration instead of
having its files copied by hand.

It is an installable plugin bundle that replaces the two stores that make a
machine yours — **user settings** (models, providers, default model) and
**credentials** (API keys) — and puts both in one bucket as readable YAML you
can diff and hand-edit.

Everything above the seam is untouched. The Web **Settings → Models** page
still writes through `ctx.settings`, the model picker still resolves keys
through `ctx.credentials`, and `agent-default-model`, `llm-pi-ai`, and
`llm-deepseek` keep their namespaces. Only the storage moved.

## Quick start

```sh
# 1. install into a profile
dsh plugin --profile web add dsh-oss-sync

# 2. point it at a bucket — either in the environment the surface launches from,
#    or afterwards in Settings → Plugins, which is the same document
export DSH_SYNC_BUCKET=my-dsh
export DSH_SYNC_ENDPOINT=https://oss-cn-shanghai.aliyuncs.com   # omit for AWS
export DSH_SYNC_REGION=cn-shanghai

# 3. restart, then open Settings → Plugins
```

Every machine that installs the bundle and reads the same bucket then shares
both documents. Setting up a second machine is those same three steps — the
configuration is already in the bucket.

Without a bucket the surfaces still start: the providers run local-only, every
namespace resolves from this machine's own cached document, nothing is read or
written to a service, and the card is where you supply one. On the first boot,
`settings.yaml` and `.credentials.yaml` are imported into that cache before the
file-backed rows are retired. Saving a bucket there then seeds it from the
whole document this machine holds, so existing model-provider API keys and
anything typed before the bucket existed are not lost.

## Install

### CLI profiles

`dsh plugin` forwards to pnpm inside `$DSH_HOME/profiles/<name>` and appends
the bundle to the profile's layer list:

```sh
dsh plugin --profile web add dsh-oss-sync
```

Installing by registry spec is enough — the package arrives built. From a git
checkout of this repository you can also let the bundled script work it out:

```sh
pnpm install && pnpm build          # only when running from a checkout
node scripts/install.mjs --profile web --desktop
```

```
  --profile <name>   CLI profile to install into; repeatable (default: web)
  --spec <spec>      package spec; defaults to this checkout, or its git remote
  --dsh <command>    how to invoke dsh; detected from PATH, then a sibling checkout
  --desktop          print the Desktop install steps
  --check            verify the composed layers without changing anything
  --dry-run          print every command without running it
```

Either way the script composes the profile with `--dump-config` and checks that
`dsh-oss-sync/settings` and `dsh-oss-sync/credentials` are the rows in force.
That check matters: a package can install without its layer being composed.

A profile the harness does not ship (`--profile mine`) initializes with
`@deepseek-ai/dsh-base` alone, so it has no Web UI. `web` is the default for
that reason.

### Desktop

`dsh` refuses `--profile desktop` outright — the Electron application owns that
directory and installs plugins through its own plugin window:

```
error: profile "desktop" is managed exclusively by the Electron application
```

That window accepts **npm registry package specs only**. It validates the spec
with `packageNameFromSpec`, rejects anything carrying a URL scheme or `file:`,
and then runs `pnpm add <spec> --save-exact --ignore-scripts` inside the
profile. A `github:` or local-path spec that works for a CLI profile therefore
cannot be installed from Desktop at all.

So install `dsh-oss-sync` (pin the version if the window asks for one) from the
plugin window. Three properties make it fit that validation:

- `@deepseek-ai/*` are `peerDependencies`, which is what Desktop requires of
  host-owned packages, and their `*` ranges satisfy whatever the application
  bundles. That last part needs a validator that compares peer ranges with
  prereleases included: Desktop itself ships prerelease host packages
  (`0.1.5-rc.2`), and plain semver never matches `*` against a prerelease, so
  an older Desktop rejects the install with
  `requires @deepseek-ai/dsh-credentials@*, found 0.1.5-rc.2`. The fix belongs
  in `apps/desktop/src/profile-packages.ts`
  (`satisfies(version, range, { includePrerelease: true })`), because no range
  a plugin could declare survives the next prerelease tuple. Until a build
  carrying it is in hand, patch the installed one — see *Older Desktop builds*
  below.
- Its ordinary dependencies (`@aws-sdk/client-s3`,
  `@aws-sdk/credential-provider-node`, `yaml`) resolve inside the profile and
  ship no install scripts, so the reviewed-build list does not need an entry.
- `--ignore-scripts` means nothing builds on install, which is why `lib/` and
  `lib/client.js` are committed and the published tarball carries them.

Desktop and CLI share `$DSH_HOME`, so both surfaces read the same two synced
documents and the same offline cache.

Desktop needs no environment variable to start: with no bucket the providers
run local-only, the application boots, and `Settings → Plugins` is where the
connection is configured. `setx DSH_SYNC_BUCKET ...` still works, but it is a
bootstrap default, not a precondition. Note that `DSH_*` names cannot come from
a `.env` file — the harness treats the whole prefix as launch-environment-only.

Restart the surface after installing: the providers are mounted at boot.

### Older Desktop builds

The validator gap above is only fixable in the application, so a Desktop build
that predates the fix rejects this package whatever the manifest says.
`scripts/patch-desktop-asar.mjs` writes that one argument into an installed
build instead, which is what makes the plugin installable there:

```sh
# 1. quit the application completely, tray included: app.asar is rewritten in place
# 2. patch the installed build, at the default install directory
node scripts/patch-desktop-asar.mjs --app "%LOCALAPPDATA%\Programs\DeepSeek Harness"

# patched C:\Users\you\AppData\Local\Programs\DeepSeek Harness\resources\app.asar
#   backup:   ...\resources\app.asar.bak
#   files:    /lib/main.js (90953 -> 90982 bytes)
#   size:     2365617 -> 2365646 bytes

# 3. start it again, then install dsh-oss-sync from the plugin window
```

PowerShell spells the variable `$env:LOCALAPPDATA`, and a non-default install
directory is whatever you pointed the installer at. No separate Node install is
needed either way: the application ships one at
`resources\runtime\node\node.exe`, beside the archive being patched, and any
recent Node behaves identically.

The script rides in the published tarball too, at
`$DSH_HOME/profiles/desktop/node_modules/dsh-oss-sync/scripts/patch-desktop-asar.mjs`,
which is the copy to reach for when the application is reinstalled later.

| Invocation | Archive it patches |
|---|---|
| `node scripts/patch-desktop-asar.mjs` | `./resources/app.asar`: the unpacked build the shell is standing in |
| `node scripts/patch-desktop-asar.mjs "<app.asar>"` | that archive |
| `node scripts/patch-desktop-asar.mjs --app "<dir>"` | `<dir>/resources/app.asar` |
| `node scripts/patch-desktop-asar.mjs --help` | nothing; prints the usage above |

Exactly one file changes: `satisfies(dependency.version, range)` becomes
`satisfies(dependency.version, range, { includePrerelease: true })` in the
compiled `lib/main.js`. The asar header's per-file integrity entries are
recomputed for that one file, so the archive stays structurally what
`electron-builder` wrote and the application cannot tell the difference.

The patch is idempotent — an already-patched archive prints `already patched;
nothing to do` and exits — and the `.bak` beside it is written once, on the first
run, so re-running never overwrites the original. It does have to be re-run
after every reinstall or upgrade: `app.asar` is regenerated, and the patch is
not.

This is Windows-only, and only for the unsigned artifacts this project builds.
Rewriting a signed macOS bundle's `app.asar` invalidates its signature and
notarization.

## Configure

### Environment

The providers read their connection from the launching environment on every
surface, so one installed package serves every machine. Every value here is a
bootstrap default: an unset one is simply absent, and the settings card omits
it from storage until you set it there.

| Variable | Meaning |
|---|---|
| `DSH_SYNC_BUCKET` | Bucket holding the documents. Unset starts the providers local-only; set it here or in the settings card. |
| `DSH_SYNC_ENDPOINT` | S3-compatible endpoint (MinIO, Ceph, COS); omit for AWS. |
| `DSH_SYNC_REGION` | Region for the signature; defaults to `us-east-1`. |
| `DSH_SYNC_PREFIX` | Key prefix; defaults to `dsh-sync`. |
| `DSH_SYNC_FORCE_PATH_STYLE` | Set to `true` only for services that require path-style addressing (commonly MinIO). Defaults to virtual-hosted style, which TOS, OSS, and AWS require. |
| `DSH_SYNC_POLL_MS` | Poll interval in milliseconds; defaults to `30000`. |
| `DSH_SYNC_ACCESS_KEY_ID` / `DSH_SYNC_SECRET_ACCESS_KEY` | Static credentials for the bucket; unset falls back to the pair saved in the settings card, then to the SDK's own chain (`AWS_ACCESS_KEY_ID`, a profile, an instance role). |

The pair the card saves wins over the environment, and the environment wins over
the SDK chain. The card's pair is the only one of the three that never leaves
the machine.

### Per-profile overrides

To keep machine-specific values out of the environment, override the two rows
in the profile's own `$DSH_HOME/profiles/<name>/cordis.patch.yml` instead:

```yaml
- id: oss-settings
  config:
    bucket: my-dsh
    endpoint: https://oss-cn-shanghai.aliyuncs.com
- id: oss-credentials
  config:
    bucket: my-dsh
    endpoint: https://oss-cn-shanghai.aliyuncs.com
```

The bucket must support `If-Match` and `If-None-Match` on `PutObject`.
Governance-mode bucket versioning is strongly recommended: it is what turns a
mistaken overwrite into a recoverable revision.

### The settings-page card

The settings page reads and drives the sync through one registered settings
namespace (`oss-sync`), because the seam already carries live values to the
browser: a namespace re-resolves on every commit and the client mirror forwards
it. No second channel was needed.

The card arrives collapsed. `Settings → Plugins` is a list of one row per plugin,
so the header names this one, says what its settings govern, and carries the
state a reader needs without opening it: `仅本机` until a bucket is saved, `只读`
where the deployment is not writable, `等待宿主` before the Host has answered, and
`未保存` while an edit is staged. The fields appear only once the header is
clicked, and a save the Host confirms closes the card again — a rejected one
keeps its diagnostics, and its drafts, in view.

`secretAccessKey` renders masked, and Chromium refuses to cut or copy out of a
masked input — on every platform, by design. So that one field carries the two
controls the platform withholds: **显示 / 隐藏** re-types the same input between
`password` and `text` without touching the value or the staged draft, and
**复制** hands the field's current text to the host clipboard. Copying a secret
never unmasks it on screen.

| Field | Meaning |
|---|---|
| `bucket`, `endpoint`, `region`, `forcePathStyle`, `accessKeyIdEnv`, `secretAccessKeyEnv` | Connection parameters; the entry config is the base layer, so an unset field keeps what `cordis.yml` and the environment supply. An endpoint without a URL scheme is normalized to `https://`. TOS/OSS/AWS use `forcePathStyle: false`; enable it only when a MinIO-compatible service requires it. |
| `accessKeyId`, `secretAccessKey` | The bucket's own OSS/TOS/S3 credentials — **not** a model provider API key. Typed here, stored on this machine only (`$DSH_HOME/.dsh-oss-sync/connection.yaml`, mode 0600), never written to the bucket. Clearing both removes the local file. |
| `prefix` | Key prefix. Changing it moves both documents and seeds the new location from the document this machine holds. |
| `pollMs` | Poll interval; applies immediately. |
| `status` | Runtime, read-only. Per provider (`settings`, `credentials`): revision, writer, commit time, device id, object key, last read/write, last error. |
| `request` | Write any new value to run a sync now, on both providers, without waiting for the interval. |

`status`, `request`, and this machine's credentials are stripped before
anything reaches the bucket, so the stored document holds configuration only.
Changing the connection parameters rebuilds the client and re-reads the new
location at once; the cache under `$DSH_HOME/.dsh-oss-sync/`, and the
`connection.yaml` beside it, are what make that safe when the new location is
unreachable or empty.

## What lands in the bucket

Two objects, `<prefix>/settings.yaml` and `<prefix>/credentials.yaml`, both
readable YAML so you can diff and hand-edit them:

```yaml
v: 1
rev: 12
writer: 6f1c1a1e-…
updatedAt: 2026-09-14T09:12:03.114Z
doc:
  llm-deepseek:
    reasoningEffort: max
  llm-pi-ai:
    providers:
      my-gateway:
        apiKeyEnv: GATEWAY_API_KEY
        baseURL: https://gateway.example/v1
        api: openai-completions
  agent-default-model:
    provider: deepseek-official
    model: deepseek-flash
```

`credentials.yaml` holds `refs` (reference name to secret value) and
`records` (per-plugin credential records, including authorization grants).

Per-machine state stays local under `$DSH_HOME/.dsh-oss-sync/`: a stable
`device-id`, a cache of the last document read, and one-time legacy-import
markers. The original `settings.yaml` and `.credentials.yaml` are left
untouched as recovery copies; the markers prevent a key deliberately deleted
through the sync provider from being resurrected on the next restart.

## Concurrency and propagation

Every write presents the ETag of the revision it read. A refused write
(`412 Precondition Failed`) re-reads the newer document, re-applies the local
change over it, and retries — so:

- Two machines editing **different** namespaces merge; the second sees the
  first's revision and keeps it.
- Two machines editing the **same** namespace: the later write wins wholesale
  for that namespace, which is the same rule the file-backed provider applies
  to one document.
- `modifyRecord` holds the read and the write in one exclusive section in
  process and retries under the ETag across processes, so a token refresh on
  two machines cannot drop one of them.

Reads never wait on storage: resolution is served from the document this
process last read, wrote, or polled. `DSH_SYNC_POLL_MS` is therefore the
propagation window between machines.

## Security — read this before you deploy

The credential document is **plaintext in the bucket**. That is a deliberate
choice for deployments that accept bucket-level protection; it is weaker than
the local store, which at least restricts the file to one OS user.

- Anyone with read access to the bucket, or a leaked access key, holds every
  provider key.
- A misconfigured public bucket exposes them to the internet.
- A leaked access key also lets an attacker *write* your model configuration,
  including a base URL that points at their own gateway.

Mitigations that fit this design without hiding the value from the agent:
private bucket, least-privilege RAM policy scoped to the prefix, SSE-KMS,
short-lived STS credentials on each machine, bucket versioning, and access
logging. If that is not enough, the right change is a credential provider that
encrypts the document under a passphrase-derived key — the seam leaves room
for it, and nothing above the seam changes.

The access key itself must come from the machine's environment, never from a
synced document: it is the bootstrap credential.

## Known limitations

- **A macOS Desktop shell without an Edit menu cannot copy from any text field.**
  macOS delivers ⌘C and ⌘V as menu key equivalents, so an Electron application
  menu built without `role: 'editMenu'` leaves cut, copy, paste, and select-all
  dead across the whole interface — plugin cards included. Windows and Linux are
  unaffected, because Chromium handles the Ctrl equivalents inside the renderer.
  The card's **复制** control goes through `navigator.clipboard` rather than the
  menu, so it is the one route a masked field has until that menu item exists.
- **The settings page card is not verified on screen.** The browser half
  exists, is discovered, is served, and evaluates without error; `pnpm test:card`
  materializes the built bundle against a stubbed module table and asserts the
  card's markup and its disclosure from that; and the host half behind it is
  covered by the smoke test. What none of those cover is CSS: no run has
  confirmed how the card renders in a browser, so treat its layout as unproven.
- **No `.env` fallback.** `dsh-credentials-local` layers the process
  environment, the stored file, `<cwd>/.env`, and `$DSH_HOME/.env`. This
  provider layers the environment and the bucket only. Put values that used to
  live in a `.env` into the store, or keep exporting them.
- **No "Open configuration file" affordance.** The settings page offers that
  button only when the provider names a local document; object storage has
  none, so the button disappears. Editing happens in the page or in the bucket.
- **Deletes propagate, but not conflicts.** A namespace removed by another
  machine disappears from this one on the next poll. Simultaneous conflicting
  edits to one namespace resolve last-writer-wins for that namespace.
- **Offline writes fail.** Reads fall back to the cache; a write with no
  reachable bucket rejects, and the seam keeps the previous value. There is no
  offline queue.
- **One bucket per document pair.** Settings and credentials share a prefix
  and therefore a bucket; point two providers at different buckets only by
  editing the inserted rows.

## How it works

Two rows of the `dsh-base` composition are replaced:

| Base row | Base package | Replaced by |
|---|---|---|
| `settings` | `@deepseek-ai/dsh-settings-file` (`$DSH_HOME/settings.yaml`) | `dsh-oss-sync/settings` |
| `credentials` | `@deepseek-ai/dsh-credentials-local` (`$DSH_HOME/.credentials.yaml`) | `dsh-oss-sync/credentials` |

A loader patch cannot rename a row — its `name` is an assertion the patch must
match — so `cordis.patch.yml` disables both base rows and inserts these two on
their own ids (`oss-settings`, `oss-credentials`).

Two consequences of the harness's own loading rules shape the package layout,
which is why it looks the way it does:

- The package root (`lib/index.js`) is the settings provider rather than a
  subpath entry, because the browser module scan resolves a package's
  `dsh.client` bundle from a Loader row named by a **bare package specifier** —
  a row named `dsh-oss-sync/settings` is permanently not a client row.
- `lib/client.js` is not an ES module. The combo route concatenates several
  packages into one script, so a top-level `import` in any one of them is
  invalid at that position and breaks the whole script. The bundle is a lazy
  CommonJS factory wrapped in `window.__ModuleLoader__.load({ id, factory })`.

## Development

```sh
pnpm install
pnpm build          # tsc → lib/, then esbuild → lib/client.js
pnpm smoke          # fake-S3 end-to-end checks
pnpm test:card      # the browser card, against a stubbed module table
pnpm test:patch     # the app.asar patcher, on a synthetic archive
```

`tsconfig.json` resolves the `@deepseek-ai/*` peer packages through `paths`
into a sibling `deepseek-harness` checkout's built declarations, so that
checkout has to be built before this one compiles.

`lib/` is what the loader loads: rebuild after every source change, then
restart the profile. When running the harness from source (`pnpm dsh` from the
checkout, which loads through tsx), a `--patch` overlay pointing straight at
`src/settings.ts` gives a faster loop than a rebuild.

See [CONTRIBUTING.md](https://github.com/jackchun53/dsh-oss-sync/blob/main/CONTRIBUTING.md)
for publishing and the rest of the maintainer-facing detail.

## License

MIT — see [LICENSE](https://github.com/jackchun53/dsh-oss-sync/blob/main/LICENSE).
