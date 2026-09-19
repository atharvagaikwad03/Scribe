import { defineConfig } from 'tsup';

// Bundles the GitHub Action entry into a single self-contained file so the
// Action runs without `node_modules` present on the runner.
export default defineConfig({
  entry: { 'action/index': 'src/action/main.ts' },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  sourcemap: false,
  minify: true,
  clean: false,
  dts: false,
  splitting: false,
  shims: true,
  noExternal: [/.*/],
  // CJS dependencies (@actions/*) call require() at runtime; provide one in the ESM bundle.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  // `typescript` is large; keep it external-free by bundling, but mark the
  // dynamic requires it performs as safe to ignore.
  esbuildOptions(options) {
    options.mainFields = ['module', 'main'];
  },
});
