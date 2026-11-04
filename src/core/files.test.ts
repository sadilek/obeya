import { describe, expect, test } from 'bun:test';
import type { CardDiff } from './diff';
import { changeRows, changeSize, docImages, fileKind, imageAt, normalPath, shownFiles } from './files';

const folder: CardDiff = {
  source: 'folder',
  files: [],
  folder: {
    undo: 'full',
    changes: [
      { kind: 'added', path: 'Finanzen/Modell.py', added: 69, removed: 0 },
      { kind: 'added', path: 'Finanzen/Regelungen.md', added: 121, removed: 0 },
      { kind: 'added', path: 'Finanzen/__pycache__/Modell.cpython-314.pyc' },
      { kind: 'modified', path: 'CLAUDE.md', added: 1, removed: 1 },
      { kind: 'modified', path: 'Steuer.xlsx' },
      { kind: 'deleted', path: 'Alt.md' },
      { kind: 'added', path: 'Scans', dir: true },
      { kind: 'moved', from: 'a.pdf', path: 'Scans/a.pdf' },
    ],
  },
};

const branch: CardDiff = {
  source: 'branch',
  files: [
    { file: 'src/app.ts', status: 'modified', added: 4, removed: 2 },
    { file: 'docs/report.pdf', status: 'added', added: 0, removed: 0, binary: true },
    { file: 'docs/old.md', status: 'deleted', added: 0, removed: 5 },
    { file: 'docs/new-name.md', from: 'docs/name.md', status: 'renamed', added: 0, removed: 0 },
    { file: 'bin/tool.o', status: 'added', added: 0, removed: 0, binary: true },
  ],
};

describe('the files a card shows as its result', () => {
  test('in a folder: documents first, then text and code; nothing deleted, no directory, nothing that is neither document nor text', () => {
    expect(shownFiles(folder).map((f) => `${f.path} ${f.kind}${f.added ? ' new' : ''}${f.diff ? ' diff' : ''}`)).toEqual([
      'Finanzen/Regelungen.md markdown new',
      'CLAUDE.md markdown diff',
      'Steuer.xlsx other',
      'Scans/a.pdf pdf new',
      'Finanzen/Modell.py text new',
    ]);
  });

  test('the files its worker named come first, with their captions, in its order', () => {
    const named = [
      { path: 'Steuer.xlsx', caption: 'Die Tabelle' },
      { path: 'Finanzen/Modell.py', caption: 'Das Modell' },
    ];
    expect(shownFiles(folder, named).map((f) => [f.path, f.caption])).toEqual([
      ['Steuer.xlsx', 'Die Tabelle'],
      ['Finanzen/Modell.py', 'Das Modell'],
      ['Finanzen/Regelungen.md', undefined],
      ['CLAUDE.md', undefined],
      ['Scans/a.pdf', undefined],
    ]);
  });

  test('a file gone from the folder since gets no tab, named or not', () => {
    const changes = folder.folder!.changes.map((c) => (c.path === 'Steuer.xlsx' || c.path === 'CLAUDE.md' ? { ...c, gone: true as const } : c));
    const named = [{ path: 'Steuer.xlsx', caption: 'Die Tabelle' }];
    expect(shownFiles({ ...folder, folder: { undo: 'full', changes } }, named).map((f) => f.path)).toEqual(['Finanzen/Regelungen.md', 'Scans/a.pdf', 'Finanzen/Modell.py']);
  });

  test('on a branch: a renamed file without changes is shown as it is, a changed one with its changes', () => {
    expect(shownFiles(branch).map((f) => `${f.path} ${f.kind}${f.added ? ' new' : ''}${f.diff ? ' diff' : ''}`)).toEqual([
      'docs/report.pdf pdf new',
      'docs/new-name.md markdown new',
      'src/app.ts text diff',
    ]);
    expect(shownFiles(null)).toEqual([]);
  });

  test('the change list: the files to show first, in their order and with their captions, then the rest without a view', () => {
    const rows = changeRows(folder, [{ path: 'Finanzen/Modell.py', caption: 'Das Modell' }]);
    expect(rows.map((r) => `${r.kind} ${r.path}${r.file ? '' : ' -'}${r.caption ? ` (${r.caption})` : ''}`)).toEqual([
      'added Finanzen/Modell.py (Das Modell)',
      'added Finanzen/Regelungen.md',
      'modified CLAUDE.md',
      'modified Steuer.xlsx',
      'moved Scans/a.pdf',
      'added Finanzen/__pycache__/Modell.cpython-314.pyc -',
      'deleted Alt.md -',
    ]);
    // the lines stay with the file, and a moved one says where it was
    expect(rows[0]).toMatchObject({ added: 69, removed: 0 });
    expect(rows[4]).toMatchObject({ from: 'a.pdf' });
  });

  test('what may not be the card\'s comes last in the change list, apart, never as the result nor in its size', () => {
    const uncertain = [
      { kind: 'added' as const, path: 'out', dir: true as const },
      { kind: 'added' as const, path: 'out/export.csv' },
    ];
    const d = { ...folder, folder: { ...folder.folder!, uncertain } };
    const named = [{ path: 'out/export.csv', caption: 'Der Export' }];
    const rows = changeRows(d, named);
    expect(rows.at(-1)).toEqual({ kind: 'added', path: 'out/export.csv', uncertain: true });
    expect(rows.filter((r) => r.path === 'out/export.csv')).toHaveLength(1);
    expect(shownFiles(d).map((f) => f.path)).not.toContain('out/export.csv');
    expect(changeSize(d).files).toBe(changeRows(folder).length);
  });

  test('on a branch, the change list is the list git gives, a named file it does not hold with no sign', () => {
    const rows = changeRows(branch, [{ path: 'README.md', caption: '' }]);
    expect(rows.map((r) => `${r.kind ?? '·'} ${r.path}${r.file ? '' : ' -'}${r.added !== undefined ? ` +${r.added} −${r.removed}` : ''}`)).toEqual([
      '· README.md',
      'added docs/report.pdf',
      'moved docs/new-name.md +0 −0',
      'modified src/app.ts +4 −2',
      'deleted docs/old.md - +0 −5',
      'added bin/tool.o -',
    ]);
    expect(changeRows(null)).toEqual([]);
  });

  test('how a file is shown, by its name', () => {
    expect(['a.md', 'a.PDF', 'a.svg', 'a.html', 'a.py', 'a.docx', 'a.bin'].map((f) => fileKind(f))).toEqual(['markdown', 'pdf', 'image', 'page', 'text', 'other', 'other']);
    // read as text or not, a spreadsheet is no text to show
    expect(fileKind('a.xlsx', true)).toBe('other');
    expect(fileKind('Makefile', true)).toBe('text');
  });
});

describe('paths and the images of a Markdown file', () => {
  test('a path keeps inside its root', () => {
    expect(normalPath('./a/b/../c.md')).toBe('a/c.md');
    expect(normalPath('a\\b.md')).toBe('a/b.md');
    expect(normalPath('../x')).toBeNull();
    expect(normalPath('a/../../x')).toBeNull();
    expect(normalPath('')).toBeNull();
  });

  test('an image beside the document, relative to it; none from the web, an absolute path or outside', () => {
    expect(imageAt('docs/report.md', 'chart.png')).toBe('docs/chart.png');
    expect(imageAt('docs/report.md', '../img/My%20chart.png?raw=1')).toBe('img/My chart.png');
    expect(imageAt('report.md', 'https://example.com/a.png')).toBeNull();
    expect(imageAt('report.md', 'data:image/png;base64,AAA')).toBeNull();
    expect(imageAt('report.md', '/etc/a.png')).toBeNull();
    expect(imageAt('docs/report.md', '../../a.png')).toBeNull();
  });

  test('the images a document shows', () => {
    const md = '# R\n\n![Chart](chart.png) and ![](<sub/two.jpg> "Title")\n\n[a link](other.md) ![web](https://x.org/a.png) ![x](notes.txt)';
    expect(docImages('docs/r.md', md)).toEqual(['docs/chart.png', 'docs/sub/two.jpg']);
  });
});
