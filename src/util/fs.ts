import { promises as fs } from 'node:fs';
import path from 'node:path';

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function readText(p: string): Promise<string> {
  return fs.readFile(p, 'utf8');
}

export async function readTextIfExists(p: string): Promise<string | undefined> {
  try {
    return await fs.readFile(p, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

export async function readJsonIfExists<T = unknown>(p: string): Promise<T | undefined> {
  const text = await readTextIfExists(p);
  if (text === undefined) return undefined;
  return JSON.parse(text) as T;
}

export async function writeText(p: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content, 'utf8');
}

export async function writeJson(p: string, value: unknown): Promise<void> {
  await writeText(p, JSON.stringify(value, null, 2) + '\n');
}

/** Always use forward slashes for repo-relative paths, regardless of platform. */
export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

export function relPosix(from: string, to: string): string {
  return toPosix(path.relative(from, to));
}

/**
 * Recursively list files under `dir`, returning repo-relative POSIX paths.
 * Directories in `skipDirs` are never entered.
 */
export async function listFiles(
  root: string,
  dir: string,
  skipDirs: Set<string>,
  out: string[] = [],
): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name)) continue;
      await listFiles(root, abs, skipDirs, out);
    } else if (entry.isFile()) {
      out.push(relPosix(root, abs));
    }
  }
  return out;
}
