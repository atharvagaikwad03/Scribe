import path from 'node:path';
import { readPackageJson, readPyProject } from '../manifest.js';
import { exists, readTextIfExists } from '../../util/fs.js';
import { parseDockerfile } from '../manifest.js';

export interface EntryPoint {
  /** Package-relative POSIX path. */
  file: string;
  /** Where it was declared. */
  source: string;
  /** e.g. "main", "bin:readme-sync", "exports:.", "script:cli", "docker:CMD" */
  role: string;
}

function norm(p: string): string {
  return p.replace(/^\.\//, '').replace(/\\/g, '/');
}

function collectExports(exp: unknown, subpath: string, out: EntryPoint[]): void {
  if (typeof exp === 'string') {
    out.push({ file: norm(exp), source: 'package.json#exports', role: `exports:${subpath}` });
    return;
  }
  if (Array.isArray(exp)) {
    for (const e of exp) collectExports(e, subpath, out);
    return;
  }
  if (exp && typeof exp === 'object') {
    for (const [key, value] of Object.entries(exp as Record<string, unknown>)) {
      if (key.startsWith('.')) collectExports(value, key, out);
      else collectExports(value, subpath, out); // condition (import/require/types/default)
    }
  }
}

/** Entry points declared in manifests: package.json main/module/bin/exports, pyproject scripts, Dockerfile CMD/ENTRYPOINT. */
export async function detectEntryPoints(dir: string): Promise<EntryPoint[]> {
  const out: EntryPoint[] = [];
  const pkg = await readPackageJson(dir);
  if (pkg) {
    if (pkg.main) out.push({ file: norm(pkg.main), source: 'package.json#main', role: 'main' });
    if (pkg.module)
      out.push({ file: norm(pkg.module), source: 'package.json#module', role: 'module' });
    if (pkg.types) out.push({ file: norm(pkg.types), source: 'package.json#types', role: 'types' });
    if (typeof pkg.bin === 'string')
      out.push({ file: norm(pkg.bin), source: 'package.json#bin', role: `bin:${pkg.name ?? ''}` });
    else if (pkg.bin) {
      for (const [name, file] of Object.entries(pkg.bin).sort())
        out.push({ file: norm(file), source: 'package.json#bin', role: `bin:${name}` });
    }
    collectExports(pkg.exports, '.', out);
  }
  const py = await readPyProject(dir);
  if (py) {
    const scripts: Record<string, string> = {
      ...(py.project?.scripts ?? {}),
      ...(py.tool?.poetry?.scripts ?? {}),
    };
    for (const [name, target] of Object.entries(scripts).sort()) {
      const mod = String(target).split(':')[0]!.trim();
      const candidates = [
        mod.replace(/\./g, '/') + '.py',
        mod.replace(/\./g, '/') + '/__init__.py',
        'src/' + mod.replace(/\./g, '/') + '.py',
        'src/' + mod.replace(/\./g, '/') + '/__init__.py',
      ];
      for (const c of candidates) {
        if (await exists(path.join(dir, c))) {
          out.push({ file: c, source: 'pyproject.toml#scripts', role: `script:${name}` });
          break;
        }
      }
    }
  }
  const dockerText = await readTextIfExists(path.join(dir, 'Dockerfile'));
  if (dockerText !== undefined) {
    const d = parseDockerfile('Dockerfile', dockerText);
    for (const [role, cmd] of [
      ['docker:ENTRYPOINT', d.entrypoint],
      ['docker:CMD', d.cmd],
    ] as const) {
      if (!cmd) continue;
      for (const tok of cmd.split(/\s+/)) {
        const t = norm(tok.replace(/^["']|["']$/g, ''));
        if (/\.(js|mjs|cjs|ts|py|sh)$/.test(t) && (await exists(path.join(dir, t))))
          out.push({ file: t, source: 'Dockerfile', role });
      }
    }
  }
  // Conventional fallbacks when nothing is declared.
  if (!out.length) {
    for (const c of [
      'src/index.ts',
      'src/index.js',
      'index.ts',
      'index.js',
      'src/main.ts',
      'src/main.py',
      'main.py',
      'app.py',
      '__main__.py',
    ]) {
      if (await exists(path.join(dir, c))) {
        out.push({ file: c, source: 'convention', role: 'main' });
        break;
      }
    }
  }
  // Deduplicate by file+role, sorted.
  const seen = new Set<string>();
  return out
    .filter((e) => {
      const k = `${e.file}|${e.role}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => a.file.localeCompare(b.file) || a.role.localeCompare(b.role));
}
