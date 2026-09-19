/**
 * Normalised public API surface. Everything is sorted so the JSON snapshot is
 * byte-stable across runs and diffs are meaningful.
 */
export type SurfaceCategory = 'export' | 'cli' | 'endpoint';

export interface SurfaceItem {
  category: SurfaceCategory;
  /** e.g. "function", "class", "type", "interface", "const", "command", "GET" */
  kind: string;
  /** Unique within its category: export name, command name, "METHOD /path". */
  name: string;
  /** Printed signature or route description. */
  signature: string;
  /** Package-relative source file. */
  file: string;
  /** 0..1 confidence for this item alone. */
  confidence: number;
}

export interface ApiSurface {
  version: 1;
  language: string[];
  items: SurfaceItem[];
}

export interface ApiDiffEntry {
  kind: 'added' | 'removed' | 'changed';
  item: SurfaceItem;
  previous?: SurfaceItem;
}

export interface ApiDiff {
  added: ApiDiffEntry[];
  removed: ApiDiffEntry[];
  changed: ApiDiffEntry[];
}

export function itemKey(i: SurfaceItem): string {
  return `${i.category}\u0000${i.name}`;
}

export function normaliseSurface(items: SurfaceItem[], language: string[]): ApiSurface {
  const byKey = new Map<string, SurfaceItem>();
  for (const it of items) {
    const key = itemKey(it);
    const existing = byKey.get(key);
    // Prefer the higher-confidence duplicate; ties keep the lexically-first file.
    if (
      !existing ||
      it.confidence > existing.confidence ||
      (it.confidence === existing.confidence && it.file < existing.file)
    ) {
      byKey.set(key, { ...it, signature: it.signature.replace(/\s+/g, ' ').trim() });
    }
  }
  const sorted = [...byKey.values()].sort((a, b) =>
    a.category === b.category ? a.name.localeCompare(b.name) : a.category.localeCompare(b.category),
  );
  return { version: 1, language: [...new Set(language)].sort(), items: sorted };
}

export function diffSurface(prev: ApiSurface | undefined, next: ApiSurface): ApiDiff {
  const diff: ApiDiff = { added: [], removed: [], changed: [] };
  const prevMap = new Map((prev?.items ?? []).map((i) => [itemKey(i), i] as const));
  const nextMap = new Map(next.items.map((i) => [itemKey(i), i] as const));
  for (const [key, item] of nextMap) {
    const before = prevMap.get(key);
    if (!before) diff.added.push({ kind: 'added', item });
    else if (before.signature !== item.signature || before.kind !== item.kind) {
      diff.changed.push({ kind: 'changed', item, previous: before });
    }
  }
  for (const [key, item] of prevMap) {
    if (!nextMap.has(key)) diff.removed.push({ kind: 'removed', item });
  }
  return diff;
}

export function surfaceChanged(diff: ApiDiff): boolean {
  return diff.added.length + diff.removed.length + diff.changed.length > 0;
}
