import path from 'node:path';
import type { LlmProvider } from '../../llm/provider.js';
import type { Config } from '../../config/schema.js';
import type { Commit } from '../../git/index.js';
import { readJsonIfExists, writeJson } from '../../util/fs.js';
import { hashValue } from '../../util/hash.js';
import { STATE_DIR } from '../../config/schema.js';

export interface CommitStat {
  sha: string;
  subject: string;
  files: number;
  insertions: number;
  deletions: number;
}

export interface HighlightResult {
  bullets: Array<{ sha: string; text: string }>;
  /** Why the LLM output was not used, if it wasn't. */
  rejected?: string;
  fromCache: boolean;
}

const SYSTEM = `You write terse changelog highlights for a project README.
Rules:
- Output ONLY markdown bullets, one per line, starting with "- ".
- Each bullet must end with the 7-character commit SHA in parentheses, e.g. "(a1b2c3d)". Use only SHAs from the input.
- Group closely related commits into one bullet when it helps; never mention a change that is not in the input.
- No headings, no preamble, no trailing notes. Max 8 bullets.`;

export function buildPrompt(stats: CommitStat[]): string {
  const lines = stats.map(
    (s) =>
      `${s.sha.slice(0, 7)}  ${s.subject}  [${s.files} files, +${s.insertions} -${s.deletions}]`,
  );
  return `Commits (newest first):\n${lines.join('\n')}\n\nWrite the highlights.`;
}

/**
 * Validate the model output: every bullet must reference a SHA (7+ hex chars)
 * that is a prefix of one of the input commits. One bad bullet rejects the
 * whole response, and the caller falls back to deterministic rendering.
 */
export function validateBullets(
  text: string,
  inputShas: string[],
): { ok: true; bullets: Array<{ sha: string; text: string }> } | { ok: false; reason: string } {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return { ok: false, reason: 'empty response' };
  const bullets: Array<{ sha: string; text: string }> = [];
  for (const line of lines) {
    if (!/^[-*]\s+/.test(line))
      return { ok: false, reason: `non-bullet line: "${line.slice(0, 60)}"` };
    const refs = [...line.matchAll(/\b([0-9a-f]{7,40})\b/g)].map((m) => m[1]!);
    if (!refs.length) return { ok: false, reason: `bullet without a SHA: "${line.slice(0, 60)}"` };
    const full: string[] = [];
    for (const ref of refs) {
      const match = inputShas.find((s) => s.startsWith(ref));
      if (!match) return { ok: false, reason: `bullet references unknown SHA ${ref}` };
      full.push(match);
    }
    const clean = line.replace(/^[-*]\s+/, '').trim();
    if (clean.length > 300) return { ok: false, reason: 'bullet too long' };
    bullets.push({ sha: full[0]!, text: clean });
  }
  return { ok: true, bullets };
}

type Cache = Record<string, Array<{ sha: string; text: string }>>;

export function cachePath(repoRoot: string): string {
  return path.join(repoRoot, STATE_DIR, 'llm-cache.json');
}

/** Pending cache writes, flushed by the changelog generator's afterWrite. */
export const pendingCache = new Map<string, Array<{ sha: string; text: string }>>();

export async function summariseWithLlm(
  provider: LlmProvider,
  config: Config,
  repoRoot: string,
  commits: Commit[],
  stats: CommitStat[],
): Promise<HighlightResult> {
  const key = hashValue({ provider: provider.name, model: config.llm.model, stats });
  const cache = (await readJsonIfExists<Cache>(cachePath(repoRoot))) ?? {};
  if (cache[key]) return { bullets: cache[key], fromCache: true };
  let text: string;
  try {
    text = await provider.complete({
      system: SYSTEM,
      prompt: buildPrompt(stats),
      maxTokens: config.llm.maxTokens,
      model: config.llm.model,
    });
  } catch (err) {
    return {
      bullets: [],
      rejected: `LLM call failed: ${(err as Error).message}`,
      fromCache: false,
    };
  }
  const v = validateBullets(
    text,
    commits.map((c) => c.sha),
  );
  if (!v.ok) return { bullets: [], rejected: `LLM output rejected: ${v.reason}`, fromCache: false };
  pendingCache.set(key, v.bullets);
  return { bullets: v.bullets, fromCache: false };
}

export async function flushLlmCache(repoRoot: string): Promise<boolean> {
  if (!pendingCache.size) return false;
  const file = cachePath(repoRoot);
  const cache = (await readJsonIfExists<Cache>(file)) ?? {};
  for (const [k, v] of pendingCache) cache[k] = v;
  pendingCache.clear();
  await writeJson(file, cache);
  return true;
}
