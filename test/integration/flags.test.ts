import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { createTempRepo, readmeWith, TS_PACKAGE_FILES, type TempRepo } from '../helpers/repo.js';
import { plan, apply } from '../../src/engine/index.js';
import { loadConfig } from '../../src/config/load.js';
import { parseReadme } from '../../src/markdown/markers.js';
import { run } from '../../src/git/index.js';

async function runPlan(repo: TempRepo) {
  const { config } = await loadConfig(repo.root);
  return plan({ repoRoot: repo.root, config });
}
const body = (readme: string, id: string) =>
  parseReadme(readme).regions.find((r) => r.id === id)!.body;

/** Config with only `enabled` sections on; everything else off. */
const only = (...ids: string[]) =>
  'version: 1\nsections:\n' +
  ['structure', 'api', 'commands', 'dependencies', 'changelog']
    .map((id) => `  ${id}: { enabled: ${ids.includes(id)} }`)
    .join('\n') +
  '\n';

describe('fail-closed flags', () => {
  let repo: TempRepo;
  beforeEach(async () => {
    repo = await createTempRepo({
      ...TS_PACKAGE_FILES,
      'README.md': readmeWith(['commands', 'dependencies']),
      '.readme-sync.yml': only('commands', 'dependencies'),
    });
    await apply(await runPlan(repo));
    await repo.commit('chore: readme-sync\n\nreadme-sync: auto');
  });
  afterEach(() => repo.cleanup());

  it('extractor error: a malformed manifest flags the sections that read it and writes nothing to them', async () => {
    const before = await repo.read('README.md');
    await repo.write({ 'package.json': '{ "name": "broken", ' });
    await repo.commit('chore: break manifest');
    const p = await runPlan(repo);
    const reasons = p.flags.map((f) => [f.section, f.reason]);
    expect(reasons).toEqual(
      expect.arrayContaining([
        ['commands', 'extractor-error'],
        ['dependencies', 'extractor-error'],
      ]),
    );
    expect(p.flags[0]!.message).toMatch(/package\.json is not valid JSON/);
    expect(p.changed).toBe(false);
    await apply(p);
    expect(body(await repo.read('README.md'), 'commands')).toBe(body(before, 'commands'));
    expect(body(await repo.read('README.md'), 'dependencies')).toBe(body(before, 'dependencies'));
    // and lastSha did not move
    expect(JSON.parse(await repo.read('.readme-sync/state.json')).lastSha).toBe(
      p.packages[0]!.stateBefore.lastSha,
    );
  });

  it('unmapped entry point (declared in package.json but unwatched) is flagged', async () => {
    await repo.write({ 'dist/cli.js': 'console.log(1)\n' });
    await repo.commit('build: cli');
    const p = await runPlan(repo);
    expect(p.flags).toHaveLength(1);
    expect(p.flags[0]).toMatchObject({ reason: 'unmapped-surface-file', files: ['dist/cli.js'] });
    expect(p.flags[0]!.message).toMatch(/entry point/);
  });

  it('a new top-level directory is flagged when structure is disabled', async () => {
    await repo.write({ 'scripts/release.sh': '#!/bin/sh\n' });
    await repo.commit('chore: scripts');
    const p = await runPlan(repo);
    expect(p.flags.map((f) => f.message)).toEqual([
      expect.stringMatching(/new top-level directory/),
    ]);
    expect(p.flags[0]!.files).toEqual(['scripts/release.sh']);
  });

  it('CI config: additions flag, modifications do not', async () => {
    await repo.write({ '.github/workflows/ci.yml': 'on: push\n' });
    await repo.commit('ci: add');
    const p1 = await runPlan(repo);
    expect(p1.flags.map((f) => f.message)).toEqual([expect.stringMatching(/CI configuration/)]);
    // Acknowledge so the base advances.
    const { config } = await loadConfig(repo.root);
    await apply(await plan({ repoRoot: repo.root, config, acceptStale: true }));
    await repo.commit('chore: readme-sync\n\nreadme-sync: auto');
    await repo.write({ '.github/workflows/ci.yml': 'on: [push, pull_request]\n' });
    await repo.commit('ci: tweak');
    const p2 = await runPlan(repo);
    expect(p2.flags).toEqual([]);
  });

  it('a non-surface source file that nothing watches is unmapped but not flagged', async () => {
    await repo.write({ 'src/util.ts': 'export const x = 1;\n' });
    await repo.commit('feat: util');
    const p = await runPlan(repo);
    expect(p.flags).toEqual([]);
    expect(p.packages[0]!.files.find((f) => f.file.path === 'src/util.ts')!.outcome.kind).toBe(
      'unmapped',
    );
  });

  it('acceptStale advances lastSha despite flags; force alone does not', async () => {
    await repo.write({ 'dist/cli.js': '1' });
    await repo.commit('build: cli');
    const head = await repo.git.headSha();
    const { config } = await loadConfig(repo.root);
    await apply(await plan({ repoRoot: repo.root, config, force: true }));
    expect(JSON.parse(await repo.read('.readme-sync/state.json')).lastSha).not.toBe(head);
    await apply(await plan({ repoRoot: repo.root, config, acceptStale: true }));
    expect(JSON.parse(await repo.read('.readme-sync/state.json')).lastSha).toBe(head);
  });
});

describe('comment --dry-run (built CLI)', () => {
  it('prints the comment body with the hidden marker and flags', async () => {
    const CLI = path.resolve(__dirname, '../../dist/cli/index.js');
    const repo = await createTempRepo({
      ...TS_PACKAGE_FILES,
      'README.md': readmeWith(['commands']),
      '.readme-sync.yml': only('commands', 'dependencies'),
    });
    try {
      const r = await run(process.execPath, [CLI, 'comment', '--dry-run', '-q'], {
        cwd: repo.root,
        allowFailure: true,
      });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('<!-- readme-sync:comment -->');
      expect(r.stdout).toContain('README may be stale here: `dependencies`');
      expect(r.stdout).toContain('- `commands`');
    } finally {
      await repo.cleanup();
    }
  });
});
