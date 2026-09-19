import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempRepo, readmeWith, TS_PACKAGE_FILES, type TempRepo } from '../helpers/repo.js';
import { plan, apply } from '../../src/engine/index.js';
import { loadConfig } from '../../src/config/load.js';
import { parseReadme } from '../../src/markdown/markers.js';
import { MockProvider } from '../../src/llm/mock.js';
import { validateBullets } from '../../src/extractors/changelog/llm.js';
import { parseConventional } from '../../src/extractors/changelog/conventional.js';

const CONFIG = `version: 1
sections:
  structure: { enabled: false }
  commands: { enabled: false }
  dependencies: { enabled: false }
changelog:
  maxEntries: 5
`;

async function runPlan(repo: TempRepo, extra: Record<string, unknown> = {}) {
  const { config } = await loadConfig(repo.root);
  return plan({ repoRoot: repo.root, config, ...extra });
}
const body = (readme: string, id: string) =>
  parseReadme(readme).regions.find((r) => r.id === id)!.body;

describe('changelog (deterministic)', () => {
  let repo: TempRepo;
  beforeEach(async () => {
    repo = await createTempRepo({
      ...TS_PACKAGE_FILES,
      'README.md': readmeWith(['api', 'changelog']),
      '.readme-sync.yml': CONFIG,
    });
    await repo.write({ 'a.txt': '1' });
    await repo.commit('feat(core): add greeting');
    await repo.write({ 'b.txt': '1' });
    await repo.commit('fix: handle empty names');
    await repo.write({ 'c.txt': '1' });
    await repo.commit('docs: tweak wording');
    await repo.write({ 'd.txt': '1' });
    await repo.commit('feat!: drop node 18\n\nBREAKING CHANGE: node 20 required');
  });
  afterEach(() => repo.cleanup());

  it('groups conventional commits and drops tool commits', async () => {
    const p = await runPlan(repo);
    await apply(p);
    const cl = body(await repo.read('README.md'), 'changelog');
    expect(cl.indexOf('**Breaking changes**')).toBeLessThan(cl.indexOf('**Features**'));
    expect(cl.indexOf('**Features**')).toBeLessThan(cl.indexOf('**Fixes**'));
    expect(cl.indexOf('**Fixes**')).toBeLessThan(cl.indexOf('**Other**'));
    expect(cl).toContain('- drop node 20 required'.slice(0, 0) + '- drop node 18 (`');
    expect(cl).toContain('- **core:** add greeting (`');
    expect(cl).toContain('- handle empty names (`');
    expect(cl).toContain('- tweak wording (`');
    expect(cl).toContain('- initial commit (`'); // 5 entries max: 4 conventional + initial
    expect(cl).not.toMatch(/\d{4}-\d{2}-\d{2}/); // no timestamps

    // A tool-authored commit is excluded and the section stays unchanged.
    await repo.commit('docs: update README [skip ci]\n\nreadme-sync: auto');
    const p2 = await runPlan(repo);
    const cs = p2.packages[0]!.sections.find((s) => s.id === 'changelog')!;
    expect(cs.status).toBe('unchanged');
    expect(cs.reason).toBe('inputs unchanged');
  });

  it('is append-only, deduped, and capped', async () => {
    await apply(await runPlan(repo));
    await repo.commit('docs: update README\n\nreadme-sync: auto');
    await repo.write({ 'e.txt': '1' });
    await repo.commit('fix(cli): exit codes');
    await repo.write({ 'f.txt': '1' });
    await repo.commit('feat: farewell command');
    const p = await runPlan(repo);
    expect(p.packages[0]!.sections.find((s) => s.id === 'changelog')!.status).toBe('update');
    await apply(p);
    const state = JSON.parse(await repo.read('.readme-sync/state.json'));
    const subjects = state.changelog.entries.map((e: any) => e.subject);
    expect(subjects).toEqual([
      'farewell command',
      'exit codes',
      'drop node 18',
      'tweak wording',
      'handle empty names',
    ]);
    expect(new Set(state.changelog.entries.map((e: any) => e.sha)).size).toBe(5);
    const cl = body(await repo.read('README.md'), 'changelog');
    expect(cl).toContain('- **cli:** exit codes');
    expect(cl).not.toContain('initial commit'); // fell off the cap
  });

  it('adds an "API changes" list from the surface diff', async () => {
    await apply(await runPlan(repo));
    await repo.commit('docs: update README\n\nreadme-sync: auto');
    await repo.write({
      'src/greet.ts':
        (await repo.read('src/greet.ts')) +
        '\nexport function farewell(name: string): string {\n  return `Bye, ${name}`;\n}\n',
      'src/index.ts': (await repo.read('src/index.ts'))
        .replace(
          "export { greet } from './greet.js';",
          "export { greet, farewell } from './greet.js';",
        )
        .replace("export const VERSION = '1.2.3';", ''),
    });
    await repo.commit('feat: farewell, drop VERSION');
    await apply(await runPlan(repo));
    const cl = body(await repo.read('README.md'), 'changelog');
    expect(cl).toContain('**API changes**');
    expect(cl).toContain('- Added export `farewell(name: string): string`');
    expect(cl).toContain('- Removed export `VERSION`');
  });

  it('parses non-conventional subjects as Other and strips [skip ci]', () => {
    const e = parseConventional({
      sha: 'abc',
      subject: 'Update stuff [skip ci]',
      body: '',
      authorName: '',
      authorEmail: '',
    });
    expect(e).toEqual({ sha: 'abc', type: 'other', breaking: false, subject: 'Update stuff' });
  });
});

describe('changelog (LLM highlights)', () => {
  let repo: TempRepo;
  beforeEach(async () => {
    repo = await createTempRepo({
      ...TS_PACKAGE_FILES,
      'README.md': readmeWith(['changelog']),
      '.readme-sync.yml': CONFIG.replace('sections:\n', 'sections:\n  api: { enabled: false }\n'),
    });
    await repo.write({ 'a.txt': '1' });
    await repo.commit('feat: add greeting');
  });
  afterEach(() => repo.cleanup());

  it('rejects bullets with a fake SHA and falls back to deterministic output', async () => {
    const llm = new MockProvider().reply('- Invented a feature (deadbee)\n');
    const p = await runPlan(repo, { llm });
    const cs = p.packages[0]!.sections.find((s) => s.id === 'changelog')!;
    expect(cs.status).toBe('update');
    expect(cs.diagnostics.join(' ')).toMatch(/rejected: bullet references unknown SHA deadbee/);
    expect(cs.newBody).not.toContain('Highlights');
    expect(cs.newBody).toContain('- add greeting (`');
    expect(llm.calls).toHaveLength(1);
  });

  it('accepts validated bullets, renders Highlights, and caches by input hash', async () => {
    const head = await repo.git.headSha();
    const llm = new MockProvider().reply(`- Greeting support landed (${head.slice(0, 7)})\n`);
    const p = await runPlan(repo, { llm });
    expect(p.packages[0]!.sections.find((s) => s.id === 'changelog')!.newBody).toContain(
      `**Highlights**\n\n- Greeting support landed (${head.slice(0, 7)})`,
    );
    const res = await apply(p);
    expect(res.written).toContain('.readme-sync/llm-cache.json');
    expect(llm.calls).toHaveLength(1);

    // Same inputs again (forced extraction): served from cache, provider not called, identical text.
    const llm2 = new MockProvider().reply('- SHOULD NOT BE USED (deadbee)');
    const p2 = await runPlan(repo, { llm: llm2, forceExtract: true });
    expect(llm2.calls).toHaveLength(0);
    expect(p2.packages[0]!.sections.find((s) => s.id === 'changelog')!.status).toBe('unchanged');
  });

  it('validateBullets: rejects prose, missing SHAs and unknown SHAs; accepts prefixes', () => {
    const shas = ['0123456789abcdef0123456789abcdef01234567'];
    expect(validateBullets('Here are the changes:\n- x (0123456)', shas)).toMatchObject({
      ok: false,
    });
    expect(validateBullets('- no sha here', shas)).toMatchObject({ ok: false });
    expect(validateBullets('- bad (fffffff)', shas)).toMatchObject({ ok: false });
    expect(validateBullets('- good (0123456)\n* also good 0123456789ab', shas)).toEqual({
      ok: true,
      bullets: [
        { sha: shas[0], text: 'good (0123456)' },
        { sha: shas[0], text: 'also good 0123456789ab' },
      ],
    });
  });
});
