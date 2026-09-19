import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'cli/index': 'src/cli/index.ts',
  },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  sourcemap: true,
  clean: false, // dist/action is committed and built separately; never wipe it
  dts: { entry: { index: 'src/index.ts' } },
  splitting: false,
  shims: true,
});
