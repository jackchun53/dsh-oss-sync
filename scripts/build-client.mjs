#!/usr/bin/env node
/**
 * Build the browser half.
 *
 * The host serves a client bundle as a lazy CommonJS factory wrapped in
 * `window.__ModuleLoader__.load(...)`, not as an ES module: the combo route
 * concatenates several packages into one script, so a top-level `import` in
 * any of them would be invalid at that position and would take the whole
 * script down. tsc cannot emit that envelope, so this step bundles the client
 * entry with esbuild and wraps the result.
 *
 * Externals are exactly the browser's baseline module table; `require` inside
 * the factory is that table, which is why nothing is inlined.
 */

import { build } from 'esbuild'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const NAME = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8')).name

/** The shell's frozen module table; anything else must be bundled. */
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

const result = await build({
  entryPoints: [join(PACKAGE_DIR, 'src', 'client', 'index.tsx')],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external: BASELINE,
  logLevel: 'warning',
})

const body = result.outputFiles[0].text.trimEnd()
const bundle = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(NAME)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${body}
\t\treturn module.exports;
\t}
});
`

const output = join(PACKAGE_DIR, 'lib', 'client.js')
writeFileSync(output, bundle)
console.log(`client bundle: ${output} (${String(Buffer.byteLength(bundle))} bytes)`)
