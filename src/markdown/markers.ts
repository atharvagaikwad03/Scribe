import { unified } from 'unified';
import remarkParse from 'remark-parse';
import type { Root, RootContent, Heading, Html } from 'mdast';
import { MarkerError } from '../util/errors.js';
import { shortHash } from '../util/hash.js';

/**
 * A tool-owned region in a README:
 *
 *   <!-- autogen:start:api hash=3f9a1c2b7d10 -->
 *   ...body...
 *   <!-- autogen:end:api -->
 *
 * Offsets are byte offsets into the original document string (JS string
 * indices, which is what we splice with). `bodyStart`/`bodyEnd` delimit the
 * text strictly between the two marker comments, including surrounding
 * newlines.
 */
export interface MarkerRegion {
  id: string;
  /** Hash recorded in the start marker, if any. */
  hash: string | undefined;
  /** Offset of the first char of the start marker. */
  start: number;
  /** Offset just past the last char of the end marker. */
  end: number;
  bodyStart: number;
  bodyEnd: number;
  /** Canonical body: the region text with one leading and trailing newline stripped. */
  body: string;
  /** Extra attributes on the start marker (besides hash). */
  attrs: Record<string, string>;
}

export interface HeadingAnchor {
  depth: number;
  text: string;
  start: number;
  end: number;
}

export interface ParsedReadme {
  source: string;
  regions: MarkerRegion[];
  headings: HeadingAnchor[];
}

const START_RE =
  /^<!--\s*autogen:start:([A-Za-z0-9_-]+)((?:\s+[A-Za-z_][A-Za-z0-9_-]*=[^\s]+)*)\s*-->$/;
const END_RE = /^<!--\s*autogen:end:([A-Za-z0-9_-]+)\s*-->$/;

const processor = unified().use(remarkParse);

export function parseMarkdown(source: string): Root {
  return processor.parse(source) as Root;
}

function* walk(node: Root | RootContent): Generator<RootContent> {
  if ('children' in node && Array.isArray(node.children)) {
    for (const child of node.children as RootContent[]) {
      yield child;
      yield* walk(child);
    }
  }
}

function headingText(node: Heading, source: string): string {
  // Take the raw source of the heading and strip the leading hashes / trailing hashes.
  const raw = source.slice(node.position!.start.offset!, node.position!.end.offset!);
  return raw
    .replace(/^\s*#{1,6}\s*/, '')
    .replace(/\s+#+\s*$/, '')
    .trim();
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const part of raw.trim().split(/\s+/).filter(Boolean)) {
    const eq = part.indexOf('=');
    if (eq > 0) attrs[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return attrs;
}

/**
 * Canonical body from the raw text between two markers. The tool always
 * writes `\n<body>\n`, so strip exactly one leading and one trailing line
 * break. Anything else (e.g. a user who deleted the newline) still hashes
 * deterministically, it just won't match the recorded hash, which is the
 * intended "manual edit" signal.
 */
export function canonicalBody(between: string): string {
  let s = between;
  if (s.startsWith('\r\n')) s = s.slice(2);
  else if (s.startsWith('\n')) s = s.slice(1);
  if (s.endsWith('\r\n')) s = s.slice(0, -2);
  else if (s.endsWith('\n')) s = s.slice(0, -1);
  return s;
}

/**
 * Locate all autogen marker regions and heading anchors. Uses the mdast tree
 * only for *positions*: markers inside fenced code blocks are `code` nodes,
 * not `html`, so they are correctly ignored. The document is never
 * re-serialised.
 *
 * Throws MarkerError on unbalanced, duplicated, nested or mismatched markers.
 */
export function parseReadme(source: string): ParsedReadme {
  const tree = parseMarkdown(source);
  const regions: MarkerRegion[] = [];
  const headings: HeadingAnchor[] = [];
  const seen = new Set<string>();

  let open: {
    id: string;
    hash: string | undefined;
    attrs: Record<string, string>;
    start: number;
    bodyStart: number;
  } | null = null;

  for (const node of walk(tree)) {
    if (!node.position?.start.offset && node.position?.start.offset !== 0) continue;
    if (node.type === 'heading') {
      const h = node as Heading;
      headings.push({
        depth: h.depth,
        text: headingText(h, source),
        start: h.position!.start.offset!,
        end: h.position!.end.offset!,
      });
      continue;
    }
    if (node.type !== 'html') continue;
    const html = node as Html;
    const value = html.value.trim();
    const startMatch = START_RE.exec(value);
    const endMatch = END_RE.exec(value);
    if (!startMatch && !endMatch) continue;

    const nodeStart = html.position!.start.offset!;
    const nodeEnd = html.position!.end.offset!;

    if (startMatch) {
      const id = startMatch[1]!;
      if (open) {
        throw new MarkerError(
          `Nested autogen markers: "autogen:start:${id}" opened while "autogen:start:${open.id}" is still open. Fix the README markers; nothing was changed.`,
        );
      }
      if (seen.has(id)) {
        throw new MarkerError(
          `Duplicate autogen section "${id}". Each section id may appear once per README; nothing was changed.`,
        );
      }
      const attrs = parseAttrs(startMatch[2] ?? '');
      const hash = attrs['hash'];
      delete attrs['hash'];
      open = { id, hash, attrs, start: nodeStart, bodyStart: nodeEnd };
      continue;
    }

    if (endMatch) {
      const id = endMatch[1]!;
      if (!open) {
        throw new MarkerError(
          `Unbalanced autogen markers: "autogen:end:${id}" has no matching start marker; nothing was changed.`,
        );
      }
      if (open.id !== id) {
        throw new MarkerError(
          `Mismatched autogen markers: "autogen:start:${open.id}" is closed by "autogen:end:${id}"; nothing was changed.`,
        );
      }
      const between = source.slice(open.bodyStart, nodeStart);
      regions.push({
        id,
        hash: open.hash,
        attrs: open.attrs,
        start: open.start,
        end: nodeEnd,
        bodyStart: open.bodyStart,
        bodyEnd: nodeStart,
        body: canonicalBody(between),
      });
      seen.add(id);
      open = null;
    }
  }

  if (open) {
    throw new MarkerError(
      `Unbalanced autogen markers: "autogen:start:${open.id}" is never closed; nothing was changed.`,
    );
  }

  regions.sort((a, b) => a.start - b.start);
  return { source, regions, headings };
}

export function bodyHash(body: string): string {
  return shortHash(body);
}

export function renderStartMarker(
  id: string,
  hash: string,
  attrs: Record<string, string> = {},
): string {
  const extra = Object.keys(attrs)
    .sort()
    .map((k) => ` ${k}=${attrs[k]}`)
    .join('');
  return `<!-- autogen:start:${id} hash=${hash}${extra} -->`;
}

export function renderEndMarker(id: string): string {
  return `<!-- autogen:end:${id} -->`;
}

/** Render a complete region (markers + body) in canonical form. */
export function renderRegion(id: string, body: string, attrs: Record<string, string> = {}): string {
  const canonical = body.replace(/\s+$/, '');
  const hash = bodyHash(canonical);
  return `${renderStartMarker(id, hash, attrs)}\n${canonical}\n${renderEndMarker(id)}`;
}

/**
 * Replace the region's markers+body with a freshly rendered region. Only the
 * characters in [region.start, region.end) are replaced; every byte outside
 * is copied through unchanged.
 */
export function spliceRegion(source: string, region: MarkerRegion, newBody: string): string {
  const rendered = renderRegion(region.id, newBody, region.attrs);
  return source.slice(0, region.start) + rendered + source.slice(region.end);
}

/**
 * Apply several body replacements at once. Regions are spliced from the end of
 * the document backwards so earlier offsets stay valid.
 */
export function spliceMany(
  source: string,
  updates: Array<{ region: MarkerRegion; body: string }>,
): string {
  const sorted = [...updates].sort((a, b) => b.region.start - a.region.start);
  let out = source;
  for (const { region, body } of sorted) {
    out = spliceRegion(out, region, body);
  }
  verifyStructurePreserved(source, out);
  return out;
}

/**
 * Fail closed: a rendered body must not change the marker structure of the
 * document (e.g. an unclosed code fence in a body would swallow the end
 * marker). Re-parse the result and require the same region ids in the same
 * order, otherwise throw and leave the caller's file untouched.
 */
export function verifyStructurePreserved(before: string, after: string): void {
  const a = parseReadme(before).regions.map((r) => r.id);
  let b: string[];
  try {
    b = parseReadme(after).regions.map((r) => r.id);
  } catch (err) {
    throw new MarkerError(
      `Refusing to write: the rendered content would corrupt the marker structure (${(err as Error).message})`,
    );
  }
  if (a.length !== b.length || a.some((id, i) => id !== b[i])) {
    throw new MarkerError(
      `Refusing to write: rendered content changed the set of autogen sections (${a.join(',')} -> ${b.join(',')})`,
    );
  }
}

/** True when the recorded hash matches the body actually present. */
export function regionIsPristine(region: MarkerRegion): boolean {
  if (region.hash === undefined) return true; // never written by the tool yet
  return bodyHash(region.body) === region.hash;
}

/** Find the heading whose text equals `anchor` (case-insensitive, `#` prefix optional). */
export function findHeading(parsed: ParsedReadme, anchor: string): HeadingAnchor | undefined {
  const wanted = anchor
    .replace(/^\s*#{1,6}\s*/, '')
    .trim()
    .toLowerCase();
  return parsed.headings.find((h) => h.text.toLowerCase() === wanted);
}

/** Offset where the content under `heading` ends: the next heading of depth <= heading.depth, or EOF. */
export function headingContentEnd(parsed: ParsedReadme, heading: HeadingAnchor): number {
  const later = parsed.headings.filter((h) => h.start > heading.start && h.depth <= heading.depth);
  return later.length ? later[0]!.start : parsed.source.length;
}
