import picomatch from 'picomatch';
import type { ChangedFile } from '../git/index.js';
import type { ResolvedPackage } from '../config/packages.js';
import type { SectionId } from '../config/schema.js';
import type { SectionGenerator } from '../extractors/types.js';
import { STATE_DIR } from '../config/schema.js';

export type FileOutcome =
  | { kind: 'claimed'; sections: SectionId[] }
  | { kind: 'ignored'; by: string }
  | { kind: 'unmapped' };

export interface MappedFile {
  file: ChangedFile;
  outcome: FileOutcome;
}

const BUILTIN_IGNORE = ['node_modules/**', '.git/**', `${STATE_DIR}/**`, '**/.DS_Store'];

export function compileGlobs(globs: string[]): (p: string) => boolean {
  const positive = globs.filter((g) => !g.startsWith('!'));
  const negative = globs.filter((g) => g.startsWith('!')).map((g) => g.slice(1));
  const pos = positive.length ? picomatch(positive, { dot: true }) : () => false;
  const neg = negative.length ? picomatch(negative, { dot: true }) : () => false;
  return (p) => pos(p) && !neg(p);
}

export function watchGlobsFor(gen: SectionGenerator, pkg: ResolvedPackage): string[] {
  const cfg = pkg.sections[gen.id];
  return [...(cfg.watch ?? gen.defaultWatch), ...cfg.watchExtra];
}

/**
 * Map every changed file (package-relative) to an outcome. Renames count as a
 * change to both the old and the new path.
 */
export function mapChangedFiles(
  changes: ChangedFile[],
  pkg: ResolvedPackage,
  generators: SectionGenerator[],
  repoIgnore: string[],
): MappedFile[] {
  const ignoreGlobs = [
    ...BUILTIN_IGNORE,
    pkg.readme === '.' ? 'README.md' : pkgRelativeReadme(pkg),
    ...pkg.ignore,
    ...repoIgnore,
  ];
  const isIgnored = compileGlobs(ignoreGlobs);
  const matchers = generators
    .filter((g) => pkg.sections[g.id].enabled && !g.alwaysRun)
    .map((g) => ({ g, match: compileGlobs(watchGlobsFor(g, pkg)) }));

  return changes.map((file) => {
    const paths = file.from ? [file.path, file.from] : [file.path];
    if (paths.every(isIgnored)) return { file, outcome: { kind: 'ignored', by: 'ignore globs' } };
    const sections = new Set<SectionId>();
    for (const { g, match } of matchers) {
      const statusOk =
        !g.statuses ||
        g.statuses.includes(file.status) ||
        (file.from !== undefined && g.statuses.includes('R'));
      if (!statusOk) continue;
      if (paths.some(match)) sections.add(g.id);
    }
    if (sections.size)
      return { file, outcome: { kind: 'claimed', sections: [...sections].sort() } };
    return { file, outcome: { kind: 'unmapped' } };
  });
}

function pkgRelativeReadme(pkg: ResolvedPackage): string {
  if (pkg.path === '.') return pkg.readme;
  return pkg.readme.startsWith(pkg.path + '/') ? pkg.readme.slice(pkg.path.length + 1) : pkg.readme;
}
