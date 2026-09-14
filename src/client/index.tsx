/**
 * The sync card, browser half.
 *
 * `Settings → Plugins` dispatches one card per served settings namespace,
 * keyed by that namespace, so this file registers a card under `oss-sync` and
 * edits the namespace through the client settings scope. Configuration,
 * runtime status, and the action buttons all ride that one scope: the host
 * publishes status into the same namespace, and a button writes the namespace's
 * request token.
 *
 * Single-file on purpose. The host serves one built bundle per package, so a
 * relative import here would be a second module the browser never fetches.
 *
 * @module dsh-oss-sync/client
 */

import type { CSSProperties } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: brings the `ctx.slots` context merge.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: brings the `ctx.settingsScope` context merge.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: this package is not in the browser's baseline module table, and
// the context merge plus the SettingsScope contract are all this half needs.
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the `settings.plugin.item` slot declaration and its owner props.
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'

/** The settings namespace this card edits; the host half registers it. */
const NS = 'oss-sync'

/** One editable field of the card. */
interface FieldSpec {
  /** Namespace field this input edits. */
  field: string
  /** Label above the input. */
  label: string
  /** Hint below the input. */
  hint: string
  /** Render as a masked input: the value is a secret. */
  secret?: boolean
  /** Write an empty string instead of unsetting, so emptying the input clears what is stored. */
  clearWithEmpty?: boolean
}

/** Fields the card edits, in render order. */
const FIELDS: readonly FieldSpec[] = [
  { field: 'bucket', label: '存储桶', hint: '两份文档都存放于此。' },
  { field: 'endpoint', label: '端点', hint: 'S3 兼容地址；留空表示使用 AWS。' },
  { field: 'prefix', label: '键前缀', hint: '修改后会移动两份文档。' },
  { field: 'region', label: '区域', hint: '签名使用的区域。' },
  { field: 'pollMs', label: '轮询间隔（毫秒）', hint: '另一台机器的写入多久到达本机。' },
  {
    field: 'accessKeyId',
    label: '访问密钥 ID',
    hint: '只保存在本机，不会写入存储桶。',
    clearWithEmpty: true,
  },
  {
    field: 'secretAccessKey',
    label: '访问密钥 Secret',
    hint: '只保存在本机，不会写入存储桶；清空即删除本机保存的密钥。',
    secret: true,
    clearWithEmpty: true,
  },
]

/** One provider's runtime status, as the host publishes it. */
interface StatusView {
  state?: string
  configured?: boolean
  revision?: number
  writer?: string
  updatedAt?: string
  lastReadAt?: string
  lastWriteAt?: string
  objectKey?: string
  lastError?: string
}

/** What the card renders. */
interface CardState {
  /** Whether the host answered with this namespace's descriptor. */
  ready: boolean
  /** Whether the host accepts writes for this namespace. */
  writable: boolean
  /** Staged text per field; a field with no draft shows the resolved value. */
  drafts: Record<string, string>
  /** Whether the user changed anything since the last save. */
  dirty: boolean
  /** Set while a save is in flight. */
  saving: boolean
  /** The failure a save reported, cleared by the next attempt. */
  failure: string | undefined
  /** Resolved connection parameters. */
  values: Record<string, unknown>
  /** Which fields the user layer overrides. */
  overridden: Record<string, unknown>
  /** Runtime status by provider. */
  status: Record<string, StatusView>
}

/** One bare observable; the renderer binds it to `useOssSyncCard`. */
interface Observable<T> {
  getSnapshot: () => T
  subscribe: (listener: () => void) => () => void
  set: (next: T) => void
}

/**
 * Build a minimal snapshot source for the inject `hooks` compartment.
 * @param initial - the first snapshot.
 * @returns the observable the renderer binds.
 */
function observable<T>(initial: T): Observable<T> {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set: (next) => {
      if (Object.is(next, snapshot)) return
      snapshot = next
      for (const listener of listeners) listener()
    },
  }
}

/** The registration-side face the card's slot entry injects. */
interface OssSyncFace {
  hooks: {
    /** Card snapshot, bound by the renderer as `useOssSyncCard`. */
    ossSyncCard: Observable<CardState>
  }
  edit: (field: string, text: string) => void
  save: () => void
  discard: () => void
  action: (verb: 'pull' | 'push') => void
}

/** Props the renderer binds for this card. */
type OssSyncCardProps = PropsRuntime<'settings.plugin.item'> & InjectFace<OssSyncFace>

/** Bridges the `oss-sync` scope onto the card's staged form. */
class CardController {
  private readonly snapshot = observable<CardState>({
    ready: false,
    writable: false,
    drafts: {},
    dirty: false,
    saving: false,
    failure: undefined,
    values: {},
    overridden: {},
    status: {},
  })

  private readonly unsubscribe: () => void

  /** @param scope - the bound settings scope for the `oss-sync` namespace. */
  constructor(private readonly scope: SettingsScope<Record<string, unknown>>) {
    this.project(scope.getSnapshot())
    this.unsubscribe = scope.subscribe(() => { this.project(scope.getSnapshot()) })
  }

  /** The face the slot registration injects. */
  inject(): OssSyncFace {
    return {
      hooks: { ossSyncCard: this.snapshot },
      edit: (field, text) => {
        const state = this.snapshot.getSnapshot()
        const drafts = { ...state.drafts, [field]: text }
        this.snapshot.set({
          ...state,
          drafts,
          dirty: FIELDS.some(entry => drafts[entry.field] !== undefined
            && drafts[entry.field] !== renderValue(state.values[entry.field])),
          failure: undefined,
        })
      },
      save: () => { void this.save() },
      discard: () => {
        const state = this.snapshot.getSnapshot()
        this.snapshot.set({ ...state, drafts: {}, dirty: false, failure: undefined })
      },
      action: (verb) => { void this.action(verb) },
    }
  }

  /** Release the scope subscription. */
  dispose(): void {
    this.unsubscribe()
  }

  /** Project a scope snapshot onto the card state, keeping unsaved drafts. */
  private project(snapshot: SettingsScopeSnapshot<Record<string, unknown>>): void {
    const value = (snapshot.value ?? {}) as Record<string, unknown>
    const current = this.snapshot.getSnapshot()
    const drafts: Record<string, string> = {}
    for (const entry of FIELDS) {
      const staged = current.drafts[entry.field]
      // A staged edit survives a host push only while it still differs from
      // what the host resolved; once the host agrees, the draft is obsolete.
      if (staged !== undefined && staged !== renderValue(value[entry.field])) drafts[entry.field] = staged
    }
    this.snapshot.set({
      ready: snapshot.status === 'ready',
      writable: snapshot.writable,
      drafts,
      dirty: Object.keys(drafts).length > 0,
      saving: current.saving,
      failure: current.failure,
      values: value,
      overridden: (snapshot.user ?? {}) as Record<string, unknown>,
      status: (value['status'] ?? {}) as Record<string, StatusView>,
    })
  }

  /** Write every staged field, then clear the drafts. */
  private async save(): Promise<void> {
    const state = this.snapshot.getSnapshot()
    const pending = FIELDS.filter(entry => state.drafts[entry.field] !== undefined)
    if (pending.length === 0) return
    // The credential pair is saved field by field, and the store refuses a
    // half pair — so a save that would leave exactly one side set is refused
    // here instead of erroring one field later.
    const fieldAfter = (field: string): string =>
      state.drafts[field] ?? renderValue(state.values[field])
    const halfPair = (fieldAfter('accessKeyId').length === 0) !== (fieldAfter('secretAccessKey').length === 0)
    if (halfPair) {
      this.snapshot.set({ ...state, failure: '访问密钥 ID 与 Secret 必须同时填写或同时清空' })
      return
    }
    this.snapshot.set({ ...state, saving: true, failure: undefined })
    try {
      for (const entry of pending) {
        const text = state.drafts[entry.field] ?? ''
        if (text.length === 0 && entry.clearWithEmpty !== true) await this.scope.unset(entry.field)
        else await this.scope.set(entry.field, entry.field === 'pollMs' ? Number(text) : text)
      }
      const latest = this.snapshot.getSnapshot()
      this.snapshot.set({ ...latest, drafts: {}, dirty: false, saving: false })
    } catch (error) {
      this.snapshot.set({ ...this.snapshot.getSnapshot(), saving: false, failure: String(error) })
    }
  }

  /** Write a request token; the host runs the verb on both providers. */
  private async action(verb: 'pull' | 'push'): Promise<void> {
    const state = this.snapshot.getSnapshot()
    this.snapshot.set({ ...state, failure: undefined })
    try {
      await this.scope.set('request', `${verb}:${String(Date.now())}`)
    } catch (error) {
      this.snapshot.set({ ...this.snapshot.getSnapshot(), failure: String(error) })
    }
  }
}

/**
 * Render one value as the text a field shows.
 * @param value - the resolved value.
 * @returns its text form; absent renders empty.
 */
function renderValue(value: unknown): string {
  return value === undefined || value === null ? '' : String(value)
}

/** Shared inline style for a field label. */
const LABEL: CSSProperties = { display: 'block', fontSize: '12px', fontWeight: 600, marginBottom: '2px' }
/** Shared inline style for a field hint and every status value. */
const HINT: CSSProperties = { color: 'var(--dsh-text-secondary, #666)', fontSize: '11px' }
/** Shared inline style for a text input. */
const INPUT: CSSProperties = { width: '100%', padding: '4px 6px', font: 'inherit' }
/** Shared inline style for a row of controls. */
const ROW: CSSProperties = { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '8px' }

/**
 * Render the sync card.
 * @param props - the card snapshot and its actions.
 * @returns the card.
 */
function OssSyncCard(props: OssSyncCardProps) {
  const state = props.useOssSyncCard(snapshot => snapshot)
  // A provider that reports no bucket is local-only, which is the state the
  // card exists to end: actions have nothing to reach until one is saved.
  const unconfigured = Object.values(state.status).some(entry => entry.configured === false)
  return (
    <div style={{ border: '1px solid var(--dsh-border, #ddd)', borderRadius: '6px', padding: '12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <strong>OSS 同步</strong>
        <span style={HINT}>
          {state.ready ? (state.writable ? '可写' : '只读') : '等待宿主'}
        </span>
      </div>
      <p style={{ ...HINT, margin: '4px 0 10px' }}>
        设置与密钥都存放在 S3 兼容的存储桶里，因此每台机器读取同一份文档。改动会在下一次请求时生效；
        存储桶与端点立即生效。
      </p>

      {unconfigured ? (
        <p style={{ ...HINT, margin: '0 0 10px' }}>
          尚未配置存储桶：在保存一个之前，设置与密钥只留在本机。保存时会以本机文档作为初始内容写入。
        </p>
      ) : null}

      <div style={{ display: 'grid', gap: '8px' }}>
        {FIELDS.map((entry) => {
          const draft = state.drafts[entry.field]
          return (
            <label key={entry.field} htmlFor={`oss-sync-${entry.field}`}>
              <span style={LABEL}>
                {entry.label}
                {state.overridden[entry.field] === undefined ? null : <em style={HINT}> （已覆盖）</em>}
              </span>
              <input
                id={`oss-sync-${entry.field}`}
                style={INPUT}
                type={entry.secret === true ? 'password' : 'text'}
                autoComplete={entry.secret === true ? 'new-password' : 'off'}
                disabled={!state.writable || state.saving}
                value={draft ?? renderValue(state.values[entry.field])}
                onChange={(event) => { props.edit(entry.field, event.target.value) }}
              />
              <span style={HINT}>{entry.hint}</span>
            </label>
          )
        })}
      </div>

      <div style={ROW}>
        <button type="button" disabled={!state.dirty || state.saving} onClick={() => { props.save() }}>
          {state.saving ? '保存中…' : '保存'}
        </button>
        <button type="button" disabled={!state.dirty || state.saving} onClick={() => { props.discard() }}>
          放弃
        </button>
        <button type="button" disabled={!state.ready || unconfigured} onClick={() => { props.action('pull') }}>
          立即同步
        </button>
        <button type="button" disabled={!state.ready || unconfigured} onClick={() => { props.action('push') }}>
          强制推送
        </button>
      </div>

      {state.failure === undefined ? null : (
        <p style={{ ...HINT, color: 'var(--dsh-danger, #b00)' }}>{state.failure}</p>
      )}

      {(['settings', 'credentials'] as const).map(label => (
        <div key={label} style={{ marginTop: '10px' }}>
          <span style={LABEL}>{label === 'settings' ? '设置' : '密钥'}</span>
          <span style={HINT}>
            {describeStatus(state.status[label])}
          </span>
        </div>
      ))}
    </div>
  )
}

/**
 * Render one provider's status as a single line.
 * @param status - the provider's published status, when it reported.
 * @returns the line.
 */
function describeStatus(status: StatusView | undefined): string {
  if (status === undefined) return '暂无状态'
  // An unconfigured store can still carry a failure: a relocation that could
  // not reach its bucket keeps the previous store, and the saved connection's
  // error is the thing the reader needs.
  if (status.configured === false) {
    return status.lastError === undefined
      ? '未配置 · 不读取也不写入'
      : `未配置 · 不读取也不写入 · 错误 ${status.lastError}`
  }
  const parts = [
    `状态 ${status.state === 'error' ? '错误' : '正常'}`,
    `版本 ${String(status.revision ?? 0)}`,
    status.objectKey === undefined ? undefined : `对象 ${status.objectKey}`,
    status.lastReadAt === undefined ? undefined : `读取 ${status.lastReadAt}`,
    status.lastWriteAt === undefined ? undefined : `写入 ${status.lastWriteAt}`,
    status.lastError === undefined ? undefined : `错误 ${status.lastError}`,
  ]
  return parts.filter(part => part !== undefined).join(' · ')
}

/** Required browser services (cordis fiber inject). */
export const inject = ['slots', 'settingsScope']

/**
 * Mount the sync card.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const controller = new CardController(ctx.settingsScope.bind({ namespace: NS }))
  ctx.effect(() => () => { controller.dispose() }, 'dsh-oss-sync: card controller')
  // The tab declares this slot; registering before it exists would throw, and
  // this deployment may load either half first.
  ctx.slots.inject('settings.plugin.item', function* () {
    yield ctx.slots.register({
      name: 'settings.plugin.item',
      key: NS,
      inject: () => controller.inject(),
    }, OssSyncCard)
  })
}
