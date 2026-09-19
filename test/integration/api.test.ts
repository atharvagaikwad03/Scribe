import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTempRepo,
  PY_PACKAGE_FILES,
  TS_PACKAGE_FILES,
  type TempRepo,
} from '../helpers/repo.js';
import { plan, apply } from '../../src/engine/index.js';
import { loadConfig } from '../../src/config/load.js';
import { parseReadme } from '../../src/markdown/markers.js';
import { run } from '../../src/git/index.js';

const CONFIG = 'version: 1\nsections:\n  changelog: { enabled: false }\n';

async function runPlan(repo: TempRepo) {
  const { config } = await loadConfig(repo.root);
  return plan({ repoRoot: repo.root, config });
}
const body = (readme: string, id: string) =>
  parseReadme(readme).regions.find((r) => r.id === id)!.body;
const statuses = (p: Awaited<ReturnType<typeof runPlan>>) =>
  Object.fromEntries(p.packages[0]!.sections.map((s) => [s.id, s.status]));

describe('api + structure on a TypeScript package', () => {
  let repo: TempRepo;
  beforeEach(async () => {
    repo = await createTempRepo({ ...TS_PACKAGE_FILES, '.readme-sync.yml': CONFIG });
  });
  afterEach(() => repo.cleanup());

  it('extracts exports, CLI commands and entry points; persists the surface snapshot', async () => {
    const p = await runPlan(repo);
    expect(p.flags).toEqual([]);
    const res = await apply(p);
    expect(res.written).toContain('.readme-sync/api-surface.json');
    const readme = await repo.read('README.md');
    const api = body(readme, 'api');
    expect(api).toContain('`greet(name: string, punctuation?: string): string`');
    expect(api).toContain('class Greeter(name: string) { hello(opts?: Options): string }');
    expect(api).toContain("`type Mode = 'a' \\| 'b';`");
    expect(api).toContain('interface Options { loud?: boolean; }');
    expect(api).toContain('`greet <name>`');
    expect(api).toContain('fixture (dist/cli.js)');
    expect(api).not.toContain('internal'); // `_internal` alias is still exported; ensure named as exported
    const structure = body(readme, 'structure');
    expect(structure).toContain('TypeScript');
    expect(structure).toContain('`bin:fixture`');
    expect(structure).toContain('src/  (3 files)');
    const surface = JSON.parse(await repo.read('.readme-sync/api-surface.json'));
    // Sorted by category (cli < export) then name, so the snapshot is byte-stable.
    expect(surface.items.map((i: any) => `${i.category}:${i.name}`)).toEqual([
      'cli:fixture',
      'cli:greet',
      'cli:version',
      'export:greet',
      'export:Greeter',
      'export:Mode',
      'export:Options',
      'export:VERSION',
    ]);
  });

  it('surgical: a new exported function changes only the api section; snapshot diff records the addition', async () => {
    await apply(await runPlan(repo));
    await repo.commit('chore: readme-sync');
    const before = await repo.read('README.md');
    await repo.write({
      'src/greet.ts':
        (await repo.read('src/greet.ts')) +
        '\nexport function farewell(name: string): string {\n  return `Bye, ${name}`;\n}\n',
      'src/index.ts': (await repo.read('src/index.ts')).replace(
        "export { greet } from './greet.js';",
        "export { greet, farewell } from './greet.js';",
      ),
    });
    await repo.commit('feat: farewell');
    const p = await runPlan(repo);
    expect(statuses(p)).toMatchObject({
      api: 'update',
      structure: 'unchanged',
      commands: 'unchanged',
      dependencies: 'unchanged',
    });
    // Only api was affected by the diff: structure is not claimed for modifications.
    expect(p.packages[0]!.sections.find((s) => s.id === 'structure')!.reason).toBe(
      'no watched files changed',
    );
    await apply(p);
    const after = await repo.read('README.md');
    expect(body(after, 'api')).toContain('farewell(name: string): string');
    for (const id of ['structure', 'commands', 'dependencies'])
      expect(body(after, id)).toBe(body(before, id));
    const surface = JSON.parse(await repo.read('.readme-sync/api-surface.json'));
    expect(surface.items.some((i: any) => i.name === 'farewell')).toBe(true);
  });

  it('an internal refactor with an unchanged surface produces no README diff and no snapshot write', async () => {
    await apply(await runPlan(repo));
    await repo.commit('chore: readme-sync');
    const snapshot = await repo.read('.readme-sync/api-surface.json');
    await repo.write({
      'src/greet.ts': (await repo.read('src/greet.ts')).replace(
        'return `Hello, ${name}${punctuation}`;',
        'const msg = `Hello, ${name}${punctuation}`;\n  return msg;',
      ),
    });
    await repo.commit('refactor: greet');
    const p = await runPlan(repo);
    expect(statuses(p).api).toBe('unchanged');
    expect(p.packages[0]!.sections.find((s) => s.id === 'api')!.reason).toBe('inputs unchanged');
    expect(p.changed).toBe(false);
    const res = await apply(p);
    expect(res.written).toEqual(['.readme-sync/state.json']); // lastSha advanced only
    expect(await repo.read('.readme-sync/api-surface.json')).toBe(snapshot);
  });

  it('a new top-level directory updates structure only', async () => {
    await apply(await runPlan(repo));
    await repo.commit('chore: readme-sync');
    await repo.write({ 'docs/guide.md': '# Guide\n' });
    await repo.commit('docs: guide');
    const p = await runPlan(repo);
    expect(statuses(p)).toMatchObject({
      structure: 'update',
      api: 'unchanged',
      commands: 'unchanged',
      dependencies: 'unchanged',
    });
    expect(p.flags).toEqual([]);
    await apply(p);
    expect(body(await repo.read('README.md'), 'structure')).toContain('docs/  (1 file)');
  });

  it('fails closed on a dynamically registered route in a changed file', async () => {
    await apply(await runPlan(repo));
    await repo.commit('chore: readme-sync');
    await repo.write({
      'src/routes.ts':
        "import express from 'express';\nexport const app = express();\nconst prefix = '/v' + 2;\napp.get(prefix + '/items', () => {});\napp.get('/health', () => {});\n",
    });
    await repo.commit('feat: routes');
    const p = await runPlan(repo);
    const api = p.packages[0]!.sections.find((s) => s.id === 'api')!;
    expect(api.status).toBe('flagged');
    expect(p.flags.map((f) => f.reason)).toEqual(['low-confidence']);
    expect(p.flags[0]!.message).toMatch(/src\/routes\.ts/);
    expect(p.flags[0]!.files).toContain('src/routes.ts');
    const before = await repo.read('README.md');
    await apply(p);
    expect(body(await repo.read('README.md'), 'api')).toBe(body(before, 'api'));
  });
});

describe('api on a Python package', () => {
  let repo: TempRepo;
  let hasPython = false;
  beforeEach(async () => {
    const r = await run('python3', ['-c', 'import sys; print(sys.version_info >= (3, 9))'], {
      cwd: process.cwd(),
      allowFailure: true,
    }).catch(() => undefined);
    hasPython = !!r && r.code === 0 && r.stdout.trim() === 'True';
    repo = await createTempRepo({ ...PY_PACKAGE_FILES, '.readme-sync.yml': CONFIG });
  });
  afterEach(() => repo.cleanup());

  it('extracts __all__ exports (following relative imports), click commands and FastAPI endpoints', async (ctx) => {
    if (!hasPython) return ctx.skip();
    const p = await runPlan(repo);
    expect(p.flags).toEqual([]);
    await apply(p);
    const api = body(await repo.read('README.md'), 'api');
    expect(api).toContain('def add(a: int, b: int=0) -> int');
    expect(api).toContain('class Widget { render(self, indent: int=0) -> str }');
    expect(api).toContain("VERSION = '0.4.0'");
    expect(api).not.toContain('_private');
    expect(api).toContain('list-things');
    expect(api).toContain('| GET | `/items` |');
    expect(api).toContain('| POST | `/items/{item_id}` |');
    const structure = body(await repo.read('README.md'), 'structure');
    expect(structure).toContain('FastAPI');
    expect(structure).toContain('`script:fixture`');
  });

  it('a signature change is recorded as "changed" in the surface diff', async (ctx) => {
    if (!hasPython) return ctx.skip();
    await apply(await runPlan(repo));
    await repo.commit('chore: readme-sync');
    await repo.write({
      'src/fixture_py/core.py': (await repo.read('src/fixture_py/core.py')).replace(
        'def add(a: int, b: int = 0) -> int:',
        'def add(a: int, b: int = 0, *, strict: bool = False) -> int:',
      ),
    });
    await repo.commit('feat!: add strict');
    const p = await runPlan(repo);
    expect(statuses(p).api).toBe('update');
    await apply(p);
    expect(body(await repo.read('README.md'), 'api')).toContain('strict: bool=False');
  });
});
