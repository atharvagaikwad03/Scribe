import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTempRepo, readmeWith, TS_PACKAGE_FILES, type TempRepo } from '../helpers/repo.js';
import { Git, run } from '../../src/git/index.js';
import { evaluateLoopGuard } from '../../src/action/guard.js';
import { commitAndPush } from '../../src/action/git-ops.js';
import { plan, apply } from '../../src/engine/index.js';
import { loadConfig } from '../../src/config/load.js';
import { parseReadme } from '../../src/markdown/markers.js';

const CONFIG =
  'version: 1\nsections:\n  structure: { enabled: false }\n  api: { enabled: false }\n  changelog: { enabled: false }\n';

describe('loop guard', () => {
  let repo: TempRepo;
  beforeEach(async () => {
    repo = await createTempRepo({
      ...TS_PACKAGE_FILES,
      'README.md': readmeWith(['commands']),
      '.readme-sync.yml': CONFIG,
    });
  });
  afterEach(() => repo.cleanup());
  const input = { trailer: 'readme-sync: auto', readmePaths: ['README.md'] };

  it('does not skip a normal commit', async () => {
    expect(await evaluateLoopGuard(repo.git, input)).toEqual({ skip: false });
  });

  it('skips when HEAD carries the trailer', async () => {
    await repo.write({ 'README.md': '# changed\n' });
    await repo.commit('docs: sync README [skip ci]\n\nreadme-sync: auto');
    const g = await evaluateLoopGuard(repo.git, input);
    expect(g.skip).toBe(true);
    expect(g.reason).toMatch(/trailer/);
  });

  it('skips a bot-authored README-only commit even without the trailer', async () => {
    await repo.write({ 'README.md': '# changed\n', '.readme-sync/state.json': '{}' });
    await repo.commit('update readme', {
      author: 'readme-sync[bot]',
      email: 'readme-sync[bot]@users.noreply.github.com',
    });
    const g = await evaluateLoopGuard(repo.git, input);
    expect(g.skip).toBe(true);
  });

  it('skips when the commit touches only README + state, regardless of author', async () => {
    await repo.write({ 'README.md': '# changed\n', '.readme-sync/state.json': '{}' });
    await repo.commit('manual readme edit');
    expect((await evaluateLoopGuard(repo.git, input)).reason).toMatch(/only managed README/);
  });

  it('skips for a bot actor', async () => {
    expect(
      (await evaluateLoopGuard(repo.git, { ...input, actor: 'github-actions[bot]' })).skip,
    ).toBe(true);
  });

  it('does not skip when README and code change together', async () => {
    await repo.write({ 'README.md': '# changed\n', 'src/x.ts': '' });
    await repo.commit('feat: x with docs');
    expect((await evaluateLoopGuard(repo.git, input)).skip).toBe(false);
  });
});

describe('commit + push with rebase-retry against a moving remote', () => {
  let tmp: string;
  let bare: string;
  const clones: TempRepo[] = [];

  async function clone(name: string): Promise<TempRepo> {
    const dir = path.join(tmp, name);
    await run('git', ['clone', '-q', bare, dir], { cwd: tmp });
    const git = new Git(dir);
    await git.setUser(`${name} user`, `${name}@example.com`);
    const repo: TempRepo = {
      root: dir,
      git,
      async write(files) {
        for (const [rel, content] of Object.entries(files)) {
          await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
          await fs.writeFile(path.join(dir, rel), content);
        }
      },
      remove: async () => {},
      read: (f) => fs.readFile(path.join(dir, f), 'utf8'),
      exists: (f) =>
        fs.access(path.join(dir, f)).then(
          () => true,
          () => false,
        ),
      async commit(message) {
        await git.git(['add', '-A']);
        return git.commit(message);
      },
      cleanup: async () => {},
    };
    clones.push(repo);
    return repo;
  }

  beforeEach(async () => {
    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'readme-sync-race-')));
    bare = path.join(tmp, 'origin.git');
    await run('git', ['init', '-q', '--bare', '-b', 'main', bare], { cwd: tmp });
    const seed = await createTempRepo({
      ...TS_PACKAGE_FILES,
      'README.md': readmeWith(['commands', 'dependencies']),
      '.readme-sync.yml': CONFIG,
    });
    await seed.git.git(['remote', 'add', 'origin', bare]);
    await seed.git.git(['push', '-q', 'origin', 'main']);
    await seed.cleanup();
  });
  afterEach(() => fs.rm(tmp, { recursive: true, force: true }));

  const regenerateIn = (repo: TempRepo) => async () => {
    const { config } = await loadConfig(repo.root);
    const p = await plan({ repoRoot: repo.root, config, includeWorkingTree: false });
    return (await apply(p)).written;
  };

  it('two clones race; the loser discards its patch, regenerates on the new HEAD and converges', async () => {
    const a = await clone('a');
    const b = await clone('b');

    // Clone A: regenerate and push first (baseline README in origin).
    const first = await commitAndPush({
      repoRoot: a.root,
      branch: 'main',
      message: 'docs: sync [skip ci]\n\nreadme-sync: auto',
      authorName: 'bot',
      authorEmail: 'bot@x',
      regenerate: regenerateIn(a),
    });
    expect(first.pushed).toBe(true);
    expect(first.attempts).toBe(1);

    // Both clones pull, then each lands a different, non-conflicting code change that affects a
    // different README section: A bumps a dependency, B adds a Make target.
    for (const c of [a, b]) await c.git.git(['pull', '-q', '--rebase', 'origin', 'main']);
    const pkg = JSON.parse(await a.read('package.json'));
    pkg.dependencies.zod = '^3.99.0';
    await a.write({ 'package.json': JSON.stringify(pkg, null, 2) });
    await a.commit('chore: bump zod');
    await b.write({
      Makefile: (await b.read('Makefile')) + 'deploy: ## Deploy it\n\t./deploy.sh\n',
    });
    await b.commit('build: deploy target');
    expect((await a.git.push('origin', 'main')).ok).toBe(true);
    await b.git.git(['pull', '-q', '--rebase', 'origin', 'main']);
    expect((await b.git.push('origin', 'main')).ok).toBe(true);

    // Now the interesting part: both run readme-sync from *different* HEADs. A is behind (does not have B's
    // commit), B is current. A regenerates + commits first, then B; A's push must be rejected and retried.
    const resA = await commitAndPush({
      repoRoot: a.root,
      branch: 'main',
      message: 'docs: sync [skip ci]\n\nreadme-sync: auto',
      authorName: 'bot',
      authorEmail: 'bot@x',
      regenerate: regenerateIn(a),
    });
    const resB = await commitAndPush({
      repoRoot: b.root,
      branch: 'main',
      message: 'docs: sync [skip ci]\n\nreadme-sync: auto',
      authorName: 'bot',
      authorEmail: 'bot@x',
      regenerate: regenerateIn(b),
    });

    // Exactly one of them ends up committing the final README (the other finds nothing left to do or converges to it).
    const final = await clone('verify');
    const readme = await final.read('README.md');
    const regions = parseReadme(readme).regions;
    expect(regions.find((r) => r.id === 'dependencies')!.body).toContain('^3.99.0');
    expect(regions.find((r) => r.id === 'commands')!.body).toContain('`make deploy`');
    const state = JSON.parse(await final.read('.readme-sync/state.json'));
    expect(state.lastSha).toBe((await final.git.git(['rev-parse', 'HEAD~1'])).stdout.trim());
    expect(
      [resA, resB].filter((r) => r.pushed).length +
        [resA, resB].filter((r) => !r.committed && !r.error).length,
    ).toBe(2);
    expect(resA.error ?? resB.error).toBeUndefined();
    // A regenerated on stale HEAD, A's pull --rebase brought in B's commit -> README conflict or clean rebase;
    // either way it retried or succeeded without leaving conflict markers.
    expect(readme).not.toContain('<<<<<<<');
    // Idempotent afterwards.
    expect(
      (await plan({ repoRoot: final.root, config: (await loadConfig(final.root)).config })).changed,
    ).toBe(false);
  });

  it('gives up with a clear error after maxAttempts when the remote keeps moving', async () => {
    const a = await clone('a');
    const b = await clone('b');
    let n = 0;
    const res = await commitAndPush({
      repoRoot: a.root,
      branch: 'main',
      message: 'docs: sync\n\nreadme-sync: auto',
      authorName: 'bot',
      authorEmail: 'bot@x',
      maxAttempts: 2,
      regenerate: async () => {
        // Every attempt, someone else lands a commit on origin that conflicts line-for-line with ours.
        n++;
        await b.write({ 'GENERATED.txt': `human ${n}\n` });
        await b.commit(`chore: human edit ${n}`);
        await b.git.git(['pull', '-q', '--rebase', 'origin', 'main'], { allowFailure: true });
        expect((await b.git.push('origin', 'main')).ok).toBe(true);
        await a.write({ 'GENERATED.txt': `generated ${n}\n` });
        return ['GENERATED.txt'];
      },
    });
    expect(res.pushed).toBe(false);
    expect(res.attempts).toBe(2);
    expect(res.error).toMatch(/gave up after 2 attempts/);
  });
});
