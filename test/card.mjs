/**
 * Behavioural check for the sync card, the browser half.
 *
 * The bundle is a CommonJS factory the shell materializes against its frozen
 * module table, so this test materializes it the same way: a table holding the
 * nine words the shell seeds, a React stand-in carrying the three hooks the card
 * uses, and a JSX factory that records elements. No DOM, no react-dom, no jsdom
 * — the card's markup is asserted from those element records, and its
 * interaction is asserted by calling the handlers it rendered.
 *
 * What it covers: the card is collapsed on arrival, opening it discloses the
 * fields and the controls, a staged edit is visible while collapsed, a
 * Host-confirmed save closes it again, and an unconfigured deployment says so
 * without being opened.
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
const FIELDS = 8

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

/** The disclosure control: the only button carrying `aria-expanded`. */
function headerOf(tree) {
  const header = findAll(tree, 'button').find(button => button.props['aria-expanded'] !== undefined)
  assert.ok(header !== undefined, 'the card should render a disclosure header')
  return header
}

/** Every form control the card discloses. */
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

/** A settings scope stand-in with the members the card's controller uses. */
function fakeScope(value, options = {}) {
  let snapshot = { status: 'ready', writable: options.writable ?? true, value, user: {} }
  const listeners = new Set()
  const settle = (operations) => {
    const next = { ...snapshot.value }
    for (const operation of operations) {
      if (operation.op === 'set') next[operation.path[0]] = operation.value
      else delete next[operation.path[0]]
    }
    snapshot = { ...snapshot, value: next, user: next }
    for (const listener of [...listeners]) listener()
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    mutate: async (operations) => { settle(operations) },
    set: async (key, next) => { settle([{ op: 'set', path: [key], value: next }]) },
  }
}

/**
 * Mount the card the way the shell does: through the plugin's `apply`, against
 * a ctx stub, then render the registered component with the face it injected.
 * @param value - the settings namespace document to serve.
 * @param scopeOverrides - extra scope fields, such as `writable: false`.
 * @returns the rendered tree and the face, for driving interaction.
 */
async function mountCard(value = {}, scopeOverrides = {}) {
  const react = fakeReact()
  const scope = fakeScope(value, scopeOverrides)
  const module = await materialize({
    'react': react.api,
    'react/jsx-runtime': react.jsxRuntime,
    '@deepseek-ai/dsh-client-ui-primitives': {
      Tag: (props) => element('span', { 'data-tag': props.tone, children: props.children }),
      IconChevronDownOutline14: (props) => element('svg', { 'data-icon': 'chevron', ...props }),
    },
  })
  let registration
  const ctx = {
    settingsScope: { bind: () => scope },
    effect: (effect) => { effect() },
    slots: {
      register: (spec, component) => ({ spec, component }),
      inject: (_name, factory) => { for (const entry of factory()) registration = entry },
    },
  }
  module.apply(ctx)
  assert.ok(registration !== undefined, 'apply should register a settings.plugin.item card')
  const face = registration.spec.inject()
  const props = { ...face, useOssSyncCard: selector => selector(face.hooks.ossSyncCard.getSnapshot()) }
  return {
    face,
    scope,
    render: () => react.render(registration.component, props),
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
assert.equal(headerOf(tree).props['aria-expanded'], false, 'the card should arrive collapsed')
assert.equal(controlsOf(tree).length, 0, 'a collapsed card should render no fields')
assert.match(textOf(tree), /OSS 同步/u, 'a collapsed card should still name itself')
console.log('ok  card: collapsed on arrival, with no fields rendered')

headerOf(tree).props.onClick()
tree = card.render()
assert.equal(headerOf(tree).props['aria-expanded'], true, 'the header should open the card')
assert.equal(controlsOf(tree).length, FIELDS, 'every field should appear once open')
assert.match(textOf(tree), /保存/u, 'the controls should appear with the fields')
console.log(`ok  card: the header discloses ${String(FIELDS)} fields and the controls`)

card.face.edit('bucket', 'my-dsh')
tree = card.render()
assert.match(textOf(tree), /未保存/u, 'a staged edit should show while the card is open')
headerOf(tree).props.onClick()
tree = card.render()
assert.equal(controlsOf(tree).length, 0, 'the card should close on a second click')
assert.match(textOf(tree), /未保存/u, 'a staged edit should survive collapsing')
console.log('ok  card: a staged edit is marked on the header and survives collapsing')

card.face.save()
await settle()
tree = card.render()
assert.equal(headerOf(tree).props['aria-expanded'], false, 'a confirmed save should close the card')
assert.doesNotMatch(textOf(tree), /未保存/u, 'a confirmed save should clear the marker')
assert.equal(card.scope.getSnapshot().value['bucket'], 'my-dsh', 'the save should reach the namespace')
console.log('ok  card: a Host-confirmed save closes the card and clears the marker')

const localOnly = await mountCard({ status: { settings: { configured: false } } })
assert.match(textOf(localOnly.render()), /仅本机/u, 'an unconfigured deployment should say so while collapsed')
const readOnly = await mountCard({}, { writable: false })
assert.match(textOf(readOnly.render()), /只读/u, 'a read-only deployment should say so while collapsed')
console.log('ok  card: an unconfigured or read-only deployment is legible while collapsed')

console.log('\nall card checks passed')
