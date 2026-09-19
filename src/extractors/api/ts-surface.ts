import path from 'node:path';
import ts from 'typescript';
import type { SurfaceItem } from './surface.js';
import { readPackageJson } from '../manifest.js';
import { exists } from '../../util/fs.js';

export interface TsSurfaceResult {
  items: SurfaceItem[];
  entryFiles: string[];
  diagnostics: string[];
  /** 0..1: lowered when entry files fail to parse. */
  confidence: number;
}

const SRC_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.jsx'];

/** Map a built output path (dist/index.js) back to a source file if one exists. */
async function toSourceCandidates(dir: string, declared: string): Promise<string[]> {
  const clean = declared.replace(/^\.\//, '');
  const noExt = clean.replace(/\.(d\.ts|js|mjs|cjs|ts|tsx|jsx|mts|cts)$/, '');
  const bases = new Set<string>([noExt]);
  for (const out of ['dist', 'lib', 'build', 'out', 'esm', 'cjs']) {
    if (noExt.startsWith(out + '/')) {
      bases.add('src/' + noExt.slice(out.length + 1));
      bases.add(noExt.slice(out.length + 1));
    }
  }
  const found: string[] = [];
  for (const base of bases) {
    for (const ext of SRC_EXTS) {
      const p = base + ext;
      if (await exists(path.join(dir, p))) found.push(p);
    }
    for (const ext of SRC_EXTS) {
      const p = base + '/index' + ext;
      if (await exists(path.join(dir, p))) found.push(p);
    }
  }
  return found;
}

function collectExportTargets(exp: unknown, out: string[]): void {
  if (typeof exp === 'string') out.push(exp);
  else if (Array.isArray(exp)) exp.forEach((e) => collectExportTargets(e, out));
  else if (exp && typeof exp === 'object') {
    for (const [k, v] of Object.entries(exp as Record<string, unknown>)) {
      if (k === 'types' || k === 'require') continue; // prefer import/default/source
      collectExportTargets(v, out);
    }
  }
}

/** Determine the public entry files (package-relative) of a JS/TS package. */
export async function findTsEntryFiles(dir: string): Promise<string[]> {
  const pkg = await readPackageJson(dir);
  const declared: string[] = [];
  if (pkg) {
    if (pkg.exports) collectExportTargets(pkg.exports, declared);
    if (pkg.module) declared.push(pkg.module);
    if (pkg.main) declared.push(pkg.main);
    if (pkg.types) declared.push(pkg.types);
  }
  const found = new Set<string>();
  for (const d of declared) for (const c of await toSourceCandidates(dir, d)) found.add(c);
  if (!found.size) {
    for (const c of [
      'src/index.ts',
      'src/index.tsx',
      'src/index.mts',
      'index.ts',
      'src/index.js',
      'src/index.mjs',
      'index.js',
      'index.mjs',
      'src/main.ts',
      'lib/index.js',
    ]) {
      if (await exists(path.join(dir, c))) {
        found.add(c);
        break;
      }
    }
  }
  // Prefer .ts over .js twins of the same base.
  const list = [...found].sort();
  const byBase = new Map<string, string>();
  for (const f of list) {
    const base = f.replace(/\.[^.]+$/, '');
    const prev = byBase.get(base);
    if (!prev || (/\.tsx?$/.test(f) && !/\.tsx?$/.test(prev))) byBase.set(base, f);
  }
  return [...byBase.values()].sort();
}

function loadCompilerOptions(dir: string): { options: ts.CompilerOptions; diagnostics: string[] } {
  const diagnostics: string[] = [];
  const configPath = ts.findConfigFile(dir, ts.sys.fileExists, 'tsconfig.json');
  let options: ts.CompilerOptions = {
    allowJs: true,
    checkJs: false,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    esModuleInterop: true,
    resolveJsonModule: true,
    strict: true,
  };
  if (configPath && path.resolve(configPath).startsWith(path.resolve(dir))) {
    const read = ts.readConfigFile(configPath, ts.sys.readFile);
    if (read.error)
      diagnostics.push(
        `tsconfig.json: ${ts.flattenDiagnosticMessageText(read.error.messageText, ' ')}`,
      );
    else {
      const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(configPath));
      options = {
        ...parsed.options,
        noEmit: true,
        skipLibCheck: true,
        allowJs: parsed.options.allowJs ?? true,
      };
      delete options.composite;
      delete options.incremental;
      delete options.tsBuildInfoFile;
      delete options.declaration;
      delete options.declarationDir;
      delete options.outDir;
    }
  }
  return { options, diagnostics };
}

const KIND_ORDER = [
  'function',
  'class',
  'interface',
  'type',
  'enum',
  'const',
  'namespace',
  'unknown',
];

function symbolKind(sym: ts.Symbol): string {
  const f = sym.flags;
  if (f & ts.SymbolFlags.Function) return 'function';
  if (f & ts.SymbolFlags.Class) return 'class';
  if (f & ts.SymbolFlags.Interface) return 'interface';
  if (f & ts.SymbolFlags.TypeAlias) return 'type';
  if (f & ts.SymbolFlags.Enum) return 'enum';
  if (f & ts.SymbolFlags.Variable) return 'const';
  if (f & (ts.SymbolFlags.NamespaceModule | ts.SymbolFlags.ValueModule)) return 'namespace';
  return 'unknown';
}

const FMT = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope;

function oneLine(s: string, max = 240): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function declText(decl: ts.Node): string {
  // Strip leading `export`/`declare`/`default` keywords and any body.
  let text = decl.getText();
  text = text.replace(/^\s*export\s+(default\s+)?(declare\s+)?/, '');
  return text;
}

function signatureFor(
  checker: ts.TypeChecker,
  sym: ts.Symbol,
  exportName: string,
  kind: string,
): string {
  const decls = sym.getDeclarations() ?? [];
  switch (kind) {
    case 'function': {
      const sigs: string[] = [];
      for (const d of decls) {
        if (
          ts.isFunctionDeclaration(d) ||
          ts.isMethodDeclaration(d) ||
          ts.isFunctionExpression(d) ||
          ts.isArrowFunction(d)
        ) {
          const sig = checker.getSignatureFromDeclaration(d as ts.SignatureDeclaration);
          if (sig) sigs.push(`${exportName}${checker.signatureToString(sig, d, FMT)}`);
        }
      }
      if (!sigs.length) {
        const type = checker.getTypeOfSymbolAtLocation(sym, decls[0] ?? sym.valueDeclaration!);
        for (const sig of type.getCallSignatures())
          sigs.push(`${exportName}${checker.signatureToString(sig, undefined, FMT)}`);
      }
      return oneLine(sigs.join(' | ') || `${exportName}(...)`);
    }
    case 'class': {
      const d = decls.find(ts.isClassDeclaration) ?? decls.find(ts.isClassExpression);
      const parts: string[] = [];
      if (d) {
        const ctor = d.members.find(ts.isConstructorDeclaration);
        const ctorParams = ctor
          ? `(${ctor.parameters
              .map((p) => {
                const t = p.type ? `: ${p.type.getText()}` : '';
                const q = p.questionToken || p.initializer ? '?' : '';
                return `${p.dotDotDotToken ? '...' : ''}${p.name.getText()}${q}${t}`;
              })
              .join(', ')})`
          : '';
        parts.push(`class ${exportName}${ctorParams}`);
        const members: string[] = [];
        for (const m of d.members) {
          if (
            !ts.isMethodDeclaration(m) &&
            !ts.isPropertyDeclaration(m) &&
            !ts.isGetAccessorDeclaration(m)
          )
            continue;
          const mods = ts.getCombinedModifierFlags(m);
          if (mods & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) continue;
          if (m.name && ts.isPrivateIdentifier(m.name)) continue;
          const name = m.name?.getText() ?? '';
          const isStatic = !!(mods & ts.ModifierFlags.Static);
          if (ts.isMethodDeclaration(m)) {
            const sig = checker.getSignatureFromDeclaration(m);
            members.push(
              `${isStatic ? 'static ' : ''}${name}${sig ? checker.signatureToString(sig, m, FMT) : '()'}`,
            );
          } else {
            const t = checker.getTypeAtLocation(m);
            members.push(`${isStatic ? 'static ' : ''}${name}: ${checker.typeToString(t, m, FMT)}`);
          }
        }
        members.sort();
        if (members.length) parts.push(`{ ${members.join('; ')} }`);
      } else parts.push(`class ${exportName}`);
      return oneLine(parts.join(' '), 400);
    }
    case 'interface':
    case 'type':
    case 'enum': {
      const d = decls[0];
      if (!d) return `${kind} ${exportName}`;
      return oneLine(declText(d).replace(/^(interface|type|enum)\s+\w+/, `$1 ${exportName}`), 400);
    }
    case 'const': {
      const d = sym.valueDeclaration ?? decls[0];
      const type = d ? checker.getTypeOfSymbolAtLocation(sym, d) : undefined;
      const t = type ? checker.typeToString(type, d, FMT) : 'unknown';
      // Function-valued consts read better as call signatures.
      if (type && type.getCallSignatures().length && !type.getProperties().length) {
        return oneLine(
          type
            .getCallSignatures()
            .map((s) => `${exportName}${checker.signatureToString(s, d, FMT)}`)
            .join(' | '),
        );
      }
      return oneLine(`const ${exportName}: ${t}`);
    }
    case 'namespace':
      return `namespace ${exportName}`;
    default:
      return exportName;
  }
}

/**
 * Extract the exported surface of the package's entry files with the
 * TypeScript compiler API. Deterministic: symbols are sorted by name.
 */
export async function extractTsSurface(dir: string): Promise<TsSurfaceResult> {
  const entryFiles = await findTsEntryFiles(dir);
  const diagnostics: string[] = [];
  if (!entryFiles.length)
    return {
      items: [],
      entryFiles,
      diagnostics: ['No JS/TS entry file found (package.json main/exports or src/index.*).'],
      confidence: 1,
    };

  const { options, diagnostics: cfgDiag } = loadCompilerOptions(dir);
  diagnostics.push(...cfgDiag);
  const rootNames = entryFiles.map((f) => path.join(dir, f));
  const program = ts.createProgram({ rootNames, options });
  const checker = program.getTypeChecker();
  const items: SurfaceItem[] = [];
  let confidence = 1;

  for (const rel of entryFiles) {
    const sf = program.getSourceFile(path.join(dir, rel));
    if (!sf) {
      diagnostics.push(`Could not load ${rel}`);
      confidence = Math.min(confidence, 0.5);
      continue;
    }
    const syntax = program.getSyntacticDiagnostics(sf);
    if (syntax.length) {
      diagnostics.push(
        `${rel}: ${syntax.length} syntax error(s): ${ts.flattenDiagnosticMessageText(syntax[0]!.messageText, ' ')}`,
      );
      confidence = Math.min(confidence, 0.5);
    }
    const moduleSymbol = checker.getSymbolAtLocation(sf);
    if (!moduleSymbol) {
      // Script (no exports) or CommonJS without module.exports the checker understands.
      diagnostics.push(`${rel} has no ES module exports.`);
      continue;
    }
    for (const exp of checker.getExportsOfModule(moduleSymbol)) {
      const exportName = exp.getName();
      if (exportName === '__esModule' || exportName.startsWith('__')) continue;
      let target = exp;
      if (exp.flags & ts.SymbolFlags.Alias) {
        try {
          target = checker.getAliasedSymbol(exp);
        } catch {
          target = exp;
        }
      }
      if (exportName === 'default') {
        const kind = symbolKind(target);
        items.push({
          category: 'export',
          kind,
          name: 'default',
          signature: signatureFor(
            checker,
            target,
            target.getName() === 'default' ? 'default' : target.getName(),
            kind,
          ),
          file: rel,
          confidence: 1,
        });
        continue;
      }
      const kind = symbolKind(target);
      // A symbol can be both a value and a type (e.g. class + interface merge, or const + type alias). Report once.
      const decl = target.getDeclarations()?.[0];
      const declFile = decl
        ? path.relative(dir, decl.getSourceFile().fileName).split(path.sep).join('/')
        : rel;
      items.push({
        category: 'export',
        kind,
        name: exportName,
        signature: signatureFor(checker, target, exportName, kind),
        file: declFile.startsWith('..') || declFile.includes('node_modules') ? rel : declFile,
        confidence: 1,
      });
    }
  }
  items.sort(
    (a, b) =>
      a.name.localeCompare(b.name) || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind),
  );
  return { items, entryFiles, diagnostics, confidence };
}
