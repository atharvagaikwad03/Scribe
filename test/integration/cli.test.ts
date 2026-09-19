import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { createTempRepo, readmeWith, TS_PACKAGE_FILES, type TempRepo } from '../helpers/repo.js';
import { run } from '../../src/git/index.js';

const CLI = path.resolve(__dirname, '../../dist/cli/index.js');

async function cli(cwd: string, ...args: string[]) {
  return run(process.execPath, [CLI, ...args], { cwd, allowFailure: true });
}

describe('cli (built bundle)', () => {
  let repo: TempRepo;
  beforeAll(async () => {
    await run('pnpm', ['exec', 'tsup'], { cwd: path.resolve(__dirname, '../..') });
    repo = await createTempRepo({
      ...TS_PACKAGE_FILES,
      'README.md': readmeWith(['commands', 'dependencies']),
      '.readme-sync.yml':
        'version: 1\nsections:\n  structure: { enabled: false }\n  api: { enabled: false }\n  changelog: { enabled: false }\n',
    });
  });
  afterAll(() => repo?.cleanup());

  it('plan --json reports pending updates; update --check exits 1; update writes; --check then exits 0', async () => {
    const planRes = await cli(repo.root, 'plan', '--json');
    expect(planRes.code).toBe(0);
    const json = JSON.parse(planRes.stdout);
    expect(json.changed).toBe(true);
    expect(json.packages[0].sections.find((s: any) => s.id === 'commands').status).toBe('update');

    const check = await cli(repo.root, 'update', '--check', '-q');
    expect(check.code).toBe(1);

    const upd = await cli(repo.root, 'update', '-q');
    expect(upd.code).toBe(0);
    expect(upd.stdout).toContain('wrote: .readme-sync/state.json, README.md');

    const check2 = await cli(repo.root, 'update', '--check', '-q');
    expect(check2.code).toBe(0);
  });

  it('explain prints extractor output for a section', async () => {
    const res = await cli(repo.root, 'explain', 'commands');
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('watch globs');
    expect(res.stdout).toContain('"install"');
  });

  it('exits 2 with a clear message on malformed markers', async () => {
    await repo.write({ 'README.md': '<!-- autogen:start:commands -->\n' });
    const res = await cli(repo.root, 'update', '-q');
    expect(res.code).toBe(2);
    expect(res.stdout + res.stderr).toMatch(/never closed/);
  });
});
