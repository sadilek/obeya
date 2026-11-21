import { describe, expect, test } from 'bun:test';
import { cardDiff, diffFiles, diffSize, foldUnchanged, lineDiff, PATCH_LIMIT, splitDiff, textDiff, wordDiff } from './diff';

const patch = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,4 @@ export function a',
  ' const x = 1;',
  '-const y = 2;',
  '+const y = 3;',
  '+const z = 4;',
  ' // --- not a header',
  'diff --git a/old name.md b/new name.md',
  'similarity index 90%',
  'rename from old name.md',
  'rename to new name.md',
  '--- a/old name.md',
  '+++ b/new name.md\t',
  '@@ -1 +1 @@',
  '-Hallo',
  '+Hallo Welt',
  'diff --git a/gone.txt b/gone.txt',
  'deleted file mode 100644',
  'index 3333333..0000000',
  '--- a/gone.txt',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-eins',
  '-zwei',
  'diff --git a/logo.png b/logo.png',
  'new file mode 100644',
  'index 0000000..4444444',
  'Binary files /dev/null and b/logo.png differ',
].join('\n');

describe('a card’s diff', () => {
  test('splits into files with what each adds and removes, new, deleted, renamed and binary ones told apart', () => {
    expect(diffFiles(patch)).toEqual([
      { file: 'src/a.ts', status: 'modified', added: 2, removed: 1 },
      { file: 'new name.md', from: 'old name.md', status: 'renamed', added: 1, removed: 1 },
      { file: 'gone.txt', status: 'deleted', added: 0, removed: 2 },
      { file: 'logo.png', status: 'added', added: 0, removed: 0, binary: true },
    ]);
    expect(diffSize(diffFiles(patch))).toEqual({ added: 3, removed: 4 });
    // each file keeps its lines, from its `diff --git` line on
    expect(splitDiff(patch)[0]!.lines).toHaveLength(10);
  });

  test('an empty diff has no files', () => {
    expect(diffFiles('')).toEqual([]);
  });

  test('the whole diff only when asked for, cut off at a file’s end past the limit', () => {
    expect(cardDiff('branch', patch, false)).toEqual({ source: 'branch', files: diffFiles(patch) });
    expect(cardDiff('landed', patch, true).patch).toBe(patch);
    const big = `${patch}\n${`diff --git a/big.txt b/big.txt\n@@ -0,0 +1 @@\n+${'x'.repeat(PATCH_LIMIT)}`}`;
    const cut = cardDiff('branch', big, true);
    expect(cut.truncated).toBe(true);
    expect(cut.patch).toBe(patch);
    // the list still names every file
    expect(cut.files.map((f) => f.file)).toContain('big.txt');
  });
});

test('two lists of lines as a diff: kept, gone and new in their order', () => {
  expect(lineDiff(['a', 'b', 'c'], ['a', 'x', 'c', 'd'])).toEqual([
    { kind: ' ', line: 'a' },
    { kind: '-', line: 'b' },
    { kind: '+', line: 'x' },
    { kind: ' ', line: 'c' },
    { kind: '+', line: 'd' },
  ]);
  expect(lineDiff([], ['a'])).toEqual([{ kind: '+', line: 'a' }]);
  expect(lineDiff(['a'], [])).toEqual([{ kind: '-', line: 'a' }]);
});

test('two similar lines compared word by word mark only what differs, a changed phrase as one piece', () => {
  expect(wordDiff('start it on a free port, then wait', 'start it on a fixed free port, then wait 20 s')).toEqual([
    [{ text: 'start it on a free port, then wait', changed: false }],
    [
      { text: 'start it on a ', changed: false },
      { text: 'fixed ', changed: true },
      { text: 'free port, then wait', changed: false },
      { text: ' 20 s', changed: true },
    ],
  ]);
  const [was, now] = wordDiff('kill the old server first', 'stop the old server first')!;
  expect(was.filter((p) => p.changed).map((p) => p.text)).toEqual(['kill']);
  expect(now.filter((p) => p.changed).map((p) => p.text)).toEqual(['stop']);
  // too little in common: one line gone, another new
  expect(wordDiff('bun run dev', 'python -m http.server 8000')).toBeNull();
});

test('a text diff puts gone lines before new ones and pairs the similar ones', () => {
  const d = textDiff(['intro', 'run it on port 3000', 'old note', 'end'], ['intro', 'a new first line', 'run it on port 4000', 'end']);
  expect(d.map((l) => `${l.kind}${l.line}`)).toEqual([' intro', '-run it on port 3000', '-old note', '+a new first line', '+run it on port 4000', ' end']);
  expect(d[1]!.parts?.find((p) => p.changed)?.text).toBe('3000');
  expect(d[4]!.parts?.find((p) => p.changed)?.text).toBe('4000');
  // unpaired lines stay whole
  expect(d[2]!.parts).toBeUndefined();
  expect(d[3]!.parts).toBeUndefined();
});

test('unchanged lines far from a change fold, those near it stay', () => {
  const before = Array.from({ length: 20 }, (_, i) => `line ${i}`);
  const after = before.map((l, i) => (i === 10 ? 'changed' : l));
  const rows = foldUnchanged(textDiff(before, after), 2);
  expect(rows.map((r) => ('folded' in r ? `…${r.folded.length}` : r.line.line))).toEqual([
    '…8',
    'line 8',
    'line 9',
    'line 10',
    'changed',
    'line 11',
    'line 12',
    '…7',
  ]);
  // folding a single line would hide nothing worth it
  expect(foldUnchanged(textDiff(['a', 'b', 'c', 'x', 'd', 'e', 'f'], ['a', 'b', 'c', 'y', 'd', 'e', 'f']), 2).every((r) => 'line' in r)).toBe(true);
  expect(foldUnchanged(textDiff(['a', 'b', 'x', 'c', 'd'], ['a', 'b', 'y', 'c', 'd']), 2).every((r) => 'line' in r)).toBe(true);
});
