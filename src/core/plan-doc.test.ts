import { describe, expect, test } from 'bun:test';
import { cutTitle, parsePlanDoc } from './plan-doc';

const doc = `# \`image-cache\`

> Living plan doc.

## Goal

Serve images from a cache:
resize each one once, at upload.

Second paragraph is not part of the goal.

## Workstreams

Intro text.

- [x] **W1:** \`image_cache\` table — [#12](https://example.com/12)
- [ ] **W2 (in review):** Eviction. Oldest first, with a
  wrapped continuation line.
- [ ] **W3 — Security hardening (no schema change).** Close the leaks.
- [ ] **W4:** migrate the readers.
  - [x] Thumbnails — done,
    wrapped.
  - [ ] Forecasting.
- [ ] **WP — Portal MVP.** Ships early.
- [ ] Unlabelled item: with details
- [ ] **W4:** duplicate label

> Workstream labels are anchors for this doc only.

## Open questions

- [ ] **W9:** not a workstream, wrong section
`;

describe('parsePlanDoc', () => {
  const p = parsePlanDoc('docs/plan/image-cache.md', doc)!;

  test('reads title and first goal paragraph', () => {
    expect(p.title).toBe('image-cache');
    expect(p.goal).toBe('Serve images from a cache: resize each one once, at upload.');
  });

  test('takes top-level checklist items of the workstreams section only', () => {
    expect(p.workstreams.map((w) => w.key)).toEqual(['W1', 'W2', 'W3', 'W4', 'WP', '#6', 'W4~2']);
  });

  test('splits label, title and body', () => {
    const [w1, w2, w3, w4, wp, un] = p.workstreams;
    expect(w1).toMatchObject({ label: 'W1', title: '`image_cache` table', body: '[#12](https://example.com/12)', done: true });
    expect(w2).toMatchObject({ title: 'Eviction', body: 'Oldest first, with a wrapped continuation line.', done: false, inReview: true });
    expect(w3).toMatchObject({ title: 'Security hardening (no schema change)', body: 'Close the leaks.' });
    expect(w4!.title).toBe('Migrate the readers');
    expect(w4!.body).toBe('- [x] Thumbnails — done, wrapped.\n- [ ] Forecasting.');
    expect(wp).toMatchObject({ label: 'WP', title: 'Portal MVP' });
    expect(un).toMatchObject({ title: 'Unlabelled item', body: 'with details' });
    expect(un!.label).toBeUndefined();
  });

  test('a doc without a workstream checklist is not a project', () => {
    expect(parsePlanDoc('a.md', '# Design\n\n## Goal\n\nText.\n')).toBeNull();
    expect(parsePlanDoc('a.md', '# Design\n\n## Workstreams\n\nNone yet.\n')).toBeNull();
  });

  test('German section names', () => {
    const d = parsePlanDoc('b.md', '# Kadenz\n\n## Ziel\n\nRegeln statt Fallarbeit.\n\n## Workstreams\n\n- [x] **W9:** Prüflauf. Täglich um 05:00.\n')!;
    expect(d.goal).toBe('Regeln statt Fallarbeit.');
    expect(d.workstreams[0]).toMatchObject({ title: 'Prüflauf', body: 'Täglich um 05:00.', done: true });
  });
});

describe('cutTitle', () => {
  test('does not cut at abbreviations or inside code', () => {
    expect(cutTitle('Preise z. B. aus ENTSO-E. Rest')).toEqual({ title: 'Preise z. B. aus ENTSO-E', rest: 'Rest' });
    expect(cutTitle('`a: b` mapping; then more')).toEqual({ title: '`a: b` mapping', rest: 'then more' });
  });

  test('shortens text without an early separator', () => {
    const long = 'word '.repeat(40).trim();
    const { title, rest } = cutTitle(long);
    expect(title.endsWith(' …')).toBe(true);
    expect(title.length).toBeLessThanOrEqual(84);
    expect(rest.startsWith('… ')).toBe(true);
  });
});
