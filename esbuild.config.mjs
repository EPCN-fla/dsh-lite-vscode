import { build, context } from 'esbuild'

const watch = process.argv.includes('--watch')

/** @type {import('esbuild').BuildOptions} */
const extension = {
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.mjs',
  format: 'esm',
  platform: 'node',
  target: 'node22',
  bundle: true,
  sourcemap: true,
  minify: !watch,
  external: ['vscode'],
  // Prefer ESM builds of deps; provide createRequire for any CJS stragglers
  // (e.g. yaml's CJS dist calling require('process')).
  mainFields: ['module', 'main'],
  banner: {
    js: "import { createRequire as __dshCreateRequire } from 'node:module'; const require = __dshCreateRequire(import.meta.url)",
  },
  logLevel: 'info',
}

/** @type {import('esbuild').BuildOptions} */
const webview = {
  entryPoints: ['src/webview/main.tsx'],
  outfile: 'dist/webview.js',
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  bundle: true,
  sourcemap: true,
  minify: !watch,
  logLevel: 'info',
}

if (watch) {
  const ctxs = await Promise.all([context(extension), context(webview)])
  await Promise.all(ctxs.map(c => c.watch()))
  console.log('[esbuild] watching…')
} else {
  await Promise.all([build(extension), build(webview)])
}
