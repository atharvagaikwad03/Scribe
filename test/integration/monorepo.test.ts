import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempRepo, readmeWith, type TempRepo } from '../helpers/repo.js';
import { plan, apply } from '../../src/engine/index.js';
import { loadConfig } from '../../src/config/load.js';
import { resolvePackages } from '../../src/config/packages.js';
import { parseReadme } from '../../src/markdown/markers.js';
import { init } from '../../src/cli/init.js';

const pkgJson = (name: string, deps: Record<string, string> = {}) =>
  JSON.stringify(
    {
      name,
      version: '0.1.0',
      description: `${name} package`,
      main: 'src/index.ts',
      scripts: { test: 'vitest run' },
      dependencies: deps,
    },
    null,
    2,
  );

const SECTIONS_ONLY_A_AND_D =
  'sections:\n  structure: { enabled: false }\n  changelog: { enabled: false }\n  commands: { enabled: false }\n';

describe('monorepo (npm workspaces)', () => {
  let repo: TempRepo;
  beforeEach(async () => {
    repo = await createTempRepo({
      'package.json': JSON.stringify(
        { name: 'mono', private: true, workspaces: ['packages/*'] },
        null,
        2,
      ),
      'packages/a/package.json': pkgJson('@mono/a', { zod: '^3.0.0' }),
      'packages/a/src/index.ts': 'export function a(): number { return 1; }\n',
      'packages/a/README.md': readmeWith(['api', 'dependencies']),
      'packages/b/package.json': pkgJson('@mono/b'),
      'packages/b/src/index.ts': 'export function b(): number { return 2; }\n',
      'packages/b/README.md': readmeWith(['api', 'dependencies']),
      'README.md':
        '# mono\n\nRoot prose.\n\n## Packages\n\n<!-- autogen:start:packages -->\n<!-- autogen:end:packages -->\n',
      '.readme-sync.yml': `version: 1\n${SECTIONS_ONLY_A_AND_D}`,
    });
  });
  afterEach(() => repo.cleanup());

  it('discovers workspaces, gives each package its own README/state, and renders the root packages table', async () => {
    const { config } = await loadConfig(repo.root);
    const pkgs = await resolvePackages(repo.root, config);
    expect(pkgs.map((p) => p.path)).toEqual(['.', 'packages/a', 'packages/b']);
    expect(pkgs[0]!.sections.packages.enabled).toBe(true);
    expect(pkgs[0]!.sections.api.enabled).toBe(false);

    const p = await plan({ repoRoot: repo.root, config });
    expect(p.flags).toEqual([]);
    const res = await apply(p);
    expect(res.written).toEqual(
      expect.arrayContaining([
        'README.md',
        '.readme-sync/state.json',
        'packages/a/README.md',
        '.readme-sync/packages/packages__a/state.json',
        '.readme-sync/packages/packages__a/api-surface.json',
        'packages/b/README.md',
        '.readme-sync/packages/packages__b/state.json',
      ]),
    );
    const root = await repo.read('README.md');
    expect(root).toContain('[`@mono/a`](packages/a/README.md)');
    expect(root).toContain('| `packages/b` |');
    expect(root).toContain('Root prose.');
    expect(await repo.read('packages/a/README.md')).toContain('a(): number');
    expect(await repo.read('packages/b/README.md')).toContain('b(): number');
  });

  it('a change in package A leaves package B README and state untouched', async () => {
    const { config } = await loadConfig(repo.root);
    await apply(await plan({ repoRoot: repo.root, config }));
    await repo.commit('chore: readme-sync\n\nreadme-sync: auto');
    const bReadme = await repo.read('packages/b/README.md');
    const bState = await repo.read('.readme-sync/packages/packages__b/state.json');
    const rootReadme = await repo.read('README.md');

    await repo.write({
      'packages/a/src/index.ts':
        'export function a(x: number): number { return x; }\nexport const A = 1;\n',
    });
    await repo.commit('feat(a): widen a');
    const p = await plan({ repoRoot: repo.root, config });
    const byPkg = Object.fromEntries(p.packages.map((pp) => [pp.pkg.path, pp]));
    expect(byPkg['packages/a']!.readmeChanged).toBe(true);
    expect(byPkg['packages/b']!.readmeChanged).toBe(false);
    // B only sees its own README from the tool commit (ignored); A's files are not visible to B at all.
    expect(byPkg['packages/b']!.files.map((f) => [f.file.path, f.outcome.kind])).toEqual([
      ['README.md', 'ignored'],
    ]);
    expect(byPkg['.']!.readmeChanged).toBe(false);
    // The root sees A's file but it is owned by A, so it is ignored rather than unmapped.
    expect(byPkg['.']!.files.every((f) => f.outcome.kind === 'ignored')).toBe(true);
    expect(
      byPkg['.']!.files.find((f) => f.file.path === 'packages/a/src/index.ts')!.outcome,
    ).toEqual({ kind: 'ignored', by: 'owned by package packages/a' });
    const res = await apply(p);
    expect(res.written).not.toContain('packages/b/README.md');
    expect(await repo.read('packages/b/README.md')).toBe(bReadme);
    expect(await repo.read('.readme-sync/packages/packages__b/state.json')).not.toBe(bState); // lastSha advanced only
    expect(
      JSON.parse(await repo.read('.readme-sync/packages/packages__b/state.json')).sections,
    ).toEqual(JSON.parse(bState).sections);
    expect(await repo.read('README.md')).toBe(rootReadme);
    expect(
      parseReadme(await repo.read('packages/a/README.md')).regions.find((r) => r.id === 'api')!
        .body,
    ).toContain('a(x: number): number');
  });

  it('a new workspace package updates the root packages table', async () => {
    const { config } = await loadConfig(repo.root);
    await apply(await plan({ repoRoot: repo.root, config }));
    await repo.commit('chore: readme-sync\n\nreadme-sync: auto');
    await repo.write({
      'packages/c/package.json': pkgJson('@mono/c'),
      'packages/c/src/index.ts': 'export const c = 3;\n',
    });
    await repo.commit('feat: package c');
    // New package has no README yet: init adds one with markers.
    await init({ repoRoot: repo.root, adopt: false, dryRun: false });
    const p = await plan({ repoRoot: repo.root, config });
    expect(
      p.packages.find((pp) => pp.pkg.path === '.')!.sections.find((s) => s.id === 'packages')!
        .status,
    ).toBe('update');
    await apply(p);
    expect(await repo.read('README.md')).toContain('`@mono/c`');
    expect(await repo.read('packages/c/README.md')).toContain('c: 3');
  });

  it('explicit packages config wins over discovery', async () => {
    await repo.write({
      '.readme-sync.yml': `version: 1\n${SECTIONS_ONLY_A_AND_D}packages:\n  - path: packages/b\n    sections:\n      dependencies: { enabled: false }\n`,
    });
    const { config } = await loadConfig(repo.root);
    const pkgs = await resolvePackages(repo.root, config);
    expect(pkgs.map((p) => p.path)).toEqual(['packages/b']);
    expect(pkgs[0]!.sections.dependencies.enabled).toBe(false);
  });
});
