import { spawn } from 'node:child_process';
import { GitError } from '../util/errors.js';

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export async function run(
  cmd: string,
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv; input?: string; allowFailure?: boolean },
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => {
      const result = { stdout, stderr, code: code ?? -1 };
      if (result.code !== 0 && !opts.allowFailure) {
        reject(
          new GitError(
            `${cmd} ${args.join(' ')} failed (${result.code}): ${stderr.trim() || stdout.trim()}`,
          ),
        );
      } else {
        resolve(result);
      }
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

export type ChangeStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U' | 'X';

export interface ChangedFile {
  status: ChangeStatus;
  /** Current path (for renames: the new path). */
  path: string;
  /** Previous path for renames/copies. */
  from?: string;
}

export interface Commit {
  sha: string;
  subject: string;
  body: string;
  authorName: string;
  authorEmail: string;
}

/** Thin, dependency-free wrapper around the `git` CLI for one repository. */
export class Git {
  constructor(readonly cwd: string) {}

  async git(
    args: string[],
    opts: { allowFailure?: boolean; input?: string; env?: NodeJS.ProcessEnv } = {},
  ) {
    return run('git', args, { cwd: this.cwd, ...opts });
  }

  async toplevel(): Promise<string> {
    return (await this.git(['rev-parse', '--show-toplevel'])).stdout.trim();
  }

  async isRepo(): Promise<boolean> {
    const r = await this.git(['rev-parse', '--is-inside-work-tree'], { allowFailure: true });
    return r.code === 0 && r.stdout.trim() === 'true';
  }

  async headSha(): Promise<string> {
    return (await this.git(['rev-parse', 'HEAD'])).stdout.trim();
  }

  async currentBranch(): Promise<string> {
    return (await this.git(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  }

  async commitExists(sha: string): Promise<boolean> {
    const r = await this.git(['cat-file', '-e', `${sha}^{commit}`], { allowFailure: true });
    return r.code === 0;
  }

  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    const r = await this.git(['merge-base', '--is-ancestor', ancestor, descendant], {
      allowFailure: true,
    });
    return r.code === 0;
  }

  async isShallow(): Promise<boolean> {
    const r = await this.git(['rev-parse', '--is-shallow-repository'], { allowFailure: true });
    return r.stdout.trim() === 'true';
  }

  /** `git diff --name-status -M base..head`, rename-aware. */
  async changedFiles(base: string, head = 'HEAD'): Promise<ChangedFile[]> {
    const r = await this.git(['diff', '--name-status', '-M', '-z', `${base}..${head}`]);
    return parseNameStatusZ(r.stdout);
  }

  /** Uncommitted changes (staged + unstaged) relative to HEAD. */
  async workingTreeChanges(): Promise<ChangedFile[]> {
    const r = await this.git(['diff', '--name-status', '-M', '-z', 'HEAD']);
    return parseNameStatusZ(r.stdout);
  }

  async hasUncommittedChanges(paths?: string[]): Promise<boolean> {
    const args = ['status', '--porcelain', '--untracked-files=no'];
    if (paths?.length) args.push('--', ...paths);
    const r = await this.git(args);
    return r.stdout.trim().length > 0;
  }

  /** Files present at a given revision (top-level names only when `depth` = 1). */
  async lsTree(rev: string, opts: { topLevelOnly?: boolean } = {}): Promise<string[]> {
    const args = ['ls-tree', '--name-only', '-z'];
    if (!opts.topLevelOnly) args.push('-r');
    args.push(rev);
    const r = await this.git(args, { allowFailure: true });
    if (r.code !== 0) return [];
    return r.stdout.split('\0').filter(Boolean);
  }

  async commitsBetween(base: string | undefined, head = 'HEAD', limit = 500): Promise<Commit[]> {
    const range = base ? `${base}..${head}` : head;
    const fmt = ['%H', '%s', '%b', '%an', '%ae'].join('%x1f') + '%x1e';
    const r = await this.git(
      ['log', `--max-count=${limit}`, '--no-merges', `--format=${fmt}`, range],
      {
        allowFailure: true,
      },
    );
    if (r.code !== 0) return [];
    return r.stdout
      .split('\x1e')
      .map((s) => s.replace(/^\n/, ''))
      .filter((s) => s.trim())
      .map((rec) => {
        const [sha = '', subject = '', body = '', authorName = '', authorEmail = ''] =
          rec.split('\x1f');
        return {
          sha: sha.trim(),
          subject: subject.trim(),
          body: body.trim(),
          authorName,
          authorEmail,
        };
      });
  }

  async commitMessage(rev = 'HEAD'): Promise<string> {
    return (await this.git(['log', '-1', '--format=%B', rev])).stdout;
  }

  async commitAuthor(rev = 'HEAD'): Promise<{ name: string; email: string }> {
    const r = await this.git(['log', '-1', '--format=%an%x1f%ae', rev]);
    const [name = '', email = ''] = r.stdout.trim().split('\x1f');
    return { name, email };
  }

  async filesInCommit(rev = 'HEAD'): Promise<string[]> {
    const r = await this.git(['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', rev]);
    return r.stdout.split('\0').filter(Boolean);
  }

  async add(paths: string[]): Promise<void> {
    if (!paths.length) return;
    await this.git(['add', '--', ...paths]);
  }

  async commit(
    message: string,
    opts: { authorName?: string; authorEmail?: string } = {},
  ): Promise<string> {
    const env: NodeJS.ProcessEnv = {};
    if (opts.authorName) {
      env.GIT_AUTHOR_NAME = opts.authorName;
      env.GIT_COMMITTER_NAME = opts.authorName;
    }
    if (opts.authorEmail) {
      env.GIT_AUTHOR_EMAIL = opts.authorEmail;
      env.GIT_COMMITTER_EMAIL = opts.authorEmail;
    }
    await this.git(['commit', '-q', '-F', '-'], { input: message, env });
    return this.headSha();
  }

  async fetch(remote = 'origin', ref?: string): Promise<void> {
    const args = ['fetch', '-q', remote];
    if (ref) args.push(ref);
    await this.git(args);
  }

  async pullRebase(remote = 'origin', branch?: string): Promise<{ ok: boolean; message: string }> {
    const args = ['pull', '--rebase', '-q', remote];
    if (branch) args.push(branch);
    const r = await this.git(args, { allowFailure: true });
    if (r.code !== 0) {
      await this.git(['rebase', '--abort'], { allowFailure: true });
      return { ok: false, message: r.stderr.trim() || r.stdout.trim() };
    }
    return { ok: true, message: '' };
  }

  async resetHard(ref: string): Promise<void> {
    await this.git(['reset', '-q', '--hard', ref]);
  }

  async push(
    remote = 'origin',
    branch?: string,
    opts: { setUpstream?: boolean } = {},
  ): Promise<{ ok: boolean; message: string }> {
    const args = ['push', '-q'];
    if (opts.setUpstream) args.push('-u');
    args.push(remote);
    if (branch) args.push(`HEAD:${branch}`);
    const r = await this.git(args, { allowFailure: true });
    return { ok: r.code === 0, message: r.stderr.trim() || r.stdout.trim() };
  }

  async remoteUrl(remote = 'origin'): Promise<string | undefined> {
    const r = await this.git(['remote', 'get-url', remote], { allowFailure: true });
    return r.code === 0 ? r.stdout.trim() : undefined;
  }

  async setUser(name: string, email: string): Promise<void> {
    await this.git(['config', 'user.name', name]);
    await this.git(['config', 'user.email', email]);
  }
}

export function parseNameStatusZ(out: string): ChangedFile[] {
  const parts = out.split('\0');
  const files: ChangedFile[] = [];
  let i = 0;
  while (i < parts.length) {
    const status = parts[i];
    if (!status) {
      i++;
      continue;
    }
    const code = status[0] as ChangeStatus;
    if (code === 'R' || code === 'C') {
      const from = parts[i + 1];
      const to = parts[i + 2];
      if (from !== undefined && to !== undefined) files.push({ status: code, path: to, from });
      i += 3;
    } else {
      const p = parts[i + 1];
      if (p !== undefined) files.push({ status: code, path: p });
      i += 2;
    }
  }
  return files;
}
