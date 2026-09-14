# dsh-oss-sync

Object-storage providers for the two DeepSeek Harness stores that make a
machine yours: user settings (models, providers, default model) and
credentials (API keys). Both live in one S3-compatible bucket, so a second
machine picks up the same configuration without copying files by hand.

This is an out-of-tree plugin bundle: it replaces two rows of the `dsh-base`
composition and installs into a profile with `dsh plugin --profile <name> add`.

## What it replaces

| Base row | Base package | Replaced by |
|---|---|---|
| `settings` | `@deepseek-ai/dsh-settings-file` (`$DSH_HOME/settings.yaml`) | `dsh-oss-sync/settings` |
| `credentials` | `@deepseek-ai/dsh-credentials-local` (`$DSH_HOME/.credentials.yaml`) | `dsh-oss-sync/credentials` |

A loader patch cannot rename a row — its `name` is an assertion the patch must
match — so `cordis.patch.yml` disables both base rows and inserts these two on
their own ids.

Everything above the seam is untouched: the Web **Settings → Models** page
still writes through `ctx.settings`, the model picker still resolves keys
through `ctx.credentials`, and `agent-default-model`, `llm-pi-ai`, and
`llm-deepseek` keep their namespaces. Only the storage moved.

## Install

```sh
# from the directory containing this checkout
dsh plugin --profile web add ./dsh-oss-sync
dsh --profile web
```

The profile forwards to pnpm, so `remove`, `update`, and the rest of the pnpm
verbs work. `dsh plugin` also accepts a git spec or a packed tarball, which
needs the package's `lib/` to be built first:

```sh
pnpm install && pnpm build
```

`@deepseek-ai/*` packages are peer dependencies and resolve to the running
installation, so the plugin shares one Cordis instance with the host. Only
`@aws-sdk/client-s3` and `yaml` are installed beside it.

## Configure

The bundle layer reads its values from the launching environment, so one
installed package serves every machine:

| Variable | Meaning |
|---|---|
| `DSH_SYNC_BUCKET` | Bucket holding the documents. Required. |
| `DSH_SYNC_ENDPOINT` | S3-compatible endpoint (MinIO, Ceph, COS); omit for AWS. |
| `DSH_SYNC_REGION` | Region for the signature; defaults to `us-east-1`. |
| `DSH_SYNC_PREFIX` | Key prefix; defaults to `dsh-sync`. |
| `DSH_SYNC_POLL_MS` | Poll interval in milliseconds; defaults to `30000`. |
| `DSH_SYNC_ACCESS_KEY_ID` / `DSH_SYNC_SECRET_ACCESS_KEY` | Static credentials; unset falls back to the SDK's own chain (`AWS_ACCESS_KEY_ID`, profile, IAM role). |

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

## Concurrency

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

## Development

```sh
pnpm install
pnpm build          # tsc → lib/
```

`tsconfig.json` resolves the `@deepseek-ai/*` peer packages through `paths`
into the sibling `deepseek-harness` checkout's built declarations. Change the
sibling path there, or add real dependencies, before publishing.

`lib/` is what the loader loads: rebuild after every source change, then
restart the profile. When running the harness from source (`pnpm dsh` from the
checkout, which loads through tsx), a `--patch` overlay pointing straight at
`src/settings.ts` gives a faster loop than a rebuild.
