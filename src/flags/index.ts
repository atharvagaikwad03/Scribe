import type { SectionId } from '../config/schema.js';

export type FlagReason =
  | 'unmapped-surface-file'
  | 'low-confidence'
  | 'extractor-error'
  | 'manual-edit'
  | 'malformed-markers'
  | 'missing-marker'
  | 'render-error';

export interface StaleFlag {
  /** Package path ("." for root). */
  pkg: string;
  /** Section affected, or undefined when the flag is not attributable to one section. */
  section?: SectionId;
  reason: FlagReason;
  message: string;
  /** Package-relative files that triggered the flag. */
  files: string[];
}

const MANIFESTS = new Set([
  'package.json',
  'pyproject.toml',
  'setup.py',
  'setup.cfg',
  'Pipfile',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'composer.json',
  'Gemfile',
]);
const LOCKFILES = new Set([
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'poetry.lock',
  'uv.lock',
  'pdm.lock',
  'Pipfile.lock',
  'Cargo.lock',
  'go.sum',
  'composer.lock',
  'Gemfile.lock',
]);
const CI_PATTERNS = [
  /^\.github\/workflows\/[^/]+\.ya?ml$/,
  /^\.gitlab-ci\.ya?ml$/,
  /^\.circleci\/config\.ya?ml$/,
  /^Jenkinsfile$/,
  /^azure-pipelines\.ya?ml$/,
  /^bitbucket-pipelines\.ya?ml$/,
  /^\.travis\.ya?ml$/,
];

export type SurfaceRelevance =
  | { relevant: false }
  | {
      relevant: true;
      why:
        | 'manifest'
        | 'lockfile'
        | 'dockerfile'
        | 'ci-config'
        | 'entry-point'
        | 'new-top-level-dir'
        | 'requirements';
    };

/**
 * Decide whether an *unmapped* changed file is one a README reader would care
 * about. Only these produce stale flags; other unmapped files are ignored.
 */
export function surfaceRelevance(
  file: string,
  status: string,
  opts: { entryPoints: Set<string>; newTopLevelDirs: Set<string> },
): SurfaceRelevance {
  const base = file.split('/').pop() ?? file;
  if (MANIFESTS.has(base)) return { relevant: true, why: 'manifest' };
  if (LOCKFILES.has(base)) return { relevant: true, why: 'lockfile' };
  if (/^requirements.*\.txt$/.test(base)) return { relevant: true, why: 'requirements' };
  if (
    base === 'Dockerfile' ||
    base.startsWith('Dockerfile.') ||
    base.endsWith('.Dockerfile') ||
    base === 'docker-compose.yml' ||
    base === 'compose.yaml'
  ) {
    return { relevant: true, why: 'dockerfile' };
  }
  // CI config: only additions/deletions change how a project is built badly enough to matter (D-008).
  if ((status === 'A' || status === 'D') && CI_PATTERNS.some((re) => re.test(file))) {
    return { relevant: true, why: 'ci-config' };
  }
  if (opts.entryPoints.has(file)) return { relevant: true, why: 'entry-point' };
  const top = file.includes('/') ? file.split('/')[0]! : undefined;
  if (top && status === 'A' && opts.newTopLevelDirs.has(top))
    return { relevant: true, why: 'new-top-level-dir' };
  return { relevant: false };
}

export function formatFlag(f: StaleFlag): string {
  const where = f.section ? `\`${f.section}\`` : '(unattributed)';
  const pkg = f.pkg === '.' ? '' : ` [${f.pkg}]`;
  const files = f.files.length ? ` — ${f.files.map((x) => `\`${x}\``).join(', ')}` : '';
  return `README may be stale here${pkg}: ${where} — ${f.message}${files}`;
}
