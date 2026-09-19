import { createHash } from 'node:crypto';

/** Full sha256 hex digest of a string. */
export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Truncated sha256 used in autogen markers and state files (12 hex chars). */
export function shortHash(input: string): string {
  return sha256(input).slice(0, 12);
}

/**
 * Deterministic JSON serialisation: object keys are sorted recursively so the
 * same logical value always produces the same string (and therefore hash).
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortValue(v);
    }
    return out;
  }
  return value;
}

export function hashValue(value: unknown): string {
  return shortHash(stableStringify(value));
}
