import { describe, expect, test } from 'bun:test';
import { allTicked, cutTitle, type PlanDoc, parsePlanDoc } from './plan-doc';

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
  const p = parsePlanDoc('docs/plan/image-cache.md', doc) as PlanDoc;

  test('reads title and first goal paragraph', () => {
    expect(p.title).toBe('image-cache');
    expect(p.goal).toBe('Serve images from a cache: resize each one once, at upload.');
  });

  test('takes top-level checklist items of the workstreams section only', () => {
    expect(p.workstreams.map((w) => w.key)).toEqual(['W1', 'W2', 'W3', 'W4~migrate-the-readers', 'WP', 'unlabelled-item', 'W4~duplicate-label']);
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


  test('a workstream whose text starts with its pull request keeps its text in the title', () => {
    const items = [
      '**W2:** #3. Description of the workstream as before. More details.',
      '**W2:** #12. Description of the workstream as before. More details.',
      '**W2:** #128 — Description of the workstream as before. More details.',
      '**W2:** PR #12: Description of the workstream as before. More details.',
      '**W2:** (#12) Description of the workstream as before. More details.',
      '**W2:** [#12](https://example.com/pull/12). Description of the workstream as before. More details.',
      '**W2: #12.** Description of the workstream as before. More details.',
    ];
    const titles = items.map((i) => (parsePlanDoc('a.md', `# A\n\n## Workstreams\n\n- [x] ${i}\n`) as PlanDoc).workstreams[0]!);
    expect(titles.map((w) => [w.title, w.body])).toEqual([
      ['#3. Description of the workstream as before', 'More details.'],
      ['#12. Description of the workstream as before', 'More details.'],
      ['#128 — Description of the workstream as before', 'More details.'],
      ['PR #12: Description of the workstream as before', 'More details.'],
      ['(#12) Description of the workstream as before', 'More details.'],
      ['[#12](https://example.com/pull/12). Description of the workstream as before', 'More details.'],
      ['#12. Description of the workstream as before', 'More details.'],
    ]);
  });

  test('short codes before the title are labels too, and key their workstream', () => {
    const items = ['**S1: Foundation.** Blocked by nothing.', '**A1 — Login.** Rest', '**1G.** Testlücken schließen. Rest', '**2FA einführen.** Rest', '**3D-Ansicht.** Rest', '**K8s Cluster aufsetzen.** Rest'];
    const ws = items.map((i) => (parsePlanDoc('a.md', `# A\n\n## Workstreams\n\n- [ ] ${i}\n`) as PlanDoc).workstreams[0]!);
    expect(ws.map((w) => [w.key, w.label, w.title])).toEqual([
      ['S1', 'S1', 'Foundation'],
      ['A1', 'A1', 'Login'],
      ['1G', '1G', 'Testlücken schließen'],
      ['2fa-einfuhren', undefined, '2FA einführen'],
      ['3d-ansicht', undefined, '3D-Ansicht'],
      ['k8s-cluster-aufsetzen', undefined, 'K8s Cluster aufsetzen'],
    ]);
  });

  test('a code before a space is a label where the doc’s items use codes', () => {
    const doc = (items: string[]) => (parsePlanDoc('a.md', `# A\n\n## Workstreams\n\n${items.map((i) => `- [ ] ${i}`).join('\n')}\n`) as PlanDoc).workstreams;
    expect(doc(['**4A Sitzungen und Mandantensperre.** Mittel 157.', '**3B Auth zusammenführen.** Rest']).map((w) => [w.key, w.title])).toEqual([
      ['4A', 'Sitzungen und Mandantensperre'],
      ['3B', 'Auth zusammenführen'],
    ]);
    // the same code twice: told apart by title, so a reorder keeps each card with its own
    expect(doc(['**S3 Upload.** Rest', '**S3 Download.** Rest']).map((w) => w.key)).toEqual(['S3~upload', 'S3~download']);
    expect(doc(['**S3 Download.** Rest', '**S3 Upload.** Rest']).map((w) => w.key)).toEqual(['S3~download', 'S3~upload']);
  });

  test('an unlabelled workstream is keyed by its title, wherever it stands and whatever pull request a worker puts before it', () => {
    const keys = (items: string[]) => (parsePlanDoc('a.md', `# A\n\n## Workstreams\n\n${items.map((i) => `- [ ] ${i}`).join('\n')}\n`) as PlanDoc).workstreams.map((w) => w.key);
    expect(keys(['Ship the thing. Details', 'Größe prüfen'])).toEqual(['ship-the-thing', 'grosse-prufen']);
    expect(keys(['New one', '#12. Ship the thing. Details', 'Ship the thing'])).toEqual(['new-one', 'ship-the-thing', 'ship-the-thing~2']);
    expect(keys(['…'])).toEqual(['#1']);
    expect(keys(['Вход в систему', '登录', 'Søk'])).toEqual(['вход-в-систему', '登录', 'søk']);
  });

  test('German section names', () => {
    const d = parsePlanDoc('b.md', '# Kadenz\n\n## Ziel\n\nRegeln statt Fallarbeit.\n\n## Workstreams\n\n- [x] **W9:** Prüflauf. Täglich um 05:00.\n') as PlanDoc;
    expect(d.goal).toBe('Regeln statt Fallarbeit.');
    expect(d.workstreams[0]).toMatchObject({ title: 'Prüflauf', body: 'Täglich um 05:00.', done: true });
  });
});

describe('a doc that is not a project', () => {
  test('says why a doc without a workstream checklist is not a project', () => {
    expect(parsePlanDoc('a.md', '# Design\n\n## Goal\n\nText.\n')).toEqual({ file: 'a.md', reason: 'noWorkstreams' });
    expect(parsePlanDoc('a.md', '# Rollout\n\n## Tasks\n\n- [ ] Ship it\n')).toEqual({ file: 'a.md', reason: 'noWorkstreams' });
    expect(parsePlanDoc('a.md', '# Design\n\n## Workstreams\n\nNone yet.\n')).toEqual({ file: 'a.md', reason: 'noChecklist' });
    expect(parsePlanDoc('a.md', '# Auth\n\n## Workstreams\n\n1. Tokens\n2. Sessions\n')).toEqual({ file: 'a.md', reason: 'noChecklist' });
  });

  test('a doc whose every workstream is ticked is done', () => {
    expect(allTicked(parsePlanDoc('a.md', doc) as PlanDoc)).toBe(false);
    expect(allTicked(parsePlanDoc('a.md', '# A\n\n## Workstreams\n\n- [x] **W1:** One.\n- [X] **W2:** Two.\n') as PlanDoc)).toBe(true);
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
