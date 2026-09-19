import path from 'node:path';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import { run } from '../../git/index.js';
import type { SurfaceItem } from './surface.js';
import { readPyProject } from '../manifest.js';
import { exists } from '../../util/fs.js';

export interface PySurfaceResult {
  items: SurfaceItem[];
  entryFiles: string[];
  diagnostics: string[];
  confidence: number;
}

/**
 * The helper is embedded as a string (rather than shipped as a .py file) so
 * the bundled CLI / Action is a single self-contained JS file. It is written
 * to a temp file and executed with the system python3. Requires Python 3.9+
 * (ast.unparse).
 */
export const PYTHON_SURFACE_SCRIPT = String.raw`
import ast, json, os, sys

def unparse(node):
    try:
        return ast.unparse(node)
    except Exception:
        return "..."

def func_sig(node, name=None):
    name = name or node.name
    args = unparse(node.args)
    ret = " -> " + unparse(node.returns) if node.returns else ""
    prefix = "async def " if isinstance(node, ast.AsyncFunctionDef) else "def "
    return prefix + name + "(" + args + ")" + ret

def class_sig(node, name=None):
    name = name or node.name
    bases = ", ".join(unparse(b) for b in node.bases)
    methods = []
    for item in node.body:
        if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)) and not item.name.startswith("_"):
            methods.append(func_sig(item).replace("def ", "", 1))
        elif isinstance(item, ast.FunctionDef) and item.name == "__init__":
            methods.append(func_sig(item).replace("def ", "", 1))
    methods.sort()
    sig = "class " + name + ("(" + bases + ")" if bases else "")
    if methods:
        sig += " { " + "; ".join(methods) + " }"
    return sig

def module_defs(tree):
    """name -> (kind, signature) for top-level definitions."""
    defs = {}
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            defs[node.name] = ("function", func_sig(node))
        elif isinstance(node, ast.ClassDef):
            defs[node.name] = ("class", class_sig(node))
        elif isinstance(node, ast.Assign):
            for t in node.targets:
                if isinstance(t, ast.Name):
                    defs[t.id] = ("const", t.id + " = " + unparse(node.value)[:80])
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            defs[node.target.id] = ("const", node.target.id + ": " + unparse(node.annotation))
    return defs

def imports(tree):
    """imported local name -> (module, original name, level)"""
    out = {}
    for node in tree.body:
        if isinstance(node, ast.ImportFrom):
            for a in node.names:
                out[a.asname or a.name] = (node.module or "", a.name, node.level)
    return out

def dunder_all(tree):
    for node in tree.body:
        if isinstance(node, ast.Assign):
            for t in node.targets:
                if isinstance(t, ast.Name) and t.id == "__all__":
                    try:
                        return [str(x) for x in ast.literal_eval(node.value)]
                    except Exception:
                        return None
    return None

def resolve_module(pkg_dir, rel_module, level, cur_file):
    base = os.path.dirname(cur_file)
    for _ in range(level - 1):
        base = os.path.dirname(base)
    parts = rel_module.split(".") if rel_module else []
    cand = os.path.join(base, *parts)
    if os.path.isfile(cand + ".py"):
        return cand + ".py"
    if os.path.isfile(os.path.join(cand, "__init__.py")):
        return os.path.join(cand, "__init__.py")
    return None

def parse(path):
    with open(path, "r", encoding="utf-8") as f:
        return ast.parse(f.read(), filename=path)

def surface(root, entry):
    diagnostics = []
    items = []
    try:
        tree = parse(entry)
    except SyntaxError as e:
        return [], ["%s: syntax error: %s" % (os.path.relpath(entry, root), e)], 0.5
    defs = module_defs(tree)
    imps = imports(tree)
    names = dunder_all(tree)
    explicit = names is not None
    if names is None:
        names = sorted(set([n for n in defs if not n.startswith("_")] + [n for n in imps if not n.startswith("_") and imps[n][2] > 0]))
    for name in sorted(set(names)):
        rel = os.path.relpath(entry, root).replace(os.sep, "/")
        if name in defs:
            kind, sig = defs[name]
            items.append({"kind": kind, "name": name, "signature": sig, "file": rel})
            continue
        if name in imps:
            module, orig, level = imps[name]
            target = resolve_module(root, module, level, entry) if level > 0 else None
            if target:
                try:
                    tdefs = module_defs(parse(target))
                except SyntaxError as e:
                    diagnostics.append("%s: syntax error: %s" % (os.path.relpath(target, root), e))
                    continue
                if orig in tdefs:
                    kind, sig = tdefs[orig]
                    if name != orig:
                        sig = sig.replace(orig, name, 1)
                    items.append({"kind": kind, "name": name, "signature": sig, "file": os.path.relpath(target, root).replace(os.sep, "/")})
                    continue
                items.append({"kind": "re-export", "name": name, "signature": name + " (from ." + module + ")", "file": rel})
                continue
            items.append({"kind": "re-export", "name": name, "signature": name + " (from " + (module or "?") + ")", "file": rel})
            continue
        if explicit:
            diagnostics.append("%s: __all__ lists '%s' but it is not defined or imported at module level" % (rel, name))
    return items, diagnostics, 1.0

def main():
    root = sys.argv[1]
    entries = sys.argv[2:]
    all_items, all_diag, conf = [], [], 1.0
    for e in entries:
        items, diag, c = surface(root, os.path.join(root, e))
        all_items.extend(items)
        all_diag.extend(diag)
        conf = min(conf, c)
    json.dump({"items": all_items, "diagnostics": all_diag, "confidence": conf, "python": sys.version.split()[0]}, sys.stdout)

main()
`;

async function findPython(): Promise<string | undefined> {
  for (const cmd of [process.env.READMESYNC_PYTHON, 'python3', 'python']) {
    if (!cmd) continue;
    const r = await run(
      cmd,
      ['-c', 'import sys; print(sys.version_info[0]*100+sys.version_info[1])'],
      { cwd: process.cwd(), allowFailure: true },
    ).catch(() => undefined);
    if (r && r.code === 0 && Number(r.stdout.trim()) >= 309) return cmd;
  }
  return undefined;
}

/** Public package entry files (`__init__.py`) or top-level modules of a Python project. */
export async function findPythonEntryFiles(dir: string, files: string[]): Promise<string[]> {
  const py = await readPyProject(dir);
  const names = new Set<string>();
  const projName = (py?.project?.name ?? py?.tool?.poetry?.name) as string | undefined;
  if (projName) names.add(projName.toLowerCase().replace(/-/g, '_'));
  for (const p of (py?.tool?.poetry?.packages as
    Array<{ include?: string; from?: string }> | undefined) ?? []) {
    if (p.include) names.add(p.include);
  }
  const out: string[] = [];
  for (const n of names) {
    for (const c of [`src/${n}/__init__.py`, `${n}/__init__.py`, `src/${n}.py`, `${n}.py`]) {
      if (await exists(path.join(dir, c))) {
        out.push(c);
        break;
      }
    }
  }
  if (!out.length) {
    // Any top-level package (dir with __init__.py) directly under root or src/, excluding tests.
    const pkgs = files.filter(
      (f) =>
        /^(src\/)?[A-Za-z_][A-Za-z0-9_]*\/__init__\.py$/.test(f) && !/^(src\/)?tests?\//.test(f),
    );
    out.push(...pkgs);
  }
  if (!out.length) {
    out.push(
      ...files.filter(
        (f) =>
          /^[A-Za-z_][A-Za-z0-9_]*\.py$/.test(f) &&
          !/^(setup|conftest|test_.*|.*_test)\.py$/.test(f),
      ),
    );
  }
  return [...new Set(out)].sort();
}

export async function extractPythonSurface(dir: string, files: string[]): Promise<PySurfaceResult> {
  const entryFiles = await findPythonEntryFiles(dir, files);
  if (!entryFiles.length)
    return {
      items: [],
      entryFiles,
      diagnostics: ['No Python package or module found.'],
      confidence: 1,
    };
  const python = await findPython();
  if (!python) {
    return {
      items: [],
      entryFiles,
      diagnostics: ['python3 (>= 3.9) not found on PATH; cannot extract the Python API surface.'],
      confidence: 0,
    };
  }
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'readme-sync-py-'));
  const script = path.join(tmp, 'surface.py');
  try {
    await fs.writeFile(script, PYTHON_SURFACE_SCRIPT, 'utf8');
    const r = await run(python, [script, dir, ...entryFiles], { cwd: dir, allowFailure: true });
    if (r.code !== 0) {
      return {
        items: [],
        entryFiles,
        diagnostics: [
          `Python surface helper failed: ${r.stderr.trim().split('\n').pop() ?? 'unknown error'}`,
        ],
        confidence: 0,
      };
    }
    const parsed = JSON.parse(r.stdout) as {
      items: Array<{ kind: string; name: string; signature: string; file: string }>;
      diagnostics: string[];
      confidence: number;
    };
    const items: SurfaceItem[] = parsed.items.map((i) => ({
      category: 'export',
      kind: i.kind,
      name: i.name,
      signature: i.signature,
      file: i.file,
      confidence: 1,
    }));
    return { items, entryFiles, diagnostics: parsed.diagnostics, confidence: parsed.confidence };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
