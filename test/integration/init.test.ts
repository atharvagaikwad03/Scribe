import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempRepo, TS_PACKAGE_FILES, type TempRepo } from '../helpers/repo.js';
import { init } from '../../src/cli/init.js';
import { parseReadme } from '../../src/markdown/markers.js';

describe('init', () => {
  let repo: TempRepo;
  beforeEach(async () => {
    const files = { ...TS_PACKAGE_FILES };
    delete files['.readme-sync.yml'];
    files['README.md'] =
      '# My project\n\nIntro prose.\n\n## API\n\nOld hand-written API notes.\n\n## License\n\nMIT\n';
    repo = await createTempRepo(files);
  });
  afterEach(() => repo.cleanup());

  it('creates the config and inserts empty markers under existing anchors without touching prose', async () => {
    const res = await init({ repoRoot: repo.root, adopt: false, dryRun: false });
    expect(res.wroteConfig).toBe(true);
    expect(await repo.exists('.readme-sync.yml')).toBe(true);
    const readme = await repo.read('README.md');
    const parsed = parseReadme(readme);
    expect(parsed.regions.map((r) => r.id)).toEqual([
      'api',
      'structure',
      'commands',
      'dependencies',
      'changelog',
    ]);
    // Existing heading reused, prose still present and outside the markers.
    expect(readme).toContain('Old hand-written API notes.');
    expect(readme.indexOf('<!-- autogen:end:api -->')).toBeLessThan(
      readme.indexOf('Old hand-written API notes.'),
    );
    // Missing anchors appended as new headings at the end.
    expect(readme).toContain('## Project structure');
    expect(readme).toContain('## Changelog');
    expect(readme.startsWith('# My project\n\nIntro prose.\n')).toBe(true);
  });

  it('--adopt wraps the existing content under the anchor', async () => {
    await init({ repoRoot: repo.root, adopt: true, dryRun: false });
    const parsed = parseReadme(await repo.read('README.md'));
    const api = parsed.regions.find((r) => r.id === 'api')!;
    expect(api.body).toBe('Old hand-written API notes.');
    expect((await repo.read('README.md')).match(/Old hand-written API notes\./g)).toHaveLength(1);
  });

  it('--dry-run writes nothing', async () => {
    const before = await repo.read('README.md');
    const res = await init({ repoRoot: repo.root, adopt: false, dryRun: true });
    expect(res.readmes[0]!.after).not.toBe(before);
    expect(await repo.read('README.md')).toBe(before);
    expect(await repo.exists('.readme-sync.yml')).toBe(false);
  });

  it('is idempotent', async () => {
    await init({ repoRoot: repo.root, adopt: false, dryRun: false });
    const once = await repo.read('README.md');
    const res = await init({ repoRoot: repo.root, adopt: false, dryRun: false });
    expect(await repo.read('README.md')).toBe(once);
    expect(res.readmes[0]!.skipped.every((s) => s.why === 'marker already present')).toBe(true);
  });
});
