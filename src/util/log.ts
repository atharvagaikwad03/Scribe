export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

let verbose = false;
let quiet = false;

export function setVerbose(v: boolean): void {
  verbose = v;
}
export function setQuiet(q: boolean): void {
  quiet = q;
}

export const log = {
  debug(msg: string): void {
    if (verbose && !quiet) console.error(`[readme-sync] ${msg}`);
  },
  info(msg: string): void {
    if (!quiet) console.error(`[readme-sync] ${msg}`);
  },
  warn(msg: string): void {
    if (!quiet) console.error(`[readme-sync] warning: ${msg}`);
  },
  error(msg: string): void {
    console.error(`[readme-sync] error: ${msg}`);
  },
  /** Plain stdout output (used for user-facing results, `--json`, diffs). */
  out(msg: string): void {
    console.log(msg);
  },
};
