/**
 * Behavioural check for the sync section, the browser half.
 *
 * The bundle is a CommonJS factory the shell materializes against its frozen
 * module table, so this test materializes it the same way: a table holding the
 * nine words the shell seeds, a React stand-in carrying the three hooks the
 * section uses, and a JSX factory that records elements. No DOM, no react-dom,
 * no jsdom — the section's markup is asserted from those element records, and
 * its interaction is asserted by calling the handlers it rendered.
 *
 * What it covers: the page view renders the fields and the controls directly,
 * the summary view is the one-liner, a staged edit marks the section and a
 * Host-confirmed save clears it, a refused save says so, list fields save as
 * arrays, an unconfigured or read-only deployment says so in place, the saved
 * secret is never expected back and an empty secret input keeps it, clearing
 * the pair writes both fields empty, and the masked field can be revealed and
 * copied through the host clipboard.
 *
 * Run with `node test/card.mjs` after `pnpm build`.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE = join(PACKAGE_DIR, 'lib', 'client.js')

/** The shell's frozen module table (packages/client/web/src/seed.ts). */
const BASELINE = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

/** Field count the card renders, from `FIELDS` in the client half. */
const FIELDS = 10

/** Marks an object the stubbed JSX factory produced. */
const ELEMENT = Symbol('element')

/**
 * Record one element, the way the automatic JSX runtime does.
 * @param type - the element type.
 * @param props - its props, with children among them.
 * @returns the element record.
 */
function element(type, props) {
  return { [ELEMENT]: true, type, props: props ?? {} }
}

/** Every child of an element or node, flattened, minus the empty ones. */
function childrenOf(node) {
  const children = node.props?.children
  const list = Array.isArray(children) ? children.flat(Infinity) : [children]
  return list.filter(child => child !== undefined && child !== null && child !== false)
}

/**
 * Every element of one type, depth first.
 * @param node - the element to search.
 * @param type - the element type to collect.
 * @returns the matching elements.
 */
function findAll(node, type) {
  if (node === null || typeof node !== 'object' || node[ELEMENT] !== true) return []
  const found = node.type === type ? [node] : []
  for (const child of childrenOf(node)) found.push(...findAll(child, type))
  return found
}

/**
 * The text an element renders, concatenated.
 * @param node - the element to read.
 * @returns its text.
 */
function textOf(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (node === null || typeof node !== 'object' || node[ELEMENT] !== true) return ''
  return childrenOf(node).map(child => textOf(child)).join('')
}

/** Every form control the section renders. */
function controlsOf(tree) {
  return [...findAll(tree, 'input'), ...findAll(tree, 'select')]
}

/**
 * A React stand-in with exactly the hooks the card calls. Element records are
 * returned through a plain JSX factory, so a render is a function call plus the
 * effects whose dependencies moved.
 * @returns the hook API and `render`, which settles the card before returning.
 */
function fakeReact() {
  const slots = []
  const deps = []
  let cursor = 0
  let pending = []
  let stateChanged = false
  const api = {
    useState(initial) {
      const index = cursor++
      slots[index] ??= typeof initial === 'function' ? initial() : initial
      return [slots[index], (next) => {
        slots[index] = typeof next === 'function' ? next(slots[index]) : next
        stateChanged = true
      }]
    },
    useRef(initial) {
      const index = cursor++
      slots[index] ??= { current: initial }
      return slots[index]
    },
    useEffect(effect, next) {
      pending.push({ index: cursor++, effect, deps: next })
    },
  }
  const jsx = (type, props) => element(type, props)
  return {
    api,
    jsxRuntime: { jsx, jsxs: jsx, Fragment: Symbol('Fragment') },
    /**
     * Call the component and flush effects until it stops changing.
     * @param component - the card.
     * @param props - the props the renderer would bind.
     * @returns the element tree.
     */
    render(component, props) {
      for (let pass = 0; pass < 12; pass += 1) {
        cursor = 0
        pending = []
        stateChanged = false
        const tree = component(props)
        for (const entry of pending) {
          const previous = deps[entry.index]
          if (previous !== undefined && previous.every((value, index) => Object.is(value, entry.deps?.[index]))) continue
          deps[entry.index] = entry.deps
          entry.effect()
        }
        if (!stateChanged) return tree
      }
      throw new Error('the card did not settle')
    },
  }
}

/**
 * Load the built bundle and materialize its factory against a table.
 * @param table - module specifier to exports.
 * @returns the bundle's exports.
 */
async function materialize(table) {
  let factory
  const previousWindow = globalThis.window
  globalThis.window = { __ModuleLoader__: { load: (record) => { factory = record.factory } } }
  try {
    await import(`${new URL(`file://${BUNDLE}`).href}?test=${String(Date.now())}`)
  } finally {
    globalThis.window = previousWindow
  }
  assert.ok(factory !== undefined, 'the bundle should register exactly one factory')
  const require = (specifier) => {
    if (!(specifier in table)) throw new Error(`${specifier} is not in the shell's module table`)
    return table[specifier]
  }
  return factory(require)
}

/**
 * A `ctx.configForms` stand-in with the members the card's controller uses:
 * the entry's form, and the describe mirror that carries the secret slots.
 * Like the Host, it never sends the secret back.
 */
function fakeForms(value, options = {}) {
  let secretSet = options.secretSaved ?? false
  let snapshot = {
    status: 'ready', writable: options.writable ?? true, value, user: {}, base: {}, revision: 0, mode: 'host',
  }
  const listeners = new Set()
  /** Every mutation the card sent, in order. */
  const sent = []
  const directory = () => ({
    status: 'ready',
    error: null,
    view: {
      writable: true,
      hasDocument: true,
      namespaces: [{ ns: 'oss-settings', secrets: [{ path: ['secretAccessKey'], set: secretSet }] }],
    },
  })
  const settle = (operations) => {
    sent.push(operations)
    if (options.refuse === true) return false
    const next = { ...snapshot.value }
    for (const operation of operations) {
      if (operation.path[0] === 'secretAccessKey') {
        secretSet = operation.op === 'set' && operation.value !== ''
        continue
      }
      if (operation.op === 'set') next[operation.path[0]] = operation.value
      else delete next[operation.path[0]]
    }
    snapshot = { ...snapshot, value: next, user: next, revision: snapshot.revision + 1 }
    for (const listener of [...listeners]) listener()
    return true
  }
  const subscribe = (listener) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }
  return {
    sent,
    form: {
      getSnapshot: () => snapshot,
      subscribe,
      mutate: async operations => settle(operations),
      set: async (key, next) => settle([{ op: 'set', path: [key], value: next }]),
      unset: async key => settle([{ op: 'unset', path: [key] }]),
    },
    directory: { getSnapshot: directory, subscribe, ensure: async () => {}, acceptView: () => {} },
  }
}

/**
 * Mount the section the way the shell does: through the plugin's `apply`,
 * against a ctx stub, then render the registered component with the face it
 * injected.
 * @param value - the settings namespace document to serve.
 * @param scopeOverrides - extra scope fields, such as `writable: false`.
 * @returns the rendered tree and the face, for driving interaction.
 */
async function mountCard(value = {}, formOptions = {}) {
  const react = fakeReact()
  const forms = fakeForms(value, formOptions)
  /** Text the section handed to the host clipboard, in order. */
  const clipboard = []
  const module = await materialize({
    'react': react.api,
    'react/jsx-runtime': react.jsxRuntime,
    '@deepseek-ai/dsh-client-ui-primitives': {
      Tag: (props) => element('span', { 'data-tag': props.tone, children: props.children }),
      writeClipboard: async (text) => { clipboard.push(text); return true },
    },
  })
  let registration
  const ctx = {
    configForms: {
      get: (entry) => {
        assert.equal(entry, 'oss-settings', 'the section should edit the sync entry')
        return forms.form
      },
      describe: () => forms.directory,
    },
    effect: (effect) => { effect() },
    slots: {
      register: (spec, component) => ({ spec, component }),
      inject: (_name, factory) => { for (const entry of factory()) registration = entry },
    },
  }
  module.apply(ctx)
  assert.ok(registration !== undefined, 'apply should register a plugins.bundle.config entry')
  assert.equal(registration.spec.name, 'plugins.bundle.config', 'the section should register into the Plugins page')
  assert.equal(registration.spec.key, 'dsh-oss-sync', 'the entry should key on the bundle\'s package name')
  const face = registration.spec.inject()
  const props = { ...face, useOssSyncCard: selector => selector(face.hooks.ossSyncCard.getSnapshot()) }
  return {
    face,
    forms,
    clipboard,
    render: (view = 'page') => react.render(registration.component, { ...props, view }),
  }
}

/** Let the controller's awaited writes settle before the next render. */
async function settle() {
  await new Promise(resolve => { setTimeout(resolve, 0) })
}

// The invariant this change puts at risk: a new import has to be a word the
// shell seeds, or the factory throws at materialization in the browser.
const specifiers = [...new Set([...readFileSync(BUNDLE, 'utf8').matchAll(/require\("([^"]+)"\)/gu)].map(match => match[1]))]
for (const specifier of specifiers) {
  assert.ok(BASELINE.includes(specifier), `the bundle requires ${specifier}, which the shell does not seed`)
}
console.log(`ok  bundle: every require (${specifiers.join(', ')}) is in the shell's module table`)

const card = await mountCard()
let tree = card.render()
assert.equal(controlsOf(tree).length, FIELDS, 'the page view should render every field')
assert.match(textOf(tree), /OSS 同步/u, 'the section should name itself')
assert.match(textOf(tree), /保存/u, 'the controls should appear with the fields')
console.log(`ok  section: the page view renders ${String(FIELDS)} fields and the controls`)

tree = card.render('summary')
assert.equal(controlsOf(tree).length, 0, 'the summary view should render no fields')
assert.match(textOf(tree), /S3/u, 'the summary view should be the one-liner')
console.log('ok  section: the summary view is the one-liner alone')

card.face.edit('bucket', 'my-dsh')
tree = card.render()
assert.match(textOf(tree), /未保存/u, 'a staged edit should mark the section')
console.log('ok  section: a staged edit is marked')

card.face.save()
await settle()
tree = card.render()
assert.doesNotMatch(textOf(tree), /未保存/u, 'a confirmed save should clear the marker')
assert.equal(card.forms.form.getSnapshot().value['bucket'], 'my-dsh', 'the save should reach the entry')
console.log('ok  section: a Host-confirmed save clears the marker')

card.face.edit('exclude', 'pwsh-sandbox, ui-theme ,')
card.face.save()
await settle()
assert.deepEqual(card.forms.form.getSnapshot().value['exclude'], ['pwsh-sandbox', 'ui-theme'],
  'a list field should save as an array of entry ids')
assert.equal(findAll(card.render(), 'input').find(input => input.props.id === 'oss-sync-exclude').props.value,
  'pwsh-sandbox, ui-theme', 'a list field should render as comma-separated text')
console.log('ok  section: list fields save as arrays')

const refused = await mountCard({}, { refuse: true })
refused.face.edit('bucket', 'x')
refused.face.save()
await settle()
assert.match(textOf(refused.render()), /宿主拒绝/u, 'a refused save should say so')
assert.match(textOf(refused.render()), /未保存/u, 'a refused save keeps the staged edit')
console.log('ok  section: a save the Host refuses is legible in place')

const localOnly = await mountCard({ status: { settings: { configured: false } } })
assert.match(textOf(localOnly.render()), /仅本机/u, 'an unconfigured deployment should say so in place')
const readOnly = await mountCard({}, { writable: false })
assert.match(textOf(readOnly.render()), /只读/u, 'a read-only deployment should say so in place')
console.log('ok  section: an unconfigured or read-only deployment is legible in place')

// Chromium refuses to copy out of `input[type=password]`, so the masked field
// carries both halves of the affordance: reveal it, or copy it without
// unmasking it. Either way the value reaches the reader.
// The Host never sends a saved secret: the field says one is saved, and an
// empty input keeps it.
const saved = await mountCard({ accessKeyId: 'AKIA-SAVED' }, { secretSaved: true })
const savedInput = findAll(saved.render(), 'input').find(input => input.props.id === 'oss-sync-secretAccessKey')
assert.equal(savedInput.props.value, '', 'a saved secret never reaches the page')
assert.match(savedInput.props.placeholder, /已保存/u, 'the field says a secret is saved')
saved.face.edit('bucket', 'b2')
saved.face.save()
await settle()
assert.deepEqual(saved.forms.sent.at(-1), [{ op: 'set', path: ['bucket'], value: 'b2' }],
  'saving with the secret untouched neither sends nor clears it')
saved.face.clearPair()
await settle()
assert.deepEqual(saved.forms.sent.at(-1), [
  { op: 'set', path: ['accessKeyId'], value: '' },
  { op: 'set', path: ['secretAccessKey'], value: '' },
], 'clearing writes the explicitly empty pair the host reads as a request to forget it')
assert.equal(findAll(saved.render(), 'input').find(input => input.props.id === 'oss-sync-secretAccessKey').props.placeholder,
  undefined, 'after clearing, no secret is saved')
console.log('ok  card: the saved secret stays on the Host, and clearing the pair is explicit')

const masked = await mountCard({ accessKeyId: 'AKIA-TYPED' })
masked.face.edit('secretAccessKey', 'sk-live-secret')
let maskedTree = masked.render()
const secretInput = (tree) => findAll(tree, 'input').find(input => input.props.id === 'oss-sync-secretAccessKey')
const labelled = (tree, label) => findAll(tree, 'button').find(button => button.props['aria-label'] === label)
assert.equal(secretInput(maskedTree).props.type, 'password', 'the secret should arrive masked')

labelled(maskedTree, '显示：对象存储 AccessKey Secret').props.onClick()
maskedTree = masked.render()
assert.equal(secretInput(maskedTree).props.type, 'text', 'reveal should unmask the field')
assert.match(textOf(maskedTree), /隐藏/u, 'the reveal control should offer to re-mask')
console.log('ok  card: the masked field can be revealed in place')

labelled(maskedTree, '复制：对象存储 AccessKey Secret').props.onClick()
await settle()
maskedTree = masked.render()
assert.deepEqual(masked.clipboard, ['sk-live-secret'], 'copy should hand the typed secret to the host clipboard')
assert.match(textOf(maskedTree), /已复制/u, 'copy should confirm itself'
)
assert.equal(secretInput(maskedTree).props.type, 'text', 'copy should not re-mask the field mid-read')
console.log('ok  card: the masked field copies through the host clipboard')

console.log('\nall card checks passed')
