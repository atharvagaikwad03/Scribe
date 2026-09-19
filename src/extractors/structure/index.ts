import path from 'node:path';
import type { ExtractContext, ExtractResult, SectionGenerator } from '../types.js';
import { ok } from '../types.js';
import { readPackageJson, readPyProject } from '../manifest.js';
import { detectEntryPoints, type EntryPoint } from './entrypoints.js';
import { exists } from '../../util/fs.js';
import { compileGlobs } from '../../engine/mapping.js';
import { code, table } from '../render.js';

export interface TreeDir {
  path: string;
  files: number;
  /** Direct child directories (already depth-limited). */
  dirs: TreeDir[];
}

export interface StructureData {
  languages: string[];
  frameworks: string[];
  entryPoints: EntryPoint[];
  rootFiles: string[];
  tree: TreeDir[];
  depth: number;
}

const EXT_LANG: Record<string, string> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.mts': 'TypeScript',
  '.cts': 'TypeScript',
  '.js': 'JavaScript',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',
  '.jsx': 'JavaScript',
  '.py': 'Python',
  '.go': 'Go',
  '.rs': 'Rust',
  '.java': 'Java',
  '.kt': 'Kotlin',
  '.rb': 'Ruby',
  '.php': 'PHP',
  '.cs': 'C#',
  '.swift': 'Swift',
  '.c': 'C',
  '.cpp': 'C++',
  '.sh': 'Shell',
};

const NODE_FRAMEWORKS: Record<string, string> = {
  next: 'Next.js',
  react: 'React',
  vue: 'Vue',
  svelte: 'Svelte',
  '@sveltejs/kit': 'SvelteKit',
  '@angular/core': 'Angular',
  nuxt: 'Nuxt',
  astro: 'Astro',
  remix: 'Remix',
  '@remix-run/react': 'Remix',
  express: 'Express',
  fastify: 'Fastify',
  koa: 'Koa',
  hono: 'Hono',
  '@nestjs/core': 'NestJS',
  electron: 'Electron',
  vite: 'Vite',
  commander: 'Commander (CLI)',
  yargs: 'yargs (CLI)',
  '@oclif/core': 'oclif (CLI)',
  ink: 'Ink (CLI)',
  vitest: 'Vitest',
  jest: 'Jest',
  prisma: 'Prisma',
  '@prisma/client': 'Prisma',
  drizzle: 'Drizzle',
  'drizzle-orm': 'Drizzle',
  tailwindcss: 'Tailwind CSS',
};

const PY_FRAMEWORKS: Record<string, string> = {
  fastapi: 'FastAPI',
  django: 'Django',
  flask: 'Flask',
  starlette: 'Starlette',
  click: 'Click (CLI)',
  typer: 'Typer (CLI)',
  pytest: 'pytest',
  sqlalchemy: 'SQLAlchemy',
  pydantic: 'Pydantic',
  celery: 'Celery',
  numpy: 'NumPy',
  pandas: 'pandas',
  torch: 'PyTorch',
  tensorflow: 'TensorFlow',
};

export const structureGenerator: SectionGenerator<StructureData> = {
  id: 'structure',
  // Any file added / removed / renamed changes the layout; modifications only matter for manifests.
  defaultWatch: ['**/*'],
  statuses: ['A', 'D', 'R', 'C'],
  watchAnyStatus: [
    'package.json',
    'pyproject.toml',
    'Dockerfile',
    'tsconfig.json',
    'setup.py',
    'go.mod',
    'Cargo.toml',
  ],

  async extract(ctx: ExtractContext): Promise<ExtractResult<StructureData>> {
    const depth = ctx.section.depth ?? 2;
    const files = await ctx.listFiles();
    const isIgnored = compileGlobs([...ctx.pkg.ignore, ...ctx.config.ignore, '.readme-sync/**']);
    const visible = files.filter(
      (f) => !isIgnored(f) && !f.split('/').some((seg) => seg.startsWith('.') && seg !== '.github'),
    );
    const diagnostics: string[] = [];

    // Languages from manifests + extension frequency.
    const pkgJson = await readPackageJson(ctx.pkg.absPath);
    const py = await readPyProject(ctx.pkg.absPath);
    const counts = new Map<string, number>();
    for (const f of visible) {
      const lang = EXT_LANG[path.posix.extname(f)];
      if (lang) counts.set(lang, (counts.get(lang) ?? 0) + 1);
    }
    const languages = [...counts.entries()]
      .filter(([, n]) => n >= 2 || counts.size === 1)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([l]) => l);
    if (py && !languages.includes('Python')) languages.push('Python');
    if (pkgJson && !languages.includes('TypeScript') && !languages.includes('JavaScript')) {
      languages.push(
        (await exists(path.join(ctx.pkg.absPath, 'tsconfig.json'))) ? 'TypeScript' : 'JavaScript',
      );
    }
    if (await exists(path.join(ctx.pkg.absPath, 'go.mod')))
      if (!languages.includes('Go')) languages.push('Go');
    if (await exists(path.join(ctx.pkg.absPath, 'Cargo.toml')))
      if (!languages.includes('Rust')) languages.push('Rust');

    // Frameworks from declared dependencies.
    const frameworks = new Set<string>();
    for (const dep of Object.keys({
      ...(pkgJson?.dependencies ?? {}),
      ...(pkgJson?.devDependencies ?? {}),
    })) {
      const fw = NODE_FRAMEWORKS[dep];
      if (fw) frameworks.add(fw);
    }
    const pyDeps: string[] = [
      ...((py?.project?.dependencies as string[] | undefined) ?? []),
      ...Object.values(
        (py?.project?.['optional-dependencies'] as Record<string, string[]> | undefined) ?? {},
      ).flat(),
      ...Object.keys(py?.tool?.poetry?.dependencies ?? {}),
      ...Object.keys(py?.tool?.poetry?.['dev-dependencies'] ?? {}),
      ...Object.values((py?.['dependency-groups'] as Record<string, unknown[]> | undefined) ?? {})
        .flat()
        .filter((x): x is string => typeof x === 'string'),
    ];
    for (const dep of pyDeps) {
      const name = dep.toLowerCase().split(/[\s[<>=!~;]/)[0]!;
      const fw = PY_FRAMEWORKS[name];
      if (fw) frameworks.add(fw);
    }

    const entryPoints = await detectEntryPoints(ctx.pkg.absPath);
    if (!entryPoints.length)
      diagnostics.push('No entry points declared in manifests and none found by convention.');

    // Directory tree.
    const root: TreeDir = { path: '', files: 0, dirs: [] };
    const dirMap = new Map<string, TreeDir>([['', root]]);
    const rootFiles: string[] = [];
    for (const f of visible) {
      const parts = f.split('/');
      if (parts.length === 1) {
        rootFiles.push(f);
        continue;
      }
      let cur = root;
      for (let i = 0; i < parts.length - 1 && i < depth; i++) {
        const dirPath = parts.slice(0, i + 1).join('/');
        let d = dirMap.get(dirPath);
        if (!d) {
          d = { path: dirPath, files: 0, dirs: [] };
          dirMap.set(dirPath, d);
          cur.dirs.push(d);
        }
        cur = d;
      }
      // Count the file in every ancestor up to depth.
      for (let i = 1; i <= Math.min(parts.length - 1, depth); i++)
        dirMap.get(parts.slice(0, i).join('/'))!.files++;
    }
    const sortTree = (d: TreeDir) => {
      d.dirs.sort((a, b) => a.path.localeCompare(b.path));
      d.dirs.forEach(sortTree);
    };
    sortTree(root);

    return ok(
      {
        languages,
        frameworks: [...frameworks].sort(),
        entryPoints,
        rootFiles: rootFiles.sort(),
        tree: root.dirs,
        depth,
      },
      diagnostics,
    );
  },

  render(data: StructureData): string {
    const parts: string[] = [];
    const meta: string[][] = [];
    if (data.languages.length) meta.push(['Language', data.languages.join(', ')]);
    if (data.frameworks.length) meta.push(['Frameworks / tools', data.frameworks.join(', ')]);
    if (meta.length) parts.push(table(['', ''], meta));

    if (data.entryPoints.length) {
      parts.push('**Entry points**\n');
      parts.push(
        table(
          ['Role', 'File', 'Declared in'],
          data.entryPoints.map((e) => [`\`${e.role}\``, `\`${e.file}\``, e.source]),
        ),
      );
    }

    const lines: string[] = [];
    const walk = (dirs: TreeDir[], indent: string) => {
      for (const d of dirs) {
        const name = d.path.split('/').pop()!;
        lines.push(
          `${indent}${name}/${d.dirs.length ? '' : `  (${d.files} file${d.files === 1 ? '' : 's'})`}`,
        );
        walk(d.dirs, indent + '  ');
      }
    };
    walk(data.tree, '');
    const MAX_ROOT = 20;
    for (const f of data.rootFiles.slice(0, MAX_ROOT)) lines.push(f);
    if (data.rootFiles.length > MAX_ROOT)
      lines.push(`… ${data.rootFiles.length - MAX_ROOT} more files`);
    if (lines.length) {
      parts.push(`**Layout** (depth ${data.depth})\n`);
      parts.push(code(lines.join('\n'), 'text'));
    }
    return parts.length ? parts.join('\n') : '_Empty package._';
  },
};
