import { Git } from '../git/index.js';
import { log } from '../util/log.js';

export interface CommitPushOptions {
  repoRoot: string;
  branch: string;
  remote?: string;
  message: string;
  authorName: string;
  authorEmail: string;
  /** Regenerate on the current HEAD; return repo-relative files written (empty = nothing to commit). */
  regenerate: () => Promise<string[]>;
  maxAttempts?: number;
  /** For PR mode: push to this branch (force) instead of the target branch. */
  pushBranch?: string;
  force?: boolean;
}

export interface CommitPushResult {
  committed: boolean;
  pushed: boolean;
  sha?: string;
  attempts: number;
  written: string[];
  error?: string;
}

/**
 * Regenerate -> commit -> `pull --rebase` -> push, retried against a moving
 * remote. Because generation is deterministic we never try to resolve a
 * conflict: on any conflict or rejected push we throw the local patch away,
 * reset to the remote branch, regenerate on the new HEAD and try again.
 */
export async function commitAndPush(opts: CommitPushOptions): Promise<CommitPushResult> {
  const git = new Git(opts.repoRoot);
  const remote = opts.remote ?? 'origin';
  const maxAttempts = opts.maxAttempts ?? 3;
  const pushBranch = opts.pushBranch ?? opts.branch;
  let attempts = 0;
  let lastError = '';

  while (attempts < maxAttempts) {
    attempts++;
    const written = await opts.regenerate();
    if (!written.length) return { committed: false, pushed: false, attempts, written: [] };

    await git.add(written);
    await git.commit(opts.message, {
      authorName: opts.authorName,
      authorEmail: opts.authorEmail,
    });

    if (!opts.pushBranch) {
      const rebased = await git.pullRebase(remote, opts.branch);
      if (!rebased.ok) {
        lastError = `rebase conflict: ${rebased.message}`;
        log.warn(`attempt ${attempts}: ${lastError}; discarding local patch and regenerating`);
        await resetToRemote(git, remote, opts.branch);
        continue;
      }
    }
    const pushed = await git.push(remote, pushBranch, { force: !!opts.force });
    if (pushed.ok)
      return { committed: true, pushed: true, sha: await git.headSha(), attempts, written };
    lastError = `push rejected: ${pushed.message}`;
    log.warn(`attempt ${attempts}: ${lastError}; discarding local patch and regenerating`);
    await resetToRemote(git, remote, opts.branch);
  }
  return {
    committed: false,
    pushed: false,
    attempts,
    written: [],
    error: `gave up after ${attempts} attempts: ${lastError}`,
  };
}

async function resetToRemote(git: Git, remote: string, branch: string): Promise<void> {
  await git.fetch(remote, branch);
  await git.resetHard(`${remote}/${branch}`);
}
