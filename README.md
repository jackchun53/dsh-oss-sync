# dsh-oss-sync

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

# 3. restart, then open Settings → Plugins
```

Every machine that installs the bundle and reads the same bucket then shares
both documents. Setting up a second machine is those same three steps — the
configuration is already in the bucket.

Without a bucket the surfaces still start: the providers run local-only, every
namespace resolves from this machine's own cached document, nothing is read or
written to a service, and the card is where you supply one. Saving a bucket
there seeds it from the document this machine holds, so nothing typed before
the bucket existed is lost.

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
  a plugin could declare survives the next prerelease tuple.
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

| Field | Meaning |
|---|---|
| `bucket`, `endpoint`, `region`, `forcePathStyle`, `accessKeyIdEnv`, `secretAccessKeyEnv` | Connection parameters; the entry config is the base layer, so an unset field keeps what `cordis.yml` and the environment supply. |
| `accessKeyId`, `secretAccessKey` | The bucket's own credentials. Typed here, stored on this machine only (`$DSH_HOME/.dsh-oss-sync/connection.yaml`, mode 0600), never written to the bucket — a bucket cannot hold the credentials that reading it needs. Clearing both removes the local file. |
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
`device-id`, plus a cache of the last document read, which is what lets a
laptop boot offline with the configuration it last saw.

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

- **The settings page card is not verified on screen.** The browser half
  exists, is discovered, is served, and evaluates without error, and the host
  half behind it is covered by the smoke test — but no run has yet confirmed
  the card's rendered layout, so treat that layout as unproven.
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
