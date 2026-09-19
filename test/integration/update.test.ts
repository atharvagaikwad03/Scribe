import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempRepo, readmeWith, TS_PACKAGE_FILES, type TempRepo } from '../helpers/repo.js';
import { plan, apply } from '../../src/engine/index.js';
import { loadConfig } from '../../src/config/load.js';
import { parseReadme } from '../../src/markdown/markers.js';

const CONFIG = `version: 1
sections:
  structure: { enabled: false }
  api: { enabled: false }
  changelog: { enabled: false }
`;

async function run(repo: TempRepo, extra: Record<string, unknown> = {}) {
  const { config } = await loadConfig(repo.root);
  const p = await plan({ repoRoot: repo.root, config, ...extra });
  return p;
}

function outside(src: string): string {
  const parsed = parseReadme(src);
  let s = '';
  let cursor = 0;
  for (const r of parsed.regions) {
    s += src.slice(cursor, r.start) + `<${r.id}>`;
    cursor = r.end;
  }
  return s + src.slice(cursor);
}

describe('update: commands + dependencies on a TS package', () => {
  let repo: TempRepo;
  beforeEach(async () => {
    repo = await createTempRepo({
      ...TS_PACKAGE_FILES,
      'README.md': readmeWith(['commands', 'dependencies']),
      '.readme-sync.yml': CONFIG,
    });
  });
  afterEach(() => repo.cleanup());

  it('first run regenerates both sections, keeps human bytes, records state', async () => {
    const before = await repo.read('README.md');
    const p = await run(repo);
    expect(p.packages[0]!.fullMode).toBe(true);
    expect(p.packages[0]!.sections.map((s) => [s.id, s.status])).toEqual(
      expect.arrayContaining([
        ['commands', 'update'],
        ['dependencies', 'update'],
        ['structure', 'disabled'],
      ]),
    );
    expect(p.flags).toEqual([]);
    const res = await apply(p);
    expect(res.written).toEqual(['.readme-sync/state.json', 'README.md']);

    const after = await repo.read('README.md');
    expect(outside(after)).toBe(outside(before));
    expect(after).toContain('pnpm install');
    expect(after).toContain('`pnpm test`');
    expect(after).toContain('`make build`');
    expect(after).toContain('Build the project');
    expect(after).not.toContain('internal-target'); // only `##`-documented targets when any exist
    expect(after).toContain('`zod`');
    expect(after).toContain('3.23.8'); // resolved from lockfile
    expect(after).toContain('node dist/index.js'); // Dockerfile CMD

    const state = JSON.parse(await repo.read('.readme-sync/state.json'));
    expect(state.lastSha).toBe(await repo.git.headSha());
    expect(Object.keys(state.sections).sort()).toEqual(['commands', 'dependencies']);
  });

  it('is idempotent: a second run is a no-op', async () => {
    await apply(await run(repo));
    const readme = await repo.read('README.md');
    const state = await repo.read('.readme-sync/state.json');
    const p2 = await run(repo);
    expect(p2.changed).toBe(false);
    expect(p2.packages[0]!.sections.filter((s) => s.status === 'update')).toEqual([]);
    const res = await apply(p2);
    expect(res.written).toEqual([]);
    expect(await repo.read('README.md')).toBe(readme);
    expect(await repo.read('.readme-sync/state.json')).toBe(state);
  });

  it('surgical scope: a dependency bump touches only the dependencies section', async () => {
    await apply(await run(repo));
    await repo.commit('chore: readme-sync');
    const readmeBefore = await repo.read('README.md');
    const pkg = JSON.parse(await repo.read('package.json'));
    pkg.dependencies.zod = '^3.24.0';
    await repo.write({ 'package.json': JSON.stringify(pkg, null, 2) });
    await repo.commit('chore: bump zod');

    const p = await run(repo);
    expect(p.packages[0]!.fullMode).toBe(false);
    const byId = Object.fromEntries(p.packages[0]!.sections.map((s) => [s.id, s]));
    // package.json is watched by both, but commands' extracted data did not change.
    expect(byId.commands!.status).toBe('unchanged');
    expect(byId.commands!.reason).toBe('inputs unchanged');
    expect(byId.dependencies!.status).toBe('update');
    await apply(p);
    const readmeAfter = await repo.read('README.md');
    const b = parseReadme(readmeBefore);
    const a = parseReadme(readmeAfter);
    expect(a.regions.find((r) => r.id === 'commands')!.body).toBe(
      b.regions.find((r) => r.id === 'commands')!.body,
    );
    expect(a.regions.find((r) => r.id === 'dependencies')!.body).toContain('^3.24.0');
    expect(outside(readmeAfter)).toBe(outside(readmeBefore));
  });

  it('an unrelated source change produces no README change and no flags', async () => {
    await apply(await run(repo));
    await repo.commit('chore: readme-sync');
    await repo.write({
      'src/greet.ts': (await repo.read('src/greet.ts')) + '\n// refactor comment\n',
    });
    await repo.commit('refactor: comment');
    const p = await run(repo);
    expect(p.changed).toBe(false);
    expect(p.flags).toEqual([]);
    // README.md and .readme-sync/** from the tool's own commit are ignored; src/greet.ts is not
    // surface relevant and no enabled section watches it -> unmapped but not flagged.
    const outcomes = p.packages[0]!.files.map((f) => [f.file.path, f.outcome.kind]);
    expect(outcomes).toEqual(
      expect.arrayContaining([
        ['README.md', 'ignored'],
        ['.readme-sync/state.json', 'ignored'],
        ['src/greet.ts', 'unmapped'],
      ]),
    );
  });

  it('--check semantics: plan.changed is true when README is stale, false after update', async () => {
    const p = await run(repo);
    expect(p.changed).toBe(true);
    await apply(p);
    expect((await run(repo)).changed).toBe(false);
  });

  it('manual edit inside a generated region is detected, flagged and preserved', async () => {
    await apply(await run(repo));
    const readme = await repo.read('README.md');
    const tampered = readme.replace('pnpm install', 'pnpm install # I edited this by hand');
    await repo.write({ 'README.md': tampered });
    const p = await run(repo);
    const cmd = p.packages[0]!.sections.find((s) => s.id === 'commands')!;
    expect(cmd.status).toBe('flagged');
    expect(p.flags.map((f) => f.reason)).toEqual(['manual-edit']);
    await apply(p);
    expect(await repo.read('README.md')).toBe(tampered);
    // lastSha did not advance because a flag was raised.
    expect(JSON.parse(await repo.read('.readme-sync/state.json')).lastSha).toBe(
      p.packages[0]!.stateBefore.lastSha,
    );

    // --force reclaims it
    const forced = await run(repo, { force: true });
    expect(forced.flags).toEqual([]);
    await apply(forced);
    expect(await repo.read('README.md')).not.toContain('I edited this by hand');
  });

  it('malformed markers are fatal for the package and nothing is written', async () => {
    await repo.write({ 'README.md': '# X\n\n<!-- autogen:start:commands -->\nno end marker\n' });
    const p = await run(repo);
    expect(p.packages[0]!.error).toMatch(/never closed/);
    expect(p.flags.map((f) => f.reason)).toEqual(['malformed-markers']);
    const res = await apply(p);
    expect(res.written).toEqual([]);
    expect(await repo.exists('.readme-sync/state.json')).toBe(false);
  });

  it('a configured section without a marker is flagged, other sections still update', async () => {
    await repo.write({ 'README.md': readmeWith(['commands']) });
    const p = await run(repo);
    expect(p.flags.map((f) => [f.section, f.reason])).toEqual([['dependencies', 'missing-marker']]);
    expect(p.packages[0]!.sections.find((s) => s.id === 'commands')!.status).toBe('update');
    await apply(p);
    expect(await repo.read('README.md')).toContain('pnpm install');
  });

  it('flags an unmapped surface-relevant file when its section is disabled', async () => {
    await repo.write({
      '.readme-sync.yml':
        CONFIG + '  dependencies: { enabled: false }\n  commands: { enabled: false }\n',
      'README.md': readmeWith([]),
    });
    await repo.commit('chore: disable');
    const state = {
      version: 1,
      toolVersion: 'x',
      lastSha: await repo.git.headSha(),
      sections: {},
      changelog: { entries: [], apiChanges: [] },
    };
    await repo.write({ '.readme-sync/state.json': JSON.stringify(state) });
    await repo.commit('chore: state');
    await repo.write({ 'pnpm-lock.yaml': (await repo.read('pnpm-lock.yaml')) + '# touched\n' });
    await repo.commit('chore: lock');
    const p = await run(repo);
    expect(p.flags).toHaveLength(1);
    expect(p.flags[0]!.reason).toBe('unmapped-surface-file');
    expect(p.flags[0]!.files).toEqual(['pnpm-lock.yaml']);
    expect(p.flags[0]!.message).toMatch(/lockfile/);
  });
});
