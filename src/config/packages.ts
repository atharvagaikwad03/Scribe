import path from 'node:path';
import YAML from 'yaml';
import picomatch from 'picomatch';
import { promises as fs } from 'node:fs';
import type { Config, PackageConfig, SectionConfig, SectionId, SectionsConfig } from './schema.js';
import { SECTION_IDS, STATE_DIR } from './schema.js';
import { exists, readJsonIfExists, readTextIfExists, toPosix } from '../util/fs.js';

/** A fully resolved package: absolute paths plus per-section effective config. */
export interface ResolvedPackage {
  /** Repo-relative POSIX path, "." for the root. */
  path: string;
  /** Stable slug used for state directories. */
  slug: string;
  absPath: string;
  /** Repo-relative POSIX path of the README. */
  readme: string;
  absReadme: string;
  /** Repo-relative POSIX path of this package's state directory. */
  stateDir: string;
  sections: Record<SectionId, SectionConfig>;
  /** Package-relative ignore globs. */
  ignore: string[];
}

export function packageSlug(pkgPath: string): string {
  if (pkgPath === '.' || pkgPath === '') return 'root';
  return pkgPath.replace(/^\.\//, '').replace(/[^A-Za-z0-9._-]+/g, '__');
}

function mergeSections(
  root: SectionsConfig,
  override: PackageConfig['sections'],
): Record<SectionId, SectionConfig> {
  const out = {} as Record<SectionId, SectionConfig>;
  for (const id of SECTION_IDS) {
    const base = root[id];
    const ov = override[id] ?? {};
    out[id] = {
      ...base,
      ...Object.fromEntries(Object.entries(ov).filter(([, v]) => v !== undefined)),
      options: { ...base.options, ...(ov.options ?? {}) },
      watchExtra: [...base.watchExtra, ...(ov.watchExtra ?? [])],
    };
  }
  return out;
}

export function resolvePackage(
  repoRoot: string,
  config: Config,
  pkg: PackageConfig,
): ResolvedPackage {
  const rel = toPosix(path.normalize(pkg.path)).replace(/\/+$/, '') || '.';
  const relClean = rel === '.' ? '.' : rel.replace(/^\.\//, '');
  const absPath = path.resolve(repoRoot, relClean);
  const readmeRel = relClean === '.' ? pkg.readme : `${relClean}/${pkg.readme}`;
  const slug = packageSlug(relClean);
  const stateDir = slug === 'root' ? STATE_DIR : `${STATE_DIR}/packages/${slug}`;
  return {
    path: relClean,
    slug,
    absPath,
    readme: toPosix(readmeRel),
    absReadme: path.resolve(repoRoot, readmeRel),
    stateDir,
    sections: mergeSections(config.sections, pkg.sections),
    ignore: pkg.ignore,
  };
}

/** Expand workspace globs (e.g. "packages/*") into concrete directories that contain a package.json. */
async function expandWorkspaceGlobs(repoRoot: string, globs: string[]): Promise<string[]> {
  const positive = globs.filter((g) => !g.startsWith('!'));
  const negative = globs.filter((g) => g.startsWith('!')).map((g) => g.slice(1));
  const isMatch = picomatch(positive, { dot: false });
  const isExcluded = negative.length ? picomatch(negative, { dot: false }) : () => false;
  const results = new Set<string>();

  // Walk only as deep as the deepest glob needs.
  const maxDepth = Math.max(1, ...positive.map((g) => g.split('/').length));
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.'))
        continue;
      const abs = path.join(dir, entry.name);
      const rel = toPosix(path.relative(repoRoot, abs));
      if (isMatch(rel) && !isExcluded(rel) && (await exists(path.join(abs, 'package.json')))) {
        results.add(rel);
      }
      await walk(abs, depth + 1);
    }
  }
  await walk(repoRoot, 1);
  return [...results].sort();
}

/** Discover npm / yarn / pnpm workspaces. Returns repo-relative package dirs (excluding root). */
export async function discoverWorkspaces(repoRoot: string): Promise<string[]> {
  const globs: string[] = [];
  const pnpmWs = await readTextIfExists(path.join(repoRoot, 'pnpm-workspace.yaml'));
  if (pnpmWs) {
    const parsed = YAML.parse(pnpmWs) as { packages?: string[] } | null;
    if (parsed?.packages) globs.push(...parsed.packages);
  }
  // A malformed root package.json is reported by the extractors (fail closed); discovery just skips it.
  const pkgJson = await readJsonIfExists<{ workspaces?: string[] | { packages?: string[] } }>(
    path.join(repoRoot, 'package.json'),
  ).catch(() => undefined);
  if (pkgJson?.workspaces) {
    const ws = Array.isArray(pkgJson.workspaces)
      ? pkgJson.workspaces
      : (pkgJson.workspaces.packages ?? []);
    globs.push(...ws);
  }
  if (!globs.length) return [];
  return expandWorkspaceGlobs(repoRoot, globs);
}

/**
 * Resolve the effective package list:
 *  - explicit `packages` in config win;
 *  - otherwise discovered workspaces (plus the root, which gets the `packages` table);
 *  - otherwise a single root package.
 */
export async function resolvePackages(
  repoRoot: string,
  config: Config,
): Promise<ResolvedPackage[]> {
  if (config.packages.length) {
    return config.packages.map((p) => resolvePackage(repoRoot, config, p));
  }
  const discovered = config.discoverWorkspaces ? await discoverWorkspaces(repoRoot) : [];
  if (!discovered.length) {
    return [
      resolvePackage(repoRoot, config, {
        path: '.',
        readme: 'README.md',
        sections: {},
        ignore: [],
      }),
    ];
  }
  const root = resolvePackage(repoRoot, config, {
    path: '.',
    readme: 'README.md',
    // Root of a monorepo: no API/commands of its own by default, but a packages table.
    sections: {
      packages: { enabled: config.sections.packages.enabled || true },
      api: { enabled: false },
    },
    ignore: [],
  });
  const pkgs = discovered.map((p) =>
    resolvePackage(repoRoot, config, { path: p, readme: 'README.md', sections: {}, ignore: [] }),
  );
  return [root, ...pkgs];
}

/** Map a repo-relative file to the most specific package containing it. */
export function packageForFile(file: string, pkgs: ResolvedPackage[]): ResolvedPackage | undefined {
  let best: ResolvedPackage | undefined;
  for (const pkg of pkgs) {
    if (pkg.path === '.') {
      if (!best) best = pkg;
      continue;
    }
    if (file === pkg.path || file.startsWith(pkg.path + '/')) {
      if (!best || best.path === '.' || pkg.path.length > best.path.length) best = pkg;
    }
  }
  return best;
}

/** Convert a repo-relative path to a package-relative path ("" if it is the package dir itself). */
export function toPackageRelative(file: string, pkg: ResolvedPackage): string {
  if (pkg.path === '.') return file;
  if (file === pkg.path) return '';
  return file.startsWith(pkg.path + '/') ? file.slice(pkg.path.length + 1) : file;
}
