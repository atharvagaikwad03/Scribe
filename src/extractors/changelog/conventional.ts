import type { Commit } from '../../git/index.js';
import type { ChangelogEntry } from '../../state/index.js';

const CC_RE = /^(\w+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/;

export type Group = 'Breaking' | 'Features' | 'Fixes' | 'Other';

export function parseConventional(commit: Commit): ChangelogEntry {
  const subject = commit.subject
    .replace(/\s*\[(skip ci|ci skip|no ci)\]\s*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const m = CC_RE.exec(subject);
  const breakingBody = /(^|\n)BREAKING[ -]CHANGE:/.test(commit.body);
  if (!m) return { sha: commit.sha, type: 'other', breaking: breakingBody, subject };
  const [, type, scope, bang, desc] = m;
  return {
    sha: commit.sha,
    type: type!.toLowerCase(),
    ...(scope ? { scope } : {}),
    breaking: !!bang || breakingBody,
    subject: desc!.trim(),
  };
}

export function groupOf(e: ChangelogEntry): Group {
  if (e.breaking) return 'Breaking';
  if (e.type === 'feat' || e.type === 'feature') return 'Features';
  if (e.type === 'fix' || e.type === 'bugfix' || e.type === 'hotfix') return 'Fixes';
  return 'Other';
}

export const GROUP_ORDER: Group[] = ['Breaking', 'Features', 'Fixes', 'Other'];

/** True when the commit was authored by readme-sync itself (loop guard for the changelog). */
export function isToolCommit(commit: Commit, trailer: string): boolean {
  const t = trailer.toLowerCase();
  return commit.body.toLowerCase().includes(t) || commit.subject.toLowerCase().includes(t);
}
