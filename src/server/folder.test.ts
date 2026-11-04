import { beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './db';
import { compare, FolderWorkspaces, merge, type Manifest, type ToolCall, walk } from './folder';

let dir: string;
let folder: string;
let store: Store;
let ws: FolderWorkspaces;

const bytes = (n: number, seed: number) => Uint8Array.from({ length: n }, (_, i) => (i * seed + 7) % 251);

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'obeya-folder-'));
  folder = join(dir, 'Dokumente');
  mkdirSync(join(folder, 'Steuer'), { recursive: true });
  mkdirSync(join(folder, 'Nachlass'), { recursive: true });
  writeFileSync(join(folder, 'Sortierung.md'), 'eins\nzwei\n');
  writeFileSync(join(folder, 'Scan.pdf'), bytes(5000, 3));
  writeFileSync(join(folder, 'Nachlass', 'Liste.txt'), 'Konten\n');
  writeFileSync(join(folder, 'Zähler.png'), bytes(3000, 5));
  store = new Store(':memory:');
  ws = new FolderWorkspaces(store, { path: folder, dir: join(dir, 'undo') });
  await ws.read;
});

let calls = 0;
/** A tool call of the card's agent: the hooks around it, and what it does in between. */
async function call(cardId: string, name: string, input: Record<string, unknown>, act: () => void | Promise<void>) {
  const c: ToolCall = { id: `t${++calls}`, name, input };
  const w = ws.watch(cardId);
  await w.before(c);
  await act();
  await w.after(c);
}

const kinds = async (cardId: string) => (await ws.diff(cardId, false))!.folder!.changes.map((c) => `${c.kind} ${c.from ? `${c.from} → ` : ''}${c.path}`);

describe('the manifest', () => {
  test('a moved directory is one move, a renamed file another', async () => {
    const before = await walk(folder);
    renameSync(join(folder, 'Nachlass'), join(folder, 'Erbe'));
    renameSync(join(folder, 'Scan.pdf'), join(folder, 'Steuer', '2025-Scan.pdf'));
    const after = await walk(folder);
    const changes = compare(before, after).map((c) => `${c.kind} ${c.from} → ${c.path}`);
    expect(changes.sort()).toEqual(['moved Nachlass → Erbe', 'moved Scan.pdf → Steuer/2025-Scan.pdf']);
  });

  test('a file written twice and then deleted by the card is no change of it', () => {
    const e = { size: 1, mtime: 1, ctime: 1, ino: 9 };
    const list: Parameters<typeof merge>[0] = [];
    merge(list, { kind: 'added', path: 'a', after: e, at: 1 });
    merge(list, { kind: 'modified', path: 'a', before: e, after: { ...e, size: 2 }, at: 2 });
    merge(list, { kind: 'deleted', path: 'a', before: e, at: 3 });
    expect(list).toEqual([]);
    const m: Manifest = new Map();
    expect(compare(m, m)).toEqual([]);
  });
});

describe('two cards at once', () => {
  test("each card's list holds its own changes, not the other card's nor the owner's", async () => {
    ws.lease('a');
    ws.lease('b');
    // both run at the same time: a's script while b edits a file
    const ca: ToolCall = { id: 'x1', name: 'Bash', input: { command: 'mv Scan.pdf Steuer/' } };
    const cb: ToolCall = { id: 'x2', name: 'Edit', input: { file_path: join(folder, 'Sortierung.md') } };
    await ws.watch('a').before(ca);
    await ws.watch('b').before(cb);
    renameSync(join(folder, 'Scan.pdf'), join(folder, 'Steuer', 'Scan.pdf'));
    writeFileSync(join(folder, 'Sortierung.md'), 'eins\nzwei\ndrei\n');
    await ws.watch('b').after(cb);
    await ws.watch('a').after(ca);
    // the owner, between the cards' calls
    writeFileSync(join(folder, 'Nachlass', 'Liste.txt'), 'Konten und Depots\n');
    // not within the millisecond the next call starts in, which counts as the call's
    await Bun.sleep(3);
    await call('b', 'Bash', { command: 'touch Nachlass/Brief.docx' }, () => writeFileSync(join(folder, 'Nachlass', 'Brief.docx'), bytes(100, 2)));
    expect(await kinds('a')).toEqual(['moved Scan.pdf → Steuer/Scan.pdf']);
    expect(await kinds('b')).toEqual(['modified Sortierung.md', 'added Nachlass/Brief.docx']);
    const d = (await ws.diff('b', true))!;
    expect(d.files.find((f) => f.file === 'Sortierung.md')).toMatchObject({ added: 1, removed: 0 });
    expect(d.patch).toContain('+drei');
    expect(await ws.changes('a')).toEqual([{ file: 'Steuer/Scan.pdf', regions: ['moved from Scan.pdf'] }]);
  });
});

describe('undo', () => {
  test('puts back an overwritten binary and a deleted file, and leaves what someone changed since', async () => {
    ws.lease('a');
    await call('a', 'Bash', { command: 'convert' }, () => {
      writeFileSync(join(folder, 'Zähler.png'), bytes(4000, 11));
      rmSync(join(folder, 'Scan.pdf'));
      writeFileSync(join(folder, 'Nachlass', 'Liste.txt'), 'neu\n');
      mkdirSync(join(folder, 'Neu'));
      writeFileSync(join(folder, 'Neu', 'Brief.txt'), 'Hallo\n');
    });
    // the owner edits one of them afterwards
    await Bun.sleep(5);
    writeFileSync(join(folder, 'Nachlass', 'Liste.txt'), 'vom Owner\n');
    const view = (await ws.diff('a', false))!.folder!;
    const undo = Object.fromEntries(view.changes.map((c) => [c.path, c.undo]));
    expect(view.undo).toMatch(/full|partial/);
    expect(undo['Nachlass/Liste.txt']).toBe('changedSince');
    expect(undo['Neu/Brief.txt']).toBe('yes');
    const report = await ws.undo('a');
    expect(readFileSync(join(folder, 'Nachlass', 'Liste.txt'), 'utf8')).toBe('vom Owner\n');
    expect(report.changedSince).toEqual(['Nachlass/Liste.txt']);
    expect(existsSync(join(folder, 'Neu'))).toBe(false);
    if (view.undo === 'full') {
      // a clone of the folder has the binaries
      expect(new Uint8Array(readFileSync(join(folder, 'Zähler.png')))).toEqual(bytes(3000, 5));
      expect(existsSync(join(folder, 'Scan.pdf'))).toBe(true);
    } else expect(report.lost.sort()).toEqual(['Scan.pdf', 'Zähler.png']);
    // what was left stays the card's
    expect(await kinds('a')).toEqual([...(view.undo === 'full' ? [] : ['modified Zähler.png', 'deleted Scan.pdf']), 'modified Nachlass/Liste.txt']);
  });

  test('without a clone, moves, what the editing tools overwrite and the text files come back; a script\'s binary does not', async () => {
    ws = new FolderWorkspaces(store, { path: folder, dir: join(dir, 'undo'), clone: false });
    await ws.read;
    ws.lease('a');
    writeFileSync(join(folder, 'Brief.docx'), bytes(800, 13));
    await Bun.sleep(3);
    await call('a', 'Write', { file_path: 'Brief.docx' }, () => writeFileSync(join(folder, 'Brief.docx'), bytes(900, 17)));
    await call('a', 'Bash', { command: 'mv Nachlass Erbe' }, () => {
      renameSync(join(folder, 'Nachlass'), join(folder, 'Erbe'));
      writeFileSync(join(folder, 'Sortierung.md'), 'neu\n');
      writeFileSync(join(folder, 'Zähler.png'), bytes(10, 1));
    });
    expect((await ws.diff('a', false))!.folder!.undo).toBe('partial');
    expect(await kinds('a')).toEqual(['modified Brief.docx', 'moved Nachlass → Erbe', 'modified Sortierung.md', 'modified Zähler.png']);
    const report = await ws.undo('a');
    expect(new Uint8Array(readFileSync(join(folder, 'Brief.docx')))).toEqual(bytes(800, 13));
    expect(readFileSync(join(folder, 'Sortierung.md'), 'utf8')).toBe('eins\nzwei\n');
    expect(existsSync(join(folder, 'Nachlass', 'Liste.txt'))).toBe(true);
    expect(report.lost).toEqual(['Zähler.png']);
    expect(await kinds('a')).toEqual(['modified Zähler.png']);
  });

  test('a directory the card moved goes back with what the card changed in it', async () => {
    ws.lease('a');
    await call('a', 'Bash', { command: 'mv Nachlass Erbe && echo neu > Erbe/Liste.txt' }, () => {
      renameSync(join(folder, 'Nachlass'), join(folder, 'Erbe'));
      writeFileSync(join(folder, 'Erbe', 'Liste.txt'), 'neu\n');
    });
    expect(await kinds('a')).toEqual(['moved Nachlass → Erbe', 'modified Erbe/Liste.txt']);
    const report = await ws.undo('a');
    expect(report).toMatchObject({ changedSince: [], lost: [] });
    expect(readFileSync(join(folder, 'Nachlass', 'Liste.txt'), 'utf8')).toBe('Konten\n');
    expect(existsSync(join(folder, 'Erbe'))).toBe(false);
  });

  test('what changed while two cards ran scripts at once is left alone by either undo', async () => {
    ws.lease('a');
    ws.lease('b');
    const ca: ToolCall = { id: 's1', name: 'Bash', input: {} };
    const cb: ToolCall = { id: 's2', name: 'Bash', input: {} };
    await ws.watch('a').before(ca);
    await ws.watch('b').before(cb);
    writeFileSync(join(folder, 'a.txt'), 'a\n');
    writeFileSync(join(folder, 'b.txt'), 'b\n');
    await ws.watch('a').after(ca);
    await ws.watch('b').after(cb);
    const view = (await ws.diff('a', false))!.folder!.changes;
    expect(view.map((c) => [c.path, c.undo])).toEqual([
      ['a.txt', 'shared'],
      ['b.txt', 'shared'],
    ]);
    const report = await ws.undo('a');
    expect(report.shared).toEqual(['a.txt', 'b.txt']);
    expect(existsSync(join(folder, 'b.txt'))).toBe(true);
  });

  test("the owner's change just before a script's call is not the card's, nor put back over", async () => {
    ws.lease('a');
    await call('a', 'Bash', { command: 'true' }, () => {});
    // the owner edits the list, then the card's script appends to it
    writeFileSync(join(folder, 'Nachlass', 'Liste.txt'), 'vom Owner\n');
    await Bun.sleep(3);
    await call('a', 'Bash', { command: 'echo mehr >> Nachlass/Liste.txt' }, () => writeFileSync(join(folder, 'Nachlass', 'Liste.txt'), 'vom Owner\nmehr\n'));
    const report = await ws.undo('a');
    // its copy from the start is older than what the card changed: nothing to put back from
    expect(report.lost).toEqual(['Nachlass/Liste.txt']);
    expect(readFileSync(join(folder, 'Nachlass', 'Liste.txt'), 'utf8')).toBe('vom Owner\nmehr\n');
  });

  test('a file replaced since with other bytes of the same size and time is left alone', async () => {
    ws.lease('a');
    await call('a', 'Bash', { command: 'edit' }, () => writeFileSync(join(folder, 'Sortierung.md'), 'AAAA\n'));
    const { mtime } = statSync(join(folder, 'Sortierung.md'));
    await Bun.sleep(3);
    writeFileSync(join(folder, 'Sortierung.md'), 'BBBB\n');
    utimesSync(join(folder, 'Sortierung.md'), mtime, mtime);
    const report = await ws.undo('a');
    expect(report.changedSince).toEqual(['Sortierung.md']);
    expect(readFileSync(join(folder, 'Sortierung.md'), 'utf8')).toBe('BBBB\n');
  });

  test('an edit through a link is a change of the file it points to', async () => {
    symlinkSync('Sortierung.md', join(folder, 'Link.md'));
    await call('x', 'Bash', { command: 'true' }, () => {});
    ws.lease('a');
    await call('a', 'Edit', { file_path: 'Link.md' }, () => writeFileSync(join(folder, 'Link.md'), 'drei\n'));
    expect(await kinds('a')).toEqual(['modified Sortierung.md']);
  });
});

describe('another program writing during a call that writes nothing', () => {
  const uncertain = async (cardId: string) => ((await ws.diff(cardId, false))!.folder!.uncertain ?? []).map((c) => `${c.kind} ${c.path}`);

  test("is kept apart as uncertain: neither the card's change, nor its result, nor undone", async () => {
    ws.lease('a');
    await call('a', 'Edit', { file_path: 'Sortierung.md' }, () => writeFileSync(join(folder, 'Sortierung.md'), 'eins\nzwei\ndrei\n'));
    // the nightly export lands while the agent waits and counts its rows
    await call('a', 'Bash', { command: 'sleep 90; wc -l out/export.csv' }, () => {
      mkdirSync(join(folder, 'out'));
      writeFileSync(join(folder, 'out', 'export.csv'), 'row,1\nrow,2\n');
    });
    expect(await kinds('a')).toEqual(['modified Sortierung.md']);
    expect(await uncertain('a')).toEqual(['added out', 'added out/export.csv']);
    expect(await ws.changedFiles('a')).toEqual(['Sortierung.md']);
    expect(ws.changed('a')).toEqual([{ file: 'Sortierung.md', regions: [] }]);
    const d = (await ws.diff('a', true))!;
    expect(d.files.map((f) => f.file)).toEqual(['Sortierung.md']);
    const report = await ws.undo('a');
    expect(report.undone).toEqual(['Sortierung.md']);
    expect(readFileSync(join(folder, 'out', 'export.csv'), 'utf8')).toBe('row,1\nrow,2\n');
    expect(await uncertain('a')).toEqual(['added out', 'added out/export.csv']);
  });

  test('a card with nothing but uncertain changes has no work of its own', async () => {
    ws.lease('a');
    await call('a', 'Bash', { command: 'ls out 2>/dev/null || echo none' }, () => writeFileSync(join(folder, 'export.csv'), 'row,1\n'));
    expect(await ws.hasWork('a')).toBe(false);
    expect(await uncertain('a')).toEqual(['added export.csv']);
  });

  test('what a command that may write changes stays the card’s', async () => {
    ws.lease('a');
    await call('a', 'Bash', { command: 'python3 count.py > counts.txt' }, () => writeFileSync(join(folder, 'counts.txt'), '2\n'));
    expect(await kinds('a')).toEqual(['added counts.txt']);
    expect(await uncertain('a')).toEqual([]);
  });

  test('a file the card then writes itself becomes its change, from as the other program left it', async () => {
    ws.lease('a');
    await call('a', 'Bash', { command: 'sleep 30' }, () => writeFileSync(join(folder, 'export.csv'), 'row,1\n'));
    await Bun.sleep(3);
    await call('a', 'Bash', { command: "sed -i '' s/row/line/ export.csv" }, () => writeFileSync(join(folder, 'export.csv'), 'line,1\n'));
    expect(await kinds('a')).toEqual(['modified export.csv']);
    expect(await uncertain('a')).toEqual([]);
    // undo has no copy from before the card's change: it leaves the file
    const report = await ws.undo('a');
    expect(report.lost).toEqual(['export.csv']);
    expect(readFileSync(join(folder, 'export.csv'), 'utf8')).toBe('line,1\n');
  });

  test('another program changing what the card wrote leaves the card’s change as it was: undo finds it changed since', async () => {
    ws.lease('a');
    await call('a', 'Bash', { command: 'echo eins > notes.txt' }, () => writeFileSync(join(folder, 'notes.txt'), 'eins\n'));
    await Bun.sleep(3);
    await call('a', 'Bash', { command: 'sleep 30' }, () => writeFileSync(join(folder, 'notes.txt'), 'eins\nzwei\n'));
    expect(await kinds('a')).toEqual(['added notes.txt']);
    expect(await uncertain('a')).toEqual([]);
    expect((await ws.undo('a')).changedSince).toEqual(['notes.txt']);
  });

  test('what the card recreates leaves the rest of what another program deleted listed apart', async () => {
    ws.lease('a');
    writeFileSync(join(folder, 'Nachlass', 'Konto.txt'), 'Bank\n');
    await call('x', 'Bash', { command: 'true' }, () => {});
    await call('a', 'Bash', { command: 'sleep 30' }, () => rmSync(join(folder, 'Nachlass'), { recursive: true }));
    await Bun.sleep(3);
    await call('a', 'Bash', { command: 'mkdir Nachlass && echo neu > Nachlass/Liste.txt' }, () => {
      mkdirSync(join(folder, 'Nachlass'));
      writeFileSync(join(folder, 'Nachlass', 'Liste.txt'), 'neu\n');
    });
    expect(await kinds('a')).toEqual(['added Nachlass', 'added Nachlass/Liste.txt']);
    expect(await uncertain('a')).toEqual(['deleted Nachlass/Konto.txt']);
  });

  test("another program moving a directory the card changed something in is listed apart, the card's change kept", async () => {
    ws.lease('a');
    await call('a', 'Edit', { file_path: 'Nachlass/Liste.txt' }, () => writeFileSync(join(folder, 'Nachlass', 'Liste.txt'), 'Konten und Depots\n'));
    await Bun.sleep(3);
    await call('a', 'Bash', { command: 'sleep 30' }, () => renameSync(join(folder, 'Nachlass'), join(folder, 'Erbe')));
    expect(await kinds('a')).toEqual(['modified Nachlass/Liste.txt']);
    expect((await ws.diff('a', false))!.folder!.uncertain!.map((c) => `${c.kind} ${c.from} → ${c.path}`)).toEqual(['moved Nachlass → Erbe']);
  });

  test("while another card's command may write, the change is that card's alone", async () => {
    ws.lease('a');
    ws.lease('b');
    const ca: ToolCall = { id: 'r1', name: 'Bash', input: { command: 'sleep 30' } };
    const cb: ToolCall = { id: 'r2', name: 'Bash', input: { command: 'make report' } };
    await ws.watch('a').before(ca);
    await ws.watch('b').before(cb);
    writeFileSync(join(folder, 'report.pdf'), bytes(200, 7));
    await ws.watch('b').after(cb);
    await ws.watch('a').after(ca);
    expect(await kinds('b')).toEqual(['added report.pdf']);
    expect((await ws.diff('b', false))!.folder!.changes[0]!.undo).toBe('yes');
    expect(await kinds('a')).toEqual([]);
    expect(await uncertain('a')).toEqual([]);
  });
});
