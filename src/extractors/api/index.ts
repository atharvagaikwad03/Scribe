import type { ExtractContext, ExtractResult, SectionGenerator } from '../types.js';
import { diffSurface, normaliseSurface, surfaceChanged, type ApiSurface } from './surface.js';
import { extractTsSurface } from './ts-surface.js';
import { extractPythonSurface } from './python-surface.js';
import { extractHeuristics, UNRESOLVED_CONFIDENCE } from './heuristics.js';
import { loadSurface, saveSurface } from '../../state/index.js';
import { readPackageJson, readPyProject } from '../manifest.js';
import { exists } from '../../util/fs.js';
import path from 'node:path';
import { table } from '../render.js';

export interface ApiData {
  surface: ApiSurface;
  entryFiles: string[];
}

function md(s: string): string {
  // Code span that tolerates backticks and pipes inside table cells.
  const safe = s.replace(/\|/g, '\\|');
  return safe.includes('`') ? `\`\` ${safe} \`\`` : `\`${safe}\``;
}

export const apiGenerator: SectionGenerator<ApiData> = {
  id: 'api',
  defaultWatch: [
    'src/**',
    'lib/**',
    'app/**',
    'api/**',
    'routes/**',
    'cli/**',
    'bin/**',
    'commands/**',
    '*.ts',
    '*.tsx',
    '*.mts',
    '*.js',
    '*.mjs',
    '*.cjs',
    '*.py',
    '**/__init__.py',
    '**/*.py',
    'package.json',
    'pyproject.toml',
    'tsconfig.json',
    '!**/*.test.*',
    '!**/*.spec.*',
    '!**/test/**',
    '!**/tests/**',
    '!**/__tests__/**',
    '!**/test_*.py',
    '!**/*_test.py',
    '!**/conftest.py',
    '!**/fixtures/**',
  ],

  async extract(ctx: ExtractContext): Promise<ExtractResult<ApiData>> {
    const dir = ctx.pkg.absPath;
    const files = await ctx.listFiles();
    const diagnostics: string[] = [];
    let confidence = 1;
    const items = [];
    const languages: string[] = [];
    const entryFiles: string[] = [];

    const hasNode =
      !!(await readPackageJson(dir)) ||
      files.some((f) => /\.(ts|tsx|js|mjs)$/.test(f) && !f.includes('/'));
    const hasPy =
      !!(await readPyProject(dir)) ||
      (await exists(path.join(dir, 'setup.py'))) ||
      files.some((f) => f.endsWith('.py'));

    if (hasNode) {
      const ts = await extractTsSurface(dir);
      items.push(...ts.items);
      entryFiles.push(...ts.entryFiles);
      diagnostics.push(...ts.diagnostics);
      confidence = Math.min(confidence, ts.confidence);
      if (ts.entryFiles.length)
        languages.push(ts.entryFiles.some((f) => /\.tsx?$/.test(f)) ? 'typescript' : 'javascript');
    }
    if (hasPy) {
      const py = await extractPythonSurface(dir, files);
      items.push(...py.items);
      entryFiles.push(...py.entryFiles);
      diagnostics.push(...py.diagnostics);
      confidence = Math.min(confidence, py.confidence);
      if (py.entryFiles.length) languages.push('python');
    }

    const heur = await extractHeuristics(dir, files);
    items.push(...heur.items);
    diagnostics.push(...heur.diagnostics);
    // Unresolved dynamic registrations only matter if the file that contains them changed
    // (or on a full run): then we cannot say what the surface is, so fail closed.
    const changedSet = new Set(
      ctx.watchedChanges.flatMap((c) => [c.path, c.from].filter(Boolean) as string[]),
    );
    const relevantUnresolved = heur.unresolved.filter((f) => ctx.fullMode || changedSet.has(f));
    if (relevantUnresolved.length) confidence = Math.min(confidence, UNRESOLVED_CONFIDENCE);

    const surface = normaliseSurface(items, languages);
    const previous = await loadSurface<ApiSurface>(ctx.repoRoot, ctx.pkg);
    ctx.shared.previousSurface = previous;
    ctx.shared.surface = surface;
    ctx.shared.apiDiff = diffSurface(previous, surface);
    if (previous && !surfaceChanged(ctx.shared.apiDiff))
      diagnostics.push('Public surface unchanged since last snapshot.');

    return {
      data: { surface, entryFiles: [...new Set(entryFiles)].sort() },
      confidence,
      diagnostics,
    };
  },

  render(data: ApiData): string {
    const parts: string[] = [];
    const exportsList = data.surface.items.filter((i) => i.category === 'export');
    const cli = data.surface.items.filter((i) => i.category === 'cli');
    const endpoints = data.surface.items.filter((i) => i.category === 'endpoint');

    if (exportsList.length) {
      parts.push(
        `**Exports**${data.entryFiles.length ? ` (from ${data.entryFiles.map((f) => `\`${f}\``).join(', ')})` : ''}\n`,
      );
      parts.push(
        table(
          ['Name', 'Kind', 'Signature'],
          exportsList.map((i) => [md(i.name), i.kind, md(i.signature)]),
        ),
      );
    }
    if (cli.length) {
      parts.push('**CLI commands**\n');
      parts.push(
        table(
          ['Command', 'Kind', 'Defined in'],
          cli.map((i) => [md(i.signature), i.kind, `\`${i.file}\``]),
        ),
      );
    }
    if (endpoints.length) {
      parts.push('**HTTP endpoints**\n');
      parts.push(
        table(
          ['Method', 'Path', 'Defined in'],
          endpoints.map((i) => [i.kind, md(i.name.slice(i.kind.length + 1)), `\`${i.file}\``]),
        ),
      );
    }
    if (!parts.length) return '_No public API surface detected._';
    return parts.join('\n');
  },

  async afterWrite(data: ApiData, ctx: ExtractContext): Promise<string[]> {
    const previous = await loadSurface<ApiSurface>(ctx.repoRoot, ctx.pkg);
    if (previous && JSON.stringify(previous) === JSON.stringify(data.surface)) return [];
    await saveSurface(ctx.repoRoot, ctx.pkg, data.surface);
    return [`${ctx.pkg.stateDir}/api-surface.json`];
  },
};
