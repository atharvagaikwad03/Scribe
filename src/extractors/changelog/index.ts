import type { ExtractContext, ExtractResult, SectionGenerator } from '../types.js';
import type { ApiChangeEntry, ChangelogEntry, HighlightEntry } from '../../state/index.js';
import {
  GROUP_ORDER,
  groupOf,
  isToolCommit,
  parseConventional,
  type Group,
} from './conventional.js';
import { flushLlmCache, summariseWithLlm, type CommitStat } from './llm.js';
import { STATE_DIR } from '../../config/schema.js';

export interface ChangelogData {
  entries: ChangelogEntry[];
  apiChanges: ApiChangeEntry[];
  highlights: HighlightEntry[];
}

const MAX_LLM_COMMITS = 30;

export const changelogGenerator: SectionGenerator<ChangelogData> = {
  id: 'changelog',
  defaultWatch: [],
  alwaysRun: true,

  async extract(ctx: ExtractContext): Promise<ExtractResult<ChangelogData>> {
    const { git, state, config } = ctx;
    const max = config.changelog.maxEntries;
    const diagnostics: string[] = [];

    // Commits since the last run. First run: the most recent `max` commits.
    const base = ctx.fullMode ? undefined : (state.lastSha ?? undefined);
    const paths = ctx.pkg.path === '.' ? undefined : [ctx.pkg.path];
    const commits = (
      await git.commitsBetween(base, ctx.headSha, { limit: base ? 2000 : max, paths })
    ).filter((c) => !isToolCommit(c, config.changelog.skipTrailer));
    const known = new Set(state.changelog.entries.map((e) => e.sha));
    const fresh = commits.filter((c) => !known.has(c.sha));
    const newEntries = fresh.map(parseConventional);

    // Append-only, newest first, deduped by SHA, capped.
    const entries = [...newEntries, ...state.changelog.entries]
      .filter((e, i, arr) => arr.findIndex((x) => x.sha === e.sha) === i)
      .slice(0, max);

    // API changes from the surface diff computed earlier in this run.
    const diff = ctx.shared.apiDiff;
    const newApi: ApiChangeEntry[] = [];
    if (diff && ctx.shared.previousSurface) {
      for (const e of [...diff.added, ...diff.changed, ...diff.removed]) {
        newApi.push({
          sha: ctx.headSha,
          kind: e.kind,
          category: e.item.category,
          name: e.item.name,
          ...(e.kind !== 'removed' ? { signature: e.item.signature } : {}),
          ...(e.previous ? { previous: e.previous.signature } : {}),
        });
      }
    }
    const apiKey = (a: ApiChangeEntry) => `${a.sha}|${a.kind}|${a.category}|${a.name}`;
    const apiChanges = [...newApi, ...state.changelog.apiChanges]
      .filter((a, i, arr) => arr.findIndex((x) => apiKey(x) === apiKey(a)) === i)
      .slice(0, max);

    // Optional LLM highlights, for the *new* commits only, validated and cached.
    let highlights: HighlightEntry[] = state.changelog.highlights ?? [];
    if (ctx.llm && fresh.length) {
      const subset = fresh.slice(0, MAX_LLM_COMMITS);
      const stats: CommitStat[] = [];
      for (const c of subset)
        stats.push({ sha: c.sha, subject: c.subject, ...(await git.shortStat(c.sha)) });
      const res = await summariseWithLlm(ctx.llm, config, ctx.repoRoot, subset, stats);
      if (res.rejected) diagnostics.push(`${res.rejected}; using deterministic rendering`);
      else highlights = [...res.bullets, ...highlights];
    }
    const entrySet = new Set(entries.map((e) => e.sha));
    highlights = highlights
      .filter(
        (h, i, arr) =>
          entrySet.has(h.sha) && arr.findIndex((x) => x.sha === h.sha && x.text === h.text) === i,
      )
      .slice(0, max);

    ctx.stateAfter.changelog = {
      entries,
      apiChanges,
      ...(highlights.length ? { highlights } : {}),
    };
    if (!entries.length) diagnostics.push('No commits found.');
    return { data: { entries, apiChanges, highlights }, confidence: 1, diagnostics };
  },

  render(data: ChangelogData): string {
    const parts: string[] = [];
    if (data.highlights.length) {
      parts.push('**Highlights**\n');
      parts.push(data.highlights.map((h) => `- ${h.text}`).join('\n') + '\n');
    }
    const groups = new Map<Group, ChangelogEntry[]>();
    for (const e of data.entries) {
      const g = groupOf(e);
      groups.set(g, [...(groups.get(g) ?? []), e]);
    }
    for (const g of GROUP_ORDER) {
      const list = groups.get(g);
      if (!list?.length) continue;
      parts.push(`**${g === 'Breaking' ? 'Breaking changes' : g}**\n`);
      parts.push(
        list
          .map(
            (e) =>
              `- ${e.scope ? `**${e.scope}:** ` : ''}${escapeMd(e.subject)} (\`${e.sha.slice(0, 7)}\`)`,
          )
          .join('\n') + '\n',
      );
    }
    if (data.apiChanges.length) {
      parts.push('**API changes**\n');
      parts.push(
        data.apiChanges
          .map((a) => {
            const label =
              a.category === 'endpoint' ? 'endpoint' : a.category === 'cli' ? 'command' : 'export';
            if (a.kind === 'added') return `- Added ${label} ${code(a.signature ?? a.name)}`;
            if (a.kind === 'removed') return `- Removed ${label} ${code(a.name)}`;
            return `- Changed ${label} ${code(a.name)}: ${code(a.previous ?? '?')} → ${code(a.signature ?? '?')}`;
          })
          .join('\n') + '\n',
      );
    }
    if (!parts.length) return '_No changes recorded yet._';
    return parts.join('\n');
  },

  async afterWrite(_data: ChangelogData, ctx: ExtractContext): Promise<string[]> {
    return (await flushLlmCache(ctx.repoRoot)) ? [`${STATE_DIR}/llm-cache.json`] : [];
  },
};

function code(s: string): string {
  return s.includes('`') ? `\`\` ${s} \`\`` : `\`${s}\``;
}

function escapeMd(s: string): string {
  // Keep commit subjects readable; only neutralise constructs that would break list structure.
  return s.replace(/^([#>]|[-*+]\s|\d+\.\s)/, '\\$1');
}
