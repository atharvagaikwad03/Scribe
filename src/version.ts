import { createRequire } from 'node:module';

function readVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    // Works from src/ (tests) and dist/ (build) alike.
    for (const rel of ['../package.json', '../../package.json']) {
      try {
        const pkg = require(rel) as { name?: string; version?: string };
        if (pkg.name === 'readme-sync' && pkg.version) return pkg.version;
      } catch {
        /* try next */
      }
    }
  } catch {
    /* ignore */
  }
  return '0.0.0';
}

export const TOOL_VERSION = readVersion();
