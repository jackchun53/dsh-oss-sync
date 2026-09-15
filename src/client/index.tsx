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
 * Nothing here is a stylesheet either: the bundle has nowhere to put a CSS
 * module, so the card's chrome rides inline styles, and hover is spelled out as
 * state because an inline style carries no `:hover`.
 *
 * The card discloses in place, the way the Host's own plugin cards do: the
 * settings page lists one row per plugin, and which one a reader has open is a
 * reading gesture rather than a persisted setting. It starts closed, since the
 * fields are the tallest thing on the page and most visits never touch them.
 *
 * @module dsh-oss-sync/client
 */

import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { IconChevronDownOutline14, Tag, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
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
  /** Render a true/false selector and persist a boolean rather than text. */
  boolean?: boolean
}

/** Fields the card edits, in render order. */
const FIELDS: readonly FieldSpec[] = [
  { field: 'bucket', label: '存储桶', hint: '两份文档都存放于此，例如 dsh-config。' },
  { field: 'endpoint', label: 'S3 端点', hint: '例如 https://tos-s3-cn-shanghai.volces.com；省略协议时自动补 https://。' },
  { field: 'prefix', label: '键前缀', hint: '修改后会移动两份文档。' },
  { field: 'region', label: '签名区域', hint: '必须使用服务商的区域值；火山 TOS 上海通常为 cn-shanghai。' },
  {
    field: 'forcePathStyle',
    label: '路径式寻址',
    hint: '火山 TOS、阿里云 OSS 与 AWS 请选择“关闭”；MinIO 等仅在要求 path-style 时开启。',
    boolean: true,
  },
  { field: 'pollMs', label: '轮询间隔（毫秒）', hint: '另一台机器的写入多久到达本机。' },
  {
    field: 'accessKeyId',
    label: '对象存储 AccessKey ID',
    hint: '这是 OSS/TOS 的访问密钥，不是模型提供方 API Key；只保存在本机。',
    clearWithEmpty: true,
  },
  {
    field: 'secretAccessKey',
    label: '对象存储 AccessKey Secret',
    hint: '这是 OSS/TOS 的访问密钥，不是模型提供方 API Key；清空两项即删除本机保存。',
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
    const pollDraft = state.drafts['pollMs']
    if (pollDraft !== undefined && (!Number.isFinite(Number(pollDraft)) || Number(pollDraft) < 1000)) {
      this.snapshot.set({ ...state, failure: '轮询间隔必须是不小于 1000 的数字' })
      return
    }
    this.snapshot.set({ ...state, saving: true, failure: undefined })
    try {
      // One atomic namespace mutation keeps the bucket, addressing mode, and
      // credential pair behind the same revision fence. Saving them field by
      // field briefly built an invalid half-configured connection and made a
      // first-time setup look as if the form had ignored it.
      await this.scope.mutate(pending.map((entry) => {
        const text = state.drafts[entry.field] ?? ''
        if (text.length === 0 && entry.clearWithEmpty !== true) {
          return { op: 'unset' as const, path: [entry.field] }
        }
        const value = entry.field === 'pollMs' ? Number(text) : entry.boolean === true ? text === 'true' : text
        return { op: 'set' as const, path: [entry.field], value }
      }))
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

/**
 * Card chrome, in the tokens the settings page around it uses. Only
 * `--dsw-alias-*` follows the theme; the `--dsh-*` names this card used before
 * are not tokens, so every colour was silently its light-mode fallback.
 */
const CARD: CSSProperties = {
  listStyle: 'none',
  border: '0.5px solid var(--dsw-alias-border-l4)',
  borderRadius: '16px',
  background: 'var(--dsw-alias-bg-layer-3)',
  transition: 'border-color .16s, background .16s',
}
/** An open card reads as the one being worked on, not merely taller. */
const CARD_OPEN: CSSProperties = {
  background: 'var(--dsw-alias-bg-layer-2)',
  borderColor: 'var(--dsw-alias-label-dimmed)',
}
/** The hover the neighbouring cards get from their stylesheet. */
const CARD_HOVER: CSSProperties = { borderColor: 'var(--dsw-alias-label-dimmed)' }
/** The whole header is the disclosure control, not just the chevron. */
const HEADER: CSSProperties = {
  appearance: 'none',
  width: '100%',
  border: 0,
  background: 'none',
  font: 'inherit',
  color: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  gap: '12px',
  padding: '14px 16px',
  borderRadius: '12px',
}
/** Name over description, so two collapsed cards stay tellable apart. */
const HEAD_TEXT: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: '4px',
}
/** Card name. */
const NAME: CSSProperties = {
  fontSize: '15px',
  fontWeight: 600,
  lineHeight: 1.4,
  color: 'var(--dsw-alias-label-primary)',
}
/** What this card's settings govern. */
const DESCRIPTION: CSSProperties = {
  fontSize: '13px',
  lineHeight: 1.5,
  color: 'var(--dsw-alias-label-tertiary)',
}
/** Rotation rides the wrapper: an icon takes `size` and `className`, not a style. */
const CHEVRON: CSSProperties = {
  flex: 'none',
  display: 'inline-flex',
  color: 'var(--dsw-alias-label-tertiary)',
  transition: 'transform .16s',
}
/** The disclosed controls, separated from the header it sits under. */
const BODY: CSSProperties = {
  borderTop: '0.5px solid var(--dsw-alias-border-l2)',
  margin: '0 16px',
  paddingBottom: '8px',
}
/** Stated in the body so a read-only deployment is not a silently dead form. */
const READ_ONLY: CSSProperties = {
  margin: '12px 0 0',
  fontSize: '12px',
  lineHeight: 1.5,
  color: 'var(--dsw-alias-label-tertiary)',
}
/** Shared inline style for a field label. */
const LABEL: CSSProperties = {
  display: 'block',
  fontSize: '12px',
  fontWeight: 600,
  marginBottom: '2px',
  color: 'var(--dsw-alias-label-secondary)',
}
/** Shared inline style for a field hint and every status value. */
const HINT: CSSProperties = { color: 'var(--dsw-alias-label-tertiary)', fontSize: '11px' }
/** Shared inline style for a text input. */
const INPUT: CSSProperties = {
  width: '100%',
  padding: '5px 8px',
  font: 'inherit',
  fontSize: '13px',
  color: 'var(--dsw-alias-label-primary)',
  background: 'var(--dsw-alias-bg-layer-1)',
  border: '0.5px solid var(--dsw-alias-border-l4)',
  borderRadius: '10px',
}
/** Shared inline style for a row of controls. */
const ROW: CSSProperties = { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '8px' }
/**
 * The masked field's row. Chromium refuses to cut or copy out of an
 * `input[type=password]`, so the two controls that lift that restriction sit
 * beside the value they act on rather than in the action row below.
 */
const SECRET_ROW: CSSProperties = { display: 'flex', gap: '6px', alignItems: 'center' }
/** A control narrow enough to ride beside an input. */
const INLINE_CONTROL: CSSProperties = {
  flex: 'none',
  padding: '5px 8px',
  font: 'inherit',
  fontSize: '12px',
  whiteSpace: 'nowrap',
  color: 'var(--dsw-alias-label-secondary)',
  background: 'var(--dsw-alias-bg-layer-1)',
  border: '0.5px solid var(--dsw-alias-border-l4)',
  borderRadius: '8px',
  cursor: 'pointer',
}

/**
 * Render the sync card.
 * @param props - the card snapshot and its actions.
 * @returns the card.
 */
function OssSyncCard(props: OssSyncCardProps) {
  const state = props.useOssSyncCard(snapshot => snapshot)
  const [open, setOpen] = useState(false)
  const [hovered, setHovered] = useState(false)
  // Reveal is a reading gesture, never a value change: the secret stays the
  // secret, and only its masking is lifted.
  const [revealed, setRevealed] = useState<readonly string[]>([])
  const [copied, setCopied] = useState<{ field: string; ok: boolean } | undefined>(undefined)
  const saveStarted = useRef(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => { clearTimeout(copyTimer.current) }, [])

  /** Reveal or re-mask one secret. */
  const toggleReveal = (field: string): void => {
    setRevealed(current => current.includes(field)
      ? current.filter(name => name !== field)
      : [...current, field])
  }

  /**
   * Copy one field's current text through the host clipboard. A masked field is
   * the one value the platform will not let a reader copy, so this affordance
   * travels with exactly those fields — and never unmasks them to do it.
   * @param field - the field being copied, for its own feedback.
   * @param text - the text to place on the clipboard.
   */
  const copyField = (field: string, text: string): void => {
    void writeClipboard(text).then((accepted) => {
      setCopied({ field, ok: accepted })
      clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => { setCopied(undefined) }, 1600)
    })
  }
  // A provider that reports no bucket is local-only, which is the state the
  // card exists to end: actions have nothing to reach until one is saved.
  const unconfigured = Object.values(state.status).some(entry => entry.configured === false)
  // Settle on the Host's answer rather than on the click: a rejected save keeps
  // its diagnostics and its retained drafts in view, where they can be fixed.
  useEffect(() => {
    if (state.saving) {
      saveStarted.current = true
      return
    }
    if (!saveStarted.current) return
    saveStarted.current = false
    if (!state.dirty && state.failure === undefined) setOpen(false)
  }, [state.dirty, state.failure, state.saving])

  // One badge, in the order a reader needs it: a card that cannot reach its
  // bucket matters more than one that is merely not writable from here.
  const badge = !state.ready ? '等待宿主' : unconfigured ? '仅本机' : state.writable ? undefined : '只读'
  return (
    <li style={{ ...CARD, ...(open ? CARD_OPEN : {}), ...(hovered && !open ? CARD_HOVER : {}) }}>
      <button
        type="button"
        style={HEADER}
        aria-expanded={open}
        aria-label={`${open ? '收起' : '展开'}：OSS 同步`}
        onMouseEnter={() => { setHovered(true) }}
        onMouseLeave={() => { setHovered(false) }}
        onClick={() => { setOpen(!open) }}
      >
        <span style={HEAD_TEXT}>
          <span style={NAME}>OSS 同步</span>
          <span style={DESCRIPTION}>设置与密钥存放于 S3 兼容的存储桶，每台机器读取同一份文档。</span>
        </span>
        {badge === undefined ? null : <Tag tone={unconfigured ? 'warning' : 'quiet'}>{badge}</Tag>}
        {state.dirty ? <Tag tone="neutral">未保存</Tag> : null}
        <span style={open ? { ...CHEVRON, transform: 'rotate(180deg)' } : CHEVRON}>
          <IconChevronDownOutline14 />
        </span>
      </button>

      {open ? (
        <div style={BODY}>
          {state.writable ? null : <p style={READ_ONLY} role="status">当前为只读：这个部署不接受设置写入。</p>}

          {unconfigured ? (
            <p style={{ ...HINT, margin: '10px 0' }}>
              尚未配置存储桶：在保存一个之前，设置与密钥只留在本机。保存时会以本机文档作为初始内容写入。
            </p>
          ) : null}

          <div style={{ display: 'grid', gap: '8px', marginTop: '10px' }}>
            {FIELDS.map((entry) => {
              const draft = state.drafts[entry.field]
              const text = draft ?? renderValue(state.values[entry.field])
              const locked = !state.writable || state.saving
              const control = (
                <input
                  id={`oss-sync-${entry.field}`}
                  style={INPUT}
                  // Only a masked field is re-typed; reveal keeps the same input
                  // so the caret and the staged draft survive the toggle.
                  type={entry.secret === true && !revealed.includes(entry.field) ? 'password' : 'text'}
                  autoComplete={entry.secret === true ? 'new-password' : 'off'}
                  disabled={locked}
                  value={text}
                  onChange={(event) => { props.edit(entry.field, event.target.value) }}
                />
              )
              return (
                <div key={entry.field}>
                  <label style={LABEL} htmlFor={`oss-sync-${entry.field}`}>
                    {entry.label}
                    {state.overridden[entry.field] === undefined ? null : <em style={HINT}> （已覆盖）</em>}
                  </label>
                  {entry.boolean === true ? (
                    <select
                      id={`oss-sync-${entry.field}`}
                      style={INPUT}
                      disabled={locked}
                      value={text}
                      onChange={(event) => { props.edit(entry.field, event.target.value) }}
                    >
                      <option value="false">关闭（虚拟主机式，OSS / TOS / AWS）</option>
                      <option value="true">开启（路径式，部分 MinIO）</option>
                    </select>
                  ) : entry.secret === true ? (
                    <div style={SECRET_ROW}>
                      {control}
                      <button
                        type="button"
                        style={INLINE_CONTROL}
                        aria-label={`${revealed.includes(entry.field) ? '隐藏' : '显示'}：${entry.label}`}
                        aria-pressed={revealed.includes(entry.field)}
                        onClick={() => { toggleReveal(entry.field) }}
                      >
                        {revealed.includes(entry.field) ? '隐藏' : '显示'}
                      </button>
                      <button
                        type="button"
                        style={INLINE_CONTROL}
                        aria-label={`复制：${entry.label}`}
                        disabled={text === ''}
                        onClick={() => { copyField(entry.field, text) }}
                      >
                        {copied?.field === entry.field ? (copied.ok ? '已复制' : '复制失败') : '复制'}
                      </button>
                    </div>
                  ) : control}
                  <span style={HINT}>{entry.hint}</span>
                </div>
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
            <p style={{ ...HINT, color: 'var(--dsw-alias-state-error-primary)' }}>{state.failure}</p>
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
      ) : null}
    </li>
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
