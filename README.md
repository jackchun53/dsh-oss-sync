# dsh-oss-sync

English | [中文](README.zh.md)

Keep one machine's DeepSeek Harness settings and API keys in an S3-compatible
bucket, so every other machine boots with the same configuration instead of
having its files copied by hand.

It is an installable plugin bundle with two halves:

- **Settings sync.** A client of the Harness settings service
  (`ctx.settings`). It mirrors this profile's settings — models, providers,
  default model, and every other value the settings pages edit — into one
  readable YAML document in the bucket, and applies what other machines
  committed there.
- **Credentials store.** It replaces the store that holds your API keys
  (`$DSH_HOME/.credentials.yaml`) with a second document in the same bucket.

Everything above those seams is untouched. The Web **Settings → Models** page
still writes through `ctx.settings`, the model picker still resolves keys
through `ctx.credentials`, and `agent-default-model`, `llm-pi-ai`, and
`llm-deepseek` keep their entries.

## Requirements

**Harness 0.1.7 or later.** 0.2.0 is built on the settings model Harness
0.1.7 introduced (values live in each plugin's volatile Config and are saved in
the profile's `cordis.patch.yml`). On an older Harness, keep using
`dsh-oss-sync@0.1` — and do not run 0.1.x on Harness 0.1.7: it disables the
settings service, and the Desktop application then fails at startup with
`desktop welcome: Web RPC failed`. See [Migrating from 0.1.x](#migrating-from-01x).

The bucket must support `If-Match` and `If-None-Match` on `PutObject`.

## Quick start

```sh
# 1. install into a profile
dsh plugin --profile web add dsh-oss-sync

# 2. point it at a bucket — either in the environment the surface launches from,
#    or afterwards in the bundle's section on the Plugins page
export DSH_SYNC_BUCKET=my-dsh
export DSH_SYNC_ENDPOINT=https://oss-cn-shanghai.aliyuncs.com   # omit for AWS
export DSH_SYNC_REGION=cn-shanghai

# 3. restart, then open Plugins → dsh-oss-sync
```

Every machine that installs the bundle and reads the same bucket then shares
both documents. Setting up a second machine is those same three steps — the
configuration is already in the bucket, and a machine syncing for the first
time takes it from there.

Without a bucket the surfaces still start: both halves run local-only, settings
stay in the profile, credentials stay in this machine's cache, nothing is read
or written to a service, and the Plugins-page section is where you supply a
bucket.

## What syncs

The settings document holds one section per **profile entry** that the
settings service describes — the same entry ids the settings pages edit
(`agent-default-model`, `llm-pi-ai`, `llm-deepseek`, `web-search-deepseek`,
`permission`, `ui-theme`, `locale`, …). A section is that entry's **user
layer**: the values saved in this profile, not the bundle defaults underneath
them.

Deliberately left out:

- **Secrets.** Every field a plugin declares `role('secret')` (for example a
  Web Search API key typed into its form) is redacted before anything is read,
  and restored from this profile when a section is applied. API keys belong in
  the credentials store, which syncs them on purpose.
- **`!!js` expressions.** A value such as `apiKeyEnv: !!js process.env.X`
  reads this machine's environment; it stays in the profile and survives an
  apply.
- **Machine-specific entries.** By default the shell executors
  (`pwsh-sandbox`, `bash-sandbox`, `pwsh-local`, `bash-local`, `shell`) are
  excluded: they hold this machine's working directory and executable paths.
  Change the scope with `include` / `exclude` (below).
- **This plugin's own rows** (`oss-settings`, `oss-credentials`): the
  connection is what reading the bucket needs, so it never lives in it.
- **Entries this profile does not run.** A section for a plugin that is not
  installed here is kept in the bucket for the machines that run it, and is
  applied the first time this profile runs that plugin.

The credentials document holds `refs` (reference name to secret value) and
`records` (per-plugin credential records, including authorization grants), as
in 0.1.x.

## How the settings sync works

- **Upload.** A settings write (from any page, or a hand edit to the profile
  patch that Harness reloads) raises `settings/document-updated`. After a
  one-second settle the sync reads the profile's sections and uploads the
  entries that changed since its last sync, under the ETag it read.
- **Apply.** Every poll reads the object. An entry the bucket changed and this
  profile did not is applied with `ctx.settings.replace()`, fenced by the
  entry's revision; the section is completed with this profile's own secrets
  and expressions first, and fields this Harness does not declare are dropped.
  An entry another machine reset is reset here too.
- **No echo.** Each profile records a baseline — the bucket's sections and its
  own, as of its last sync — and records it *after* every apply. An applied
  section therefore reads back as unchanged local state and is never uploaded
  again; a sync with nothing new writes nothing, in either direction.
- **Seeding.** An entry the baseline has not seen — every entry on the first
  sync at a location — takes the bucket's section when the bucket has one
  (**an existing bucket wins on a fresh machine**) and seeds the bucket from
  this profile otherwise (**this profile seeds an empty bucket**). Entries only
  this machine holds are merged in rather than dropped.
- **Conflicts.** Two machines editing **different** entries merge. Two
  machines editing the **same** entry: the later upload wins wholesale for
  that entry. A refused write (`412 Precondition Failed`) re-reads and
  re-plans.
- **Propagation.** Settings are applied by the poll, so `pollMs` (default
  30 s) is the propagation window; an edit leaves the machine about a second
  after it is saved.

The baseline is per profile, under
`$DSH_HOME/.dsh-oss-sync/profiles/<profile>/settings-sync.yaml`. Since Harness
0.1.7 keeps settings per profile, the Desktop and a CLI profile on one machine
each sync with the bucket on their own — and through it, with each other.

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
`dsh-oss-sync` and `dsh-oss-sync/credentials` are the rows in force. That check
matters: a package can install without its layer being composed.

A profile the harness does not ship (`--profile mine`) initializes with
`@deepseek-ai/dsh-base` alone, so it has no Web UI. `web` is the default for
that reason.

### Desktop

`dsh` refuses `--profile desktop` — the Electron application owns that
directory and installs plugins through its own Plugins page. Install
`dsh-oss-sync` there (**Plugins → Add plugin**, spec `dsh-oss-sync@0.2.1`), then
restart the application.

- `@deepseek-ai/*` are `peerDependencies`: the application supplies them, so
  the plugin runs against the host's own copies. The ranges state the Harness
  0.1.7 floor.
- Its ordinary dependencies (`@aws-sdk/client-s3`,
  `@aws-sdk/credential-provider-node`, `yaml`) resolve inside the profile and
  ship no install scripts.
- `lib/` and `lib/client.js` are committed and the published tarball carries
  them, so nothing builds on install.

Desktop needs no environment variable to start. `setx DSH_SYNC_BUCKET ...`
still works as a bootstrap default. Note that `DSH_*` names cannot come from a
`.env` file — the harness treats the whole prefix as launch-environment-only.

The `scripts/patch-desktop-asar.mjs` workaround shipped with 0.1.x is gone:
it patched a peer-range validator that Desktop 0.1.7 no longer has.

## Configure

### Environment

Both halves read their connection from the launching environment, so one
installed package serves every machine. Every value here is a bootstrap
default: the Plugins-page section saves its own values into the profile, over
these.

| Variable | Meaning |
|---|---|
| `DSH_SYNC_BUCKET` | Bucket holding the documents. Unset starts both halves local-only; set it here or in the section. |
| `DSH_SYNC_ENDPOINT` | S3-compatible endpoint (MinIO, Ceph, COS, OSS, TOS); omit for AWS. |
| `DSH_SYNC_REGION` | Region for the signature; defaults to `us-east-1`. |
| `DSH_SYNC_PREFIX` | Key prefix; defaults to `dsh-sync`. |
| `DSH_SYNC_FORCE_PATH_STYLE` | Set to `true` only for services that require path-style addressing (commonly MinIO). Defaults to virtual-hosted style, which TOS, OSS, and AWS require. |
| `DSH_SYNC_POLL_MS` | Poll interval in milliseconds; defaults to `30000`. |
| `DSH_SYNC_ACCESS_KEY_ID` / `DSH_SYNC_SECRET_ACCESS_KEY` | Static credentials for the bucket; see the precedence below. |

Bucket credentials resolve in this order: the pair saved in the section, then
the machine-wide pair a 0.1.x install saved
(`$DSH_HOME/.dsh-oss-sync/connection.yaml`), then the two environment
variables, then the SDK's own chain (`AWS_ACCESS_KEY_ID`, a profile, an
instance role).

### The configuration section

Open the bundle's page — **Plugins → dsh-oss-sync** — and the section sits
between the description and the row list, tagged `仅本机` until a bucket is
saved, `只读` where the deployment is not writable, `等待宿主` before the Host
has answered, and `未保存` while an edit is staged. Leaving the page drops every
staged edit; a refused save keeps its drafts and says so in place.

The section edits the `oss-settings` row's live Config through the Harness
settings forms, so a save lands in this profile's `cordis.patch.yml` and takes
effect without a restart. Harness stores the row's complete config there; the
`!!js process.env…` defaults of the fields you did not edit are kept as
expressions.

| Field | Meaning |
|---|---|
| `bucket`, `endpoint`, `region`, `forcePathStyle`, `accessKeyIdEnv`, `secretAccessKeyEnv` | Connection parameters. An endpoint without a URL scheme is normalized to `https://`. TOS/OSS/AWS use `forcePathStyle: false`; enable it only when a MinIO-compatible service requires it. |
| `accessKeyId`, `secretAccessKey` | The bucket's own OSS/TOS/S3 credentials — **not** a model provider API key. Saved in this profile's `cordis.patch.yml` (mode 0600), never written to the bucket. The secret is a `role('secret')` field: the Host never sends it back, so the input shows `已保存（留空保持不变）` and an empty input keeps it. **清除** saves an explicitly empty pair, which also removes a machine-wide `connection.yaml` left by 0.1.x. |
| `prefix` | Key prefix. Changing it moves both documents: an existing document at the new location wins, an empty one is seeded from this profile. |
| `pollMs` | Poll interval; applies immediately. |
| `include` | Comma-separated entry ids to sync; empty syncs every entry. |
| `exclude` | Comma-separated entry ids never synced; defaults to the shell executors. |
| `status` | Runtime, read-only: per half (`settings`, `credentials`), revision, writer, commit time, object key, last read/write, the entries the last sync applied or uploaded, and the last error. This plugin publishes it into its own running Config reference; it is never written to the profile or the bucket. |
| `request` | **立即同步** / **强制推送** write a new token here; the Host runs the sync on both halves. `push` re-commits this profile's sections over the bucket's. |

`secretAccessKey` renders masked, and Chromium refuses to cut or copy out of a
masked input. So that field carries **显示 / 隐藏**, which re-types the input
without touching the value, and **复制**, which hands the field's current text
to the host clipboard — both act on what you typed, since a saved secret never
reaches the page.

### Per-profile overrides

The section is the usual way to configure a profile, and it writes the
profile's `$DSH_HOME/profiles/<name>/cordis.patch.yml`. Editing that file by
hand works too:

```yaml
- id: oss-settings
  config:
    bucket: my-dsh
    endpoint: https://oss-cn-shanghai.aliyuncs.com
    exclude: [pwsh-sandbox, bash-sandbox, ui-theme]
```

`oss-credentials` needs no row of its own: the credentials half follows the
connection `oss-settings` resolves. Its own row is only the cold-start default.

Governance-mode bucket versioning is strongly recommended: it is what turns a
mistaken overwrite into a recoverable revision.

## What lands in the bucket

Two objects, `<prefix>/settings.yaml` and `<prefix>/credentials.yaml`, both
readable YAML so you can diff and hand-edit them:

```yaml
v: 1
rev: 12
writer: 6f1c1a1e-…
updatedAt: 2026-09-23T09:12:03.114Z
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

The envelope and the object keys are the ones 0.1.x wrote, so a bucket 0.1.x
filled is read as-is. The 0.1.x section keys `ui-developer-tools` and
`ui-onboarding` are read as the entries that own them now (`ui-settings`,
`ui-settings-general`), and the 0.1.x `oss-sync` section is ignored.

Per-machine state stays under `$DSH_HOME/.dsh-oss-sync/`: a stable
`device-id`, the credential cache, one-time import markers, and each profile's
settings baseline.

## Migrating from 0.1.x

Upgrade the plugin together with Harness (or right after it): 0.1.x cannot
start on Harness 0.1.7, and 0.2.0 cannot start before it.

```sh
dsh plugin --profile web add dsh-oss-sync@0.2.1
```

On Desktop, install `dsh-oss-sync@0.2.1` from the Plugins page, then restart.
What happens on the first start, once per profile:

- **Harness imports `$DSH_HOME/settings.yaml`** into the profile and renames it
  `settings.yaml.imported`. With 0.1.x installed that file was a pre-install
  copy, so it may be stale; the next steps supersede it.
- **The 0.1.x cache is imported.** 0.1.x kept the live settings in
  `$DSH_HOME/.dsh-oss-sync/settings.yaml.cache`. Its sections are written into
  the profile, and the connection the 0.1.x page saved (bucket, endpoint,
  region, prefix, addressing, poll interval) is written into the
  `oss-settings` row — unless this profile already has a bucket.
- **The first sync runs**: the bucket's sections win over the profile's, and
  sections only this profile holds are uploaded.
- **The bucket credentials keep working.** A pair the 0.1.x page saved in
  `connection.yaml` is still read as a machine-wide fallback. Save a pair in
  the section to override it, or press **清除** to retire it.

Other changes from 0.1.x:

- Settings are no longer replaced: the `settings` row stays mounted, and this
  plugin syncs through it. Harness 0.1.7 keeps settings per profile, so each
  profile syncs on its own; the old global document is gone.
- Settings reads no longer depend on the bucket or a cache — the profile is
  the local copy — so an unreachable bucket delays propagation and nothing
  else. An edit made offline is uploaded by the first sync that reaches the
  bucket.
- Secret form fields are not synced.
- `scripts/patch-desktop-asar.mjs` is removed.

To go back, reinstall `dsh-oss-sync@0.1.x` together with a Harness older than
0.1.7.

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

The bucket's own access key must never come from a synced document: it is the
bootstrap credential.

## Known limitations

- **Settings apply on the poll.** Another machine's edit arrives within
  `pollMs`; **立即同步** applies it now.
- **Same-entry conflicts resolve last-writer-wins** for the whole entry.
- **A pinned profile row.** Harness stores an entry's complete config in the
  profile once anything in it is saved, and an applied section is saved the
  same way: later bundle default changes to that entry stop reaching the
  profile until the entry is reset. This is Harness's own form behavior.
- **Only form fields sync.** The document carries volatile Config fields —
  what the settings pages edit. Ordinary Config a hand edit adds to the
  profile patch stays local.
- **A macOS Desktop shell without an Edit menu cannot copy from any text field.**
  The section's **复制** control goes through `navigator.clipboard` rather than
  the menu, so it is the one route a masked field has until that menu item
  exists.
- **The configuration section is not verified on screen.** `pnpm test:card`
  materializes the built bundle against a stubbed module table and asserts its
  markup and interaction; the host half is covered by the smoke test and a boot
  against a real 0.1.7 runtime. No run has confirmed the CSS in a browser.
- **No `.env` fallback for credentials.** `dsh-credentials-local` layers the
  process environment, the stored file, `<cwd>/.env`, and `$DSH_HOME/.env`.
  This provider layers the environment and the bucket only.
- **Offline credential writes fail.** Credential reads fall back to the cache;
  a credential write with no reachable bucket rejects. There is no offline
  queue for credentials.
- **One bucket per document pair.** Settings and credentials share a prefix
  and therefore a bucket.

## How it works

The bundle patch (`cordis.patch.yml`) does two things to the `dsh-base`
composition:

| Row | Base package | This bundle |
|---|---|---|
| `settings` | `@deepseek-ai/dsh-settings` | left mounted; `oss-settings` (`dsh-oss-sync`) is inserted beside it and syncs through `ctx.settings` |
| `credentials` | `@deepseek-ai/dsh-credentials-local` (`$DSH_HOME/.credentials.yaml`) | disabled; `oss-credentials` (`dsh-oss-sync/credentials`) is inserted on its own id |

A loader patch cannot rename a row — its `name` is an assertion the patch must
match — which is why the credential store is replaced by disabling and
inserting.

`oss-settings` declares its connection, scope, request, and status fields
`.volatile()`. That is what makes them a settings form (the Plugins-page
section edits them through `ctx.configForms`), and what lets a saved edit reach
the running plugin as a `loader/volatile-update` instead of a remount. It also
provides `ossSyncControl`, through which the credentials half follows the
connection and reports its status.

Two consequences of the harness's own loading rules shape the package layout:

- The package root (`lib/index.js`) is the settings sync rather than a subpath
  entry, because the browser module scan resolves a package's `dsh.client`
  bundle from a Loader row named by a **bare package specifier**.
- `lib/client.js` is not an ES module. The combo route concatenates several
  packages into one script, so a top-level `import` in any one of them would
  break the whole script. The bundle is a lazy CommonJS factory wrapped in
  `window.__ModuleLoader__.load({ id, factory })`.

## Development

```sh
pnpm install
pnpm build          # tsc → lib/, then esbuild → lib/client.js
pnpm smoke          # fake-S3 and fake-settings end-to-end checks
pnpm test:card      # the browser section, against a stubbed module table
pnpm test           # both
```

`tsconfig.json` resolves the `@deepseek-ai/*` peer packages through `paths`
into a sibling `deepseek-harness` checkout's built declarations, so that
checkout has to be built (at 0.1.7 or later) before this one compiles.

`lib/` is what the loader loads: rebuild after every source change, then
restart the profile.

See [CONTRIBUTING.md](https://github.com/jackchun53/dsh-oss-sync/blob/main/CONTRIBUTING.md)
for publishing and the rest of the maintainer-facing detail.

## Changelog

### 0.2.1

- Fixes every settings entry failing with "HMR transactions cannot be nested"
  after the plugin is enabled from the Plugins page: settings writes no longer
  inherit the transaction that started the plugin.

### 0.2.0

- Requires Harness 0.1.7. Settings are synced through the public settings
  API instead of replacing the settings store; the `settings` row stays
  mounted, which fixes the Desktop startup failure 0.1.x causes on 0.1.7.
- Per-entry three-way sync with a per-profile baseline: no echo, an existing
  bucket wins on first sync, an empty bucket is seeded, local-only entries
  merge in.
- Secrets, `!!js` expressions, the shell executors, and this plugin's rows
  never reach the bucket; `include` / `exclude` set the scope.
- The Plugins-page section edits the `oss-settings` row's live Config; the
  bucket pair is saved in the profile, with the 0.1.x `connection.yaml` kept as
  a fallback.
- One-time import of the 0.1.x settings cache and connection per profile.
- `scripts/patch-desktop-asar.mjs` removed; Desktop 0.1.7 has no peer-range
  validator to patch.

### 0.1.x

Settings and credential providers replacing the file-backed stores, for
Harness 0.1.5–0.1.6.

## License

MIT — see [LICENSE](https://github.com/jackchun53/dsh-oss-sync/blob/main/LICENSE).
