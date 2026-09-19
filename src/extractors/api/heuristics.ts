import path from 'node:path';
import type { SurfaceItem } from './surface.js';
import { readPackageJson } from '../manifest.js';
import { readTextIfExists } from '../../util/fs.js';

export interface HeuristicResult {
  items: SurfaceItem[];
  diagnostics: string[];
  /** Files where a command/route call was seen but its name/path could not be resolved statically. */
  unresolved: string[];
}

const SOURCE_RE = /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx|py)$/;
const TEST_RE =
  /(^|\/)(test|tests|__tests__|spec|specs|fixtures?|node_modules|dist|build|\.venv|venv)(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.py$/;

export function isScannableSource(file: string): boolean {
  return SOURCE_RE.test(file) && !TEST_RE.test(file);
}

const CLI_CONFIDENCE = 0.85;
const ENDPOINT_CONFIDENCE = 0.75;
const UNRESOLVED_CONFIDENCE = 0.5;

/**
 * Regex-based detection of CLI commands (commander / yargs / click / typer /
 * argparse) and HTTP endpoints (express / fastify / koa / hono / FastAPI /
 * Flask). Deliberately conservative: only string-literal names and paths
 * count; anything dynamic is reported as unresolved so the section is flagged
 * instead of guessed.
 */
export async function extractHeuristics(dir: string, files: string[]): Promise<HeuristicResult> {
  const items: SurfaceItem[] = [];
  const diagnostics: string[] = [];
  const unresolved = new Set<string>();

  const pkg = await readPackageJson(dir);
  if (pkg?.bin) {
    const bins =
      typeof pkg.bin === 'string' ? { [pkg.name ?? path.basename(dir)]: pkg.bin } : pkg.bin;
    for (const [name, target] of Object.entries(bins).sort()) {
      items.push({
        category: 'cli',
        kind: 'binary',
        name,
        signature: `${name} (${target.replace(/^\.\//, '')})`,
        file: 'package.json',
        confidence: 1,
      });
    }
  }

  for (const file of files.filter(isScannableSource)) {
    const text = await readTextIfExists(path.join(dir, file));
    if (text === undefined) continue;
    const isPy = file.endsWith('.py');
    if (isPy) scanPython(file, text, items, unresolved);
    else scanJs(file, text, items, unresolved);
  }

  for (const f of [...unresolved].sort())
    diagnostics.push(
      `${f}: a command or route is registered with a non-literal name/path and could not be resolved`,
    );
  return { items, diagnostics, unresolved: [...unresolved].sort() };
}

const JS_CMD_RE = /\.command\(\s*(?:(['"`])([^'"`]*)\1|([^)\s,]+))/g;
const JS_ROUTE_RE =
  /\b(?:app|router|server|fastify|api|route|r|hono|koaRouter)\.(get|post|put|patch|delete|options|head|all)\(\s*(?:(['"`])([^'"`]*)\2|([^)\s,]+))/g;
const JS_ROUTE_OBJ_RE =
  /\.route\(\s*\{[^}]*?method:\s*['"]([A-Z]+)['"][^}]*?(?:url|path):\s*['"]([^'"]+)['"]/g;

function scanJs(file: string, text: string, items: SurfaceItem[], unresolved: Set<string>): void {
  for (const m of text.matchAll(JS_CMD_RE)) {
    if (m[2] !== undefined) {
      if (m[1] === '`' && m[2].includes('${')) {
        unresolved.add(file);
        continue;
      }
      const name = m[2].trim().split(/\s+/)[0] ?? '';
      if (!name || name === '*' || name === '$0') continue;
      items.push({
        category: 'cli',
        kind: 'command',
        name,
        signature: m[2].trim(),
        file,
        confidence: CLI_CONFIDENCE,
      });
    } else if (m[3]) unresolved.add(file);
  }
  for (const m of text.matchAll(JS_ROUTE_RE)) {
    const method = m[1]!.toUpperCase();
    if (m[3] !== undefined) {
      if (m[2] === '`' && m[3].includes('${')) {
        unresolved.add(file);
        continue;
      }
      if (!m[3].startsWith('/')) continue; // e.g. app.get('port') — not a route
      items.push({
        category: 'endpoint',
        kind: method,
        name: `${method} ${m[3]}`,
        signature: `${method} ${m[3]}`,
        file,
        confidence: ENDPOINT_CONFIDENCE,
      });
    } else if (m[4] && !/^(function|async|\()/.test(m[4])) unresolved.add(file);
  }
  for (const m of text.matchAll(JS_ROUTE_OBJ_RE)) {
    items.push({
      category: 'endpoint',
      kind: m[1]!,
      name: `${m[1]} ${m[2]}`,
      signature: `${m[1]} ${m[2]}`,
      file,
      confidence: ENDPOINT_CONFIDENCE,
    });
  }
}

const PY_CMD_RE =
  /^\s*@([A-Za-z_][\w.]*)\.(command|group)\(\s*(?:(['"])([^'"]*)\3)?[^)]*\)\s*\n(?:\s*@[^\n]*\n)*\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/gm;
const PY_ARGPARSE_RE = /add_parser\(\s*(['"])([^'"]+)\1/g;
const PY_ROUTE_RE =
  /^\s*@([A-Za-z_][\w.]*)\.(get|post|put|patch|delete|options|head|api_route|route)\(\s*(?:(['"])([^'"]*)\3|([^,)]+))([^)]*)\)/gm;

function scanPython(
  file: string,
  text: string,
  items: SurfaceItem[],
  unresolved: Set<string>,
): void {
  for (const m of text.matchAll(PY_CMD_RE)) {
    const explicit = m[4];
    const fn = m[5]!;
    const name = explicit ?? fn.replace(/_/g, '-');
    items.push({
      category: 'cli',
      kind: m[2] === 'group' ? 'group' : 'command',
      name,
      signature: `${name} (${fn})`,
      file,
      confidence: CLI_CONFIDENCE,
    });
  }
  for (const m of text.matchAll(PY_ARGPARSE_RE)) {
    items.push({
      category: 'cli',
      kind: 'command',
      name: m[2]!,
      signature: m[2]!,
      file,
      confidence: CLI_CONFIDENCE,
    });
  }
  for (const m of text.matchAll(PY_ROUTE_RE)) {
    const deco = m[2]!;
    if (m[4] === undefined) {
      if (m[5]) unresolved.add(file);
      continue;
    }
    const p = m[4];
    if (!p.startsWith('/')) continue;
    let methods: string[];
    if (deco === 'route' || deco === 'api_route') {
      const mm = /methods\s*=\s*\[([^\]]*)\]/.exec(m[6] ?? '');
      methods = mm
        ? [...mm[1]!.matchAll(/['"]([A-Za-z]+)['"]/g)].map((x) => x[1]!.toUpperCase())
        : ['GET'];
    } else methods = [deco.toUpperCase()];
    for (const method of methods) {
      items.push({
        category: 'endpoint',
        kind: method,
        name: `${method} ${p}`,
        signature: `${method} ${p}`,
        file,
        confidence: ENDPOINT_CONFIDENCE,
      });
    }
  }
}

export { UNRESOLVED_CONFIDENCE };
