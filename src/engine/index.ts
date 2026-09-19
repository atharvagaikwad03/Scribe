import type { Config, SectionId } from '../config/schema.js';
import {
  resolvePackages,
  packageForFile,
  toPackageRelative,
  type ResolvedPackage,
} from '../config/packages.js';
import { Git, type ChangedFile } from '../git/index.js';
import {
  parseReadme,
  regionIsPristine,
  spliceMany,
  spliceRegion,
  bodyHash,
  type MarkerRegion,
  type ParsedReadme,
} from '../markdown/markers.js';
import { loadState, saveState, type PackageState } from '../state/index.js';
import { GENERATORS } from '../extractors/registry.js';
import type { ExtractContext, SectionGenerator, SharedRunData } from '../extractors/types.js';
import { mapChangedFiles, type MappedFile } from './mapping.js';
import { surfaceRelevance, type StaleFlag } from '../flags/index.js';
import { hashValue } from '../util/hash.js';
import { MarkerError, ReadmeSyncError } from '../util/errors.js';
import { listFiles, readTextIfExists, writeText } from '../util/fs.js';
import { detectEntryPoints } from '../extractors/structure/entrypoints.js';
import type { LlmProvider } from '../llm/provider.js';
import { TOOL_VERSION } from '../version.js';
import { log } from '../util/log.js';

export interface RunOptions {
  repoRoot: string;
  config: Config;
  /** Override the base commit (defaults to the package's recorded lastSha). */
  base?: string;
  /** Overwrite sections that were manually edited inside their markers. */
  force?: boolean;
  /** Advance lastSha even when stale flags were raised. */
  acceptStale?: boolean;
  /** Only process packages whose path is in this list. */
  packages?: string[];
  /** Only process these sections. */
  sections?: SectionId[];
  llm?: LlmProvider;
  /** Include uncommitted working-tree changes in the diff (default true). */
  includeWorkingTree?: boolean;
  /** Run extractors even for sections whose inputs did not change (used by `explain`). */
  forceExtract?: boolean;
}

export type SectionStatus = 'disabled' | 'unchanged' | 'update' | 'flagged' | 'skipped';

export interface SectionPlan {
  id: SectionId;
  status: SectionStatus;
  reason: string;
  /** Package-relative files that made this section run. */
  affectedBy: string[];
  confidence?: number;
  diagnostics: string[];
  oldBody?: string;
  newBody?: string;
  inputHash?: string;
  data?: unknown;
  /** Set when extraction succeeded (used for afterWrite hooks). */
  extracted: boolean;
}

export interface PackagePlan {
  pkg: ResolvedPackage;
  headSha: string;
  baseSha: string | null;
  fullMode: boolean;
  fullModeReason?: string;
  files: MappedFile[];
  sections: SectionPlan[];
  flags: StaleFlag[];
  readmeBefore?: string;
  readmeAfter?: string;
  readmeChanged: boolean;
  stateBefore: PackageState;
  stateAfter: PackageState;
  /** Fatal package-level problem (e.g. malformed markers). Nothing is written for this package. */
  error?: string;
  /** Internal: generator contexts, for afterWrite. */
  _contexts?: Map<SectionId, ExtractContext>;
}

export interface RunPlan {
  repoRoot: string;
  headSha: string;
  packages: PackagePlan[];
  flags: StaleFlag[];
  /** True when at least one README would change. */
  changed: boolean;
}

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.readme-sync',
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  'coverage',
  '.next',
  '.turbo',
  '.cache',
  'target',
  '.idea',
  '.vscode',
]);

export async function plan(opts: RunOptions): Promise<RunPlan> {
  const git = new Git(opts.repoRoot);
  if (!(await git.isRepo()))
    throw new ReadmeSyncError('GIT', `${opts.repoRoot} is not a git repository`);
  const headSha = await git.headSha();
  const allPackages = await resolvePackages(opts.repoRoot, opts.config);
  const selected = opts.packages?.length
    ? allPackages.filter((p) => opts.packages!.includes(p.path))
    : allPackages;

  const packages: PackagePlan[] = [];
  for (const pkg of selected) {
    packages.push(await planPackage(pkg, allPackages, git, headSha, opts));
  }
  const flags = packages.flatMap((p) => p.flags);
  return {
    repoRoot: opts.repoRoot,
    headSha,
    packages,
    flags,
    changed: packages.some((p) => p.readmeChanged),
  };
}

async function planPackage(
  pkg: ResolvedPackage,
  allPackages: ResolvedPackage[],
  git: Git,
  headSha: string,
  opts: RunOptions,
): Promise<PackagePlan> {
  const { config } = opts;
  const stateBefore = await loadState(opts.repoRoot, pkg, TOOL_VERSION);
  const flags: StaleFlag[] = [];
  const sections: SectionPlan[] = [];
  const base: PackagePlan = {
    pkg,
    headSha,
    baseSha: null,
    fullMode: false,
    files: [],
    sections,
    flags,
    readmeChanged: false,
    stateBefore,
    stateAfter: structuredClone(stateBefore),
  };

  // 1. README + markers. Any structural problem is fatal for this package.
  const readme = await readTextIfExists(pkg.absReadme);
  if (readme === undefined) {
    flags.push({
      pkg: pkg.path,
      reason: 'missing-marker',
      message: `README not found at ${pkg.readme}`,
      files: [],
    });
    base.error = `README not found at ${pkg.readme}`;
    return base;
  }
  base.readmeBefore = readme;
  let parsed: ParsedReadme;
  try {
    parsed = parseReadme(readme);
  } catch (err) {
    if (err instanceof MarkerError) {
      flags.push({
        pkg: pkg.path,
        reason: 'malformed-markers',
        message: err.message,
        files: [pkgRel(pkg.readme, pkg)],
      });
      base.error = err.message;
      return base;
    }
    throw err;
  }

  // 2. Base commit and diff.
  const requestedBase = opts.base ?? stateBefore.lastSha ?? undefined;
  let fullMode = false;
  let fullModeReason: string | undefined;
  if (!requestedBase) {
    fullMode = true;
    fullModeReason = 'no previous run recorded (first run)';
  } else if (!(await git.commitExists(requestedBase))) {
    fullMode = true;
    fullModeReason = (await git.isShallow())
      ? `last commit ${requestedBase.slice(0, 7)} is not available in this shallow clone (use fetch-depth: 0)`
      : `last commit ${requestedBase.slice(0, 7)} no longer exists (force push?)`;
  } else if (!(await git.isAncestor(requestedBase, headSha))) {
    fullMode = true;
    fullModeReason = `last commit ${requestedBase.slice(0, 7)} is not an ancestor of HEAD (rewritten history?)`;
  }
  base.fullMode = fullMode;
  base.fullModeReason = fullModeReason;
  base.baseSha = fullMode ? null : requestedBase!;
  if (fullMode) log.info(`${pkg.path}: full regeneration of generated sections: ${fullModeReason}`);

  let repoChanges: ChangedFile[] = [];
  if (!fullMode) repoChanges = await git.changedFiles(requestedBase!, headSha);
  if (opts.includeWorkingTree !== false) {
    const wt = await git.workingTreeChanges();
    const seen = new Set(repoChanges.map((c) => c.path));
    for (const c of wt) if (!seen.has(c.path)) repoChanges.push(c);
  }

  // Files belonging to this package (package-relative). Root also sees sub-package files
  // so its `packages` table can react, but they are never "unmapped" for the root.
  const ownFiles: ChangedFile[] = [];
  const foreign = new Map<string, string>();
  for (const c of repoChanges) {
    const owner =
      packageForFile(c.path, allPackages) ?? packageForFile(c.from ?? c.path, allPackages);
    const isOwn = owner?.path === pkg.path;
    const isForeignUnderRoot = pkg.path === '.' && owner && owner.path !== '.';
    if (!isOwn && !isForeignUnderRoot) continue;
    const rel: ChangedFile = {
      status: c.status,
      path: toPackageRelative(c.path, pkg),
      ...(c.from ? { from: toPackageRelative(c.from, pkg) } : {}),
    };
    ownFiles.push(rel);
    if (isForeignUnderRoot) foreign.set(rel.path, owner!.path);
  }

  const generators = opts.sections?.length
    ? GENERATORS.filter((g) => opts.sections!.includes(g.id))
    : GENERATORS;
  const mapped = mapChangedFiles(ownFiles, pkg, generators, config.ignore);
  for (const m of mapped) {
    if (m.outcome.kind === 'unmapped' && foreign.has(m.file.path)) {
      m.outcome = { kind: 'ignored', by: `owned by package ${foreign.get(m.file.path)}` };
    }
  }
  base.files = mapped;

  // 3. Shared context.
  let fileCache: string[] | undefined;
  const shared: SharedRunData = {};
  const contexts = new Map<SectionId, ExtractContext>();
  const makeCtx = (gen: SectionGenerator, watched: ChangedFile[]): ExtractContext => ({
    repoRoot: opts.repoRoot,
    pkg,
    section: pkg.sections[gen.id],
    config,
    git,
    headSha,
    state: stateBefore,
    stateAfter: base.stateAfter,
    fullMode,
    changedFiles: ownFiles,
    watchedChanges: watched,
    shared,
    llm: opts.llm,
    allPackages,
    async listFiles() {
      fileCache ??= (await listFiles(pkg.absPath, pkg.absPath, SKIP_DIRS)).sort();
      return fileCache;
    },
  });

  // 4. Manual-edit detection runs for every enabled section with a region, regardless of affectedness.
  const regionById = new Map(parsed.regions.map((r) => [r.id, r] as const));

  const updates: Array<{ region: MarkerRegion; body: string }> = [];
  const headMoved = stateBefore.lastSha !== headSha || ownFiles.length > 0;

  for (const gen of generators) {
    const cfg = pkg.sections[gen.id];
    const region = regionById.get(gen.id);
    const claimedBy = mapped
      .filter((m) => m.outcome.kind === 'claimed' && m.outcome.sections.includes(gen.id))
      .map((m) => m.file);
    const affectedBy = claimedBy.map((f) => f.path);
    const sp: SectionPlan = {
      id: gen.id,
      status: 'skipped',
      reason: '',
      affectedBy,
      diagnostics: [],
      extracted: false,
    };
    sections.push(sp);

    if (!cfg.enabled) {
      sp.status = 'disabled';
      sp.reason = 'disabled in config';
      continue;
    }
    if (!region) {
      sp.status = 'flagged';
      sp.reason = 'no autogen marker for this section in the README';
      flags.push({
        pkg: pkg.path,
        section: gen.id,
        reason: 'missing-marker',
        message: `section is enabled but the README has no <!-- autogen:start:${gen.id} --> marker (run \`readme-sync init\` or disable the section)`,
        files: [],
      });
      continue;
    }
    sp.oldBody = region.body;

    const pristine = regionIsPristine(region);
    if (!pristine && !opts.force) {
      sp.status = 'flagged';
      sp.reason = 'manual edit inside generated section';
      flags.push({
        pkg: pkg.path,
        section: gen.id,
        reason: 'manual-edit',
        message: `manual edit inside generated section \`${gen.id}\` (hash mismatch); not overwriting. Re-run with --force to reclaim it`,
        files: [pkgRel(pkg.readme, pkg)],
      });
      continue;
    }

    const neverGenerated = !stateBefore.sections[gen.id];
    const reclaim = !pristine && opts.force === true;
    const affected =
      fullMode ||
      neverGenerated ||
      reclaim ||
      opts.forceExtract === true ||
      claimedBy.length > 0 ||
      (gen.alwaysRun === true && headMoved) ||
      region.hash === undefined;
    if (!affected) {
      sp.status = 'unchanged';
      sp.reason = 'no watched files changed';
      continue;
    }

    const ctx = makeCtx(gen, claimedBy);
    contexts.set(gen.id, ctx);
    let result;
    try {
      result = await gen.extract(ctx);
    } catch (err) {
      sp.status = 'flagged';
      sp.reason = `extractor failed: ${(err as Error).message}`;
      flags.push({
        pkg: pkg.path,
        section: gen.id,
        reason: 'extractor-error',
        message: sp.reason,
        files: affectedBy,
      });
      continue;
    }
    sp.confidence = result.confidence;
    sp.diagnostics = result.diagnostics;
    sp.data = result.data;
    sp.extracted = true;
    sp.inputHash = hashValue(result.data);

    if (result.confidence < config.confidenceThreshold) {
      sp.status = 'flagged';
      sp.reason = `confidence ${result.confidence.toFixed(2)} below threshold ${config.confidenceThreshold}`;
      sp.extracted = false;
      flags.push({
        pkg: pkg.path,
        section: gen.id,
        reason: 'low-confidence',
        message: `${sp.reason}${result.diagnostics.length ? ': ' + result.diagnostics.join('; ') : ''}`,
        files: affectedBy,
      });
      continue;
    }

    let newBody: string;
    try {
      newBody = gen.render(result.data, ctx).replace(/\s+$/, '');
      // Trial splice: the body must not disturb marker structure.
      parseReadme(spliceRegion(readme, region, newBody));
    } catch (err) {
      sp.status = 'flagged';
      sp.reason = `render failed: ${(err as Error).message}`;
      sp.extracted = false;
      flags.push({
        pkg: pkg.path,
        section: gen.id,
        reason: 'render-error',
        message: sp.reason,
        files: affectedBy,
      });
      continue;
    }
    sp.newBody = newBody;
    base.stateAfter.sections[gen.id] = { inputHash: sp.inputHash, bodyHash: bodyHash(newBody) };

    if (newBody === region.body) {
      sp.status = 'unchanged';
      sp.reason =
        stateBefore.sections[gen.id]?.inputHash === sp.inputHash
          ? 'inputs unchanged'
          : 'rendered content identical';
      continue;
    }
    sp.status = 'update';
    sp.reason = reclaim
      ? 'reclaimed manually edited section (--force)'
      : fullMode
        ? `regenerated (${fullModeReason})`
        : neverGenerated
          ? 'first generation'
          : 'inputs changed';
    updates.push({ region, body: newBody });
  }

  // 5. Unmapped surface-relevant files.
  const unmapped = mapped.filter((m) => m.outcome.kind === 'unmapped');
  if (unmapped.length) {
    const entryPoints = new Set(
      await detectEntryPoints(pkg.absPath).then((eps) => eps.map((e) => e.file)),
    );
    const newTopLevelDirs = new Set<string>();
    if (!fullMode) {
      const before = new Set(await git.lsTree(requestedBase!, { topLevelOnly: true }));
      for (const m of unmapped) {
        const abs = pkg.path === '.' ? m.file.path : `${pkg.path}/${m.file.path}`;
        const top = abs.split('/')[0]!;
        if (m.file.status === 'A' && abs.includes('/') && !before.has(top))
          newTopLevelDirs.add(m.file.path.split('/')[0]!);
      }
    }
    const grouped = new Map<string, string[]>();
    for (const m of unmapped) {
      const rel = surfaceRelevance(m.file.path, m.file.status, { entryPoints, newTopLevelDirs });
      if (!rel.relevant) continue;
      grouped.set(rel.why, [...(grouped.get(rel.why) ?? []), m.file.path]);
    }
    for (const [why, files] of [...grouped.entries()].sort()) {
      flags.push({
        pkg: pkg.path,
        reason: 'unmapped-surface-file',
        message: `${WHY_TEXT[why] ?? why} changed but no enabled section watches it`,
        files: files.sort(),
      });
    }
  }

  // 6. Assemble.
  if (updates.length) {
    base.readmeAfter = spliceMany(readme, updates);
    base.readmeChanged = base.readmeAfter !== readme;
  } else {
    base.readmeAfter = readme;
  }
  const blockingFlags = flags.filter((f) => f.reason !== 'manual-edit' || !opts.force);
  if (!blockingFlags.length || opts.acceptStale) {
    base.stateAfter.lastSha = headSha;
  } else {
    log.info(
      `${pkg.path}: not advancing lastSha because ${blockingFlags.length} stale flag(s) were raised`,
    );
  }
  base.stateAfter.toolVersion = TOOL_VERSION;
  base._contexts = contexts;
  return base;
}

const WHY_TEXT: Record<string, string> = {
  manifest: 'a package manifest',
  lockfile: 'a lockfile',
  requirements: 'a requirements file',
  dockerfile: 'a Dockerfile / compose file',
  'ci-config': 'CI configuration',
  'entry-point': 'an entry point',
  'new-top-level-dir': 'a new top-level directory',
};

function pkgRel(repoRelative: string, pkg: ResolvedPackage): string {
  return toPackageRelative(repoRelative, pkg);
}

export interface ApplyResult {
  /** Repo-relative paths written. */
  written: string[];
}

/** Write READMEs and state for every package in the plan that has no fatal error. */
export async function apply(run: RunPlan): Promise<ApplyResult> {
  const written: string[] = [];
  for (const p of run.packages) {
    if (p.error) continue;
    if (p.readmeChanged && p.readmeAfter !== undefined) {
      await writeText(p.pkg.absReadme, p.readmeAfter);
      written.push(p.pkg.readme);
    }
    const stateChanged = JSON.stringify(p.stateAfter) !== JSON.stringify(p.stateBefore);
    if (stateChanged) {
      await saveState(run.repoRoot, p.pkg, p.stateAfter);
      written.push(`${p.pkg.stateDir}/state.json`);
    }
    for (const sp of p.sections) {
      if (!sp.extracted) continue;
      const gen = GENERATORS.find((g) => g.id === sp.id);
      const ctx = p._contexts?.get(sp.id);
      if (gen?.afterWrite && ctx) {
        const extra = await gen.afterWrite(sp.data, ctx);
        if (Array.isArray(extra)) written.push(...(extra as string[]));
      }
    }
  }
  return { written: [...new Set(written)].sort() };
}

export function planToJson(run: RunPlan): unknown {
  return {
    headSha: run.headSha,
    changed: run.changed,
    packages: run.packages.map((p) => ({
      path: p.pkg.path,
      readme: p.pkg.readme,
      baseSha: p.baseSha,
      fullMode: p.fullMode,
      fullModeReason: p.fullModeReason,
      error: p.error,
      readmeChanged: p.readmeChanged,
      files: p.files.map((f) => ({ ...f.file, outcome: f.outcome })),
      sections: p.sections.map((s) => ({
        id: s.id,
        status: s.status,
        reason: s.reason,
        affectedBy: s.affectedBy,
        confidence: s.confidence,
        diagnostics: s.diagnostics,
      })),
      flags: p.flags,
    })),
  };
}
