import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { parseConfig, renderDefaultConfig } from '../../src/config/load.js';
import { ConfigError } from '../../src/util/errors.js';
import { resolvePackage, packageForFile, toPackageRelative } from '../../src/config/packages.js';

describe('config', () => {
  it('applies defaults for an empty config', () => {
    const cfg = parseConfig({});
    expect(cfg.version).toBe(1);
    expect(cfg.confidenceThreshold).toBe(0.7);
    expect(cfg.sections.api.enabled).toBe(true);
    expect(cfg.sections.packages.enabled).toBe(false);
    expect(cfg.llm.enabled).toBe(false);
  });

  it('rejects unknown keys with a readable error', () => {
    expect(() => parseConfig({ bogus: true })).toThrow(ConfigError);
    expect(() => parseConfig({ sections: { api: { watchh: [] } } })).toThrow(/sections.api/);
  });

  it('round-trips the rendered default config', () => {
    const cfg = parseConfig(YAML.parse(renderDefaultConfig()));
    expect(cfg.sections.structure.anchor).toBe('## Project structure');
  });

  it('merges package section overrides onto root defaults', () => {
    const cfg = parseConfig({
      sections: { api: { watch: ['src/**'], options: { a: 1 } } },
      packages: [
        {
          path: 'packages/x',
          sections: { api: { options: { b: 2 } }, changelog: { enabled: false } },
        },
      ],
    });
    const pkg = resolvePackage('/repo', cfg, cfg.packages[0]!);
    expect(pkg.path).toBe('packages/x');
    expect(pkg.slug).toBe('packages__x');
    expect(pkg.readme).toBe('packages/x/README.md');
    expect(pkg.stateDir).toBe('.readme-sync/packages/packages__x');
    expect(pkg.sections.api.watch).toEqual(['src/**']);
    expect(pkg.sections.api.options).toEqual({ a: 1, b: 2 });
    expect(pkg.sections.changelog.enabled).toBe(false);
  });

  it('maps files to the most specific package', () => {
    const cfg = parseConfig({
      packages: [{ path: '.' }, { path: 'packages/a' }, { path: 'packages/a/nested' }],
    });
    const pkgs = cfg.packages.map((p) => resolvePackage('/repo', cfg, p));
    expect(packageForFile('packages/a/src/x.ts', pkgs)?.path).toBe('packages/a');
    expect(packageForFile('packages/a/nested/y.ts', pkgs)?.path).toBe('packages/a/nested');
    expect(packageForFile('README.md', pkgs)?.path).toBe('.');
    expect(toPackageRelative('packages/a/src/x.ts', pkgs[1]!)).toBe('src/x.ts');
  });
});
