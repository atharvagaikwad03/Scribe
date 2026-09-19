/** Small deterministic markdown helpers shared by renderers. */

export function table(headers: string[], rows: string[][]): string {
  const esc = (s: string) => s.replace(/\r?\n/g, ' ');
  const lines = [
    `| ${headers.map(esc).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.map((c) => esc(c)).join(' | ')} |`),
  ];
  return lines.join('\n') + '\n';
}

export function code(body: string, lang = ''): string {
  // Choose a fence longer than any backtick run inside the body so it always closes.
  const longest = Math.max(2, ...[...body.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}${lang}\n${body}\n${fence}\n`;
}

export function bullet(items: string[]): string {
  return items.map((i) => `- ${i}`).join('\n') + (items.length ? '\n' : '');
}

export function inlineCode(s: string): string {
  return s.includes('`') ? `\`\` ${s} \`\`` : `\`${s}\``;
}
