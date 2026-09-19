import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  parseReadme,
  spliceMany,
  spliceRegion,
  renderRegion,
  regionIsPristine,
  bodyHash,
  findHeading,
} from '../../src/markdown/markers.js';
import { MarkerError } from '../../src/util/errors.js';

const doc = `# Title

Some intro prose.

## API

<!-- autogen:start:api hash=abc -->
- old()
<!-- autogen:end:api -->

## Why

Human prose here.

\`\`\`md
<!-- autogen:start:fake -->
not a real marker, inside a code fence
<!-- autogen:end:fake -->
\`\`\`

<!-- autogen:start:deps -->
<!-- autogen:end:deps -->
`;

describe('parseReadme', () => {
  it('finds regions and ignores markers inside code fences', () => {
    const parsed = parseReadme(doc);
    expect(parsed.regions.map((r) => r.id)).toEqual(['api', 'deps']);
    const api = parsed.regions[0]!;
    expect(api.hash).toBe('abc');
    expect(api.body).toBe('- old()');
    expect(parsed.regions[1]!.body).toBe('');
    expect(parsed.headings.map((h) => h.text)).toEqual(['Title', 'API', 'Why']);
  });

  it('rejects unbalanced markers', () => {
    expect(() => parseReadme('<!-- autogen:start:a -->\nx\n')).toThrow(MarkerError);
    expect(() => parseReadme('x\n<!-- autogen:end:a -->\n')).toThrow(MarkerError);
  });

  it('rejects nested and duplicate markers', () => {
    expect(() =>
      parseReadme(
        '<!-- autogen:start:a -->\n<!-- autogen:start:b -->\n<!-- autogen:end:b -->\n<!-- autogen:end:a -->\n',
      ),
    ).toThrow(/Nested/);
    expect(() =>
      parseReadme(
        '<!-- autogen:start:a -->\n<!-- autogen:end:a -->\n<!-- autogen:start:a -->\n<!-- autogen:end:a -->\n',
      ),
    ).toThrow(/Duplicate/);
    expect(() => parseReadme('<!-- autogen:start:a -->\n<!-- autogen:end:b -->\n')).toThrow(
      /Mismatched/,
    );
  });

  it('finds headings by anchor text', () => {
    const parsed = parseReadme(doc);
    expect(findHeading(parsed, '## API')?.text).toBe('API');
    expect(findHeading(parsed, 'why')?.depth).toBe(2);
    expect(findHeading(parsed, '## Missing')).toBeUndefined();
  });
});

describe('splice', () => {
  it('replaces only the region and records the body hash', () => {
    const parsed = parseReadme(doc);
    const out = spliceRegion(doc, parsed.regions[0]!, '- new()\n- other()');
    const reparsed = parseReadme(out);
    const api = reparsed.regions[0]!;
    expect(api.body).toBe('- new()\n- other()');
    expect(api.hash).toBe(bodyHash('- new()\n- other()'));
    expect(regionIsPristine(api)).toBe(true);
    // Everything outside is untouched.
    expect(out.slice(0, parsed.regions[0]!.start)).toBe(doc.slice(0, parsed.regions[0]!.start));
    expect(out.slice(out.length - (doc.length - parsed.regions[0]!.end))).toBe(
      doc.slice(parsed.regions[0]!.end),
    );
  });

  it('detects a manual edit inside a generated region', () => {
    const parsed = parseReadme(doc);
    const written = spliceRegion(doc, parsed.regions[0]!, '- new()');
    const tampered = written.replace('- new()', '- new() // I edited this');
    const region = parseReadme(tampered).regions[0]!;
    expect(regionIsPristine(region)).toBe(false);
  });

  it('refuses a body that breaks marker structure (unclosed fence)', () => {
    const parsed = parseReadme(doc);
    expect(() => spliceMany(doc, [{ region: parsed.regions[0]!, body: '```' }])).toThrow(
      MarkerError,
    );
  });

  it('is idempotent: splicing the same body twice yields identical bytes', () => {
    const parsed = parseReadme(doc);
    const once = spliceRegion(doc, parsed.regions[0]!, 'body');
    const twice = spliceRegion(once, parseReadme(once).regions[0]!, 'body');
    expect(twice).toBe(once);
  });
});

/**
 * Human-bytes invariant, property based: whatever prose, badges, tables, code
 * fences and stray HTML surround the markers, after splicing new bodies into
 * every region, every byte outside the regions is identical.
 */
describe('human bytes invariant (property)', () => {
  const proseLine = fc.oneof(
    fc.stringMatching(/^[A-Za-z0-9 ,.!?'"()\-:;]{0,60}$/),
    fc.constant('![badge](https://img.shields.io/badge/x-y-green)'),
    fc.constant('| a | b |\n|---|---|\n| 1 | 2 |'),
    fc.constant('```js\nconsole.log("<!-- autogen:start:api -->");\n```'),
    fc.constant('<!-- a plain html comment -->'),
    fc.constant('<details><summary>More</summary>\n\nhidden\n\n</details>'),
    fc.constant('- list item\n- another'),
    fc.constant('> quote'),
    fc.constant(''),
  );
  const heading = fc
    .tuple(fc.integer({ min: 1, max: 4 }), fc.stringMatching(/^[A-Za-z][A-Za-z0-9 ]{0,20}$/))
    .map(([d, t]) => `${'#'.repeat(d)} ${t}`);
  const chunk = fc
    .array(fc.oneof(proseLine, heading), { minLength: 0, maxLength: 6 })
    .map((ls) => ls.join('\n\n'));
  // Bodies may contain inline backticks or balanced fences but never an
  // unbalanced fence; the splicer rejects those (see 'refuses a body that breaks structure').
  const body = fc.oneof(
    fc.constant(''),
    fc.stringMatching(/^[A-Za-z0-9 \-*().,\n]{0,80}$/),
    fc.constant('use `inline code` here'),
    fc.constant('```ts\nexport const x = 1;\n```'),
    fc.constant('| col | val |\n|---|---|\n| x | 1 |'),
  );

  const ids = ['api', 'commands', 'dependencies', 'structure', 'changelog'];

  it('never changes bytes outside marker regions', () => {
    fc.assert(
      fc.property(
        fc.array(chunk, { minLength: ids.length + 1, maxLength: ids.length + 1 }),
        fc.array(body, { minLength: ids.length, maxLength: ids.length }),
        fc.array(body, { minLength: ids.length, maxLength: ids.length }),
        (chunks, initialBodies, newBodies) => {
          // Build: chunk0 REGION0 chunk1 REGION1 ... chunkN
          let source = chunks[0]!;
          for (let i = 0; i < ids.length; i++) {
            source += '\n\n' + renderRegion(ids[i]!, initialBodies[i]!) + '\n\n' + chunks[i + 1]!;
          }
          const parsed = parseReadme(source);
          expect(parsed.regions.map((r) => r.id)).toEqual(ids);

          const out = spliceMany(
            source,
            parsed.regions.map((region, i) => ({ region, body: newBodies[i]! })),
          );

          // Collect the "outside" text from both documents and compare.
          const outside = (src: string, regions: { start: number; end: number }[]) => {
            let s = '';
            let cursor = 0;
            for (const r of regions) {
              s += src.slice(cursor, r.start) + '\u0000';
              cursor = r.end;
            }
            return s + src.slice(cursor);
          };
          const reparsed = parseReadme(out);
          expect(reparsed.regions.length).toBe(ids.length);
          expect(outside(out, reparsed.regions)).toBe(outside(source, parsed.regions));
          for (let i = 0; i < ids.length; i++) {
            expect(reparsed.regions[i]!.body).toBe(newBodies[i]!.replace(/\s+$/, ''));
            expect(regionIsPristine(reparsed.regions[i]!)).toBe(true);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
