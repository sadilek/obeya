import { describe, expect, test } from 'bun:test';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pagePolicy } from '../core/frame';
import { serveCardFile } from './serve-files';
import { artifact, commit } from './testing';
import { board, eachTest, main, manual, runtime, spaces, workers } from './workers-fixture';

eachTest();

/** A card at work whose branch adds a report beside an image the main branch has, and changes the README. */
async function reportCard() {
  mkdirSync(join(main, 'docs'), { recursive: true });
  writeFileSync(join(main, 'docs', 'chart.png'), 'png');
  commit(main, 'notes.md', 'private\n', 'chart');
  const c = manual();
  await workers.start(c.id);
  const ws = board.row(c.id).workspace!;
  writeFileSync(join(ws, 'docs', 'report.md'), '# Report\n\n![Chart](chart.png)\n');
  commit(ws, 'README.md', 'hello again\n', 'report');
  return { c, ws };
}

describe('the files a card names as its result', () => {
  test('the worker names them at its handover, paths of its change only; they stand until a later handover names others', async () => {
    const { c, ws } = await reportCard();
    // a file outside the change does not hold the handover back: the card leaves it out, and the worker hears so
    const without = await runtime.last.call('ready_for_review', { summary: 'Fertig.', demo: artifact(), files: [{ path: 'notes.md', caption: 'Notizen' }] });
    expect(without).toContain('Recorded');
    expect(without).toContain('notes.md is not among the files your card made or changed (README.md, docs/report.md), so the card does not show it.');
    expect(board.item(c.id)!.state).toBe('waiting');
    expect(board.item(c.id)!.files).toBeUndefined();
    workers.message(c.id, 'Und der Bericht?');
    // an absolute path in the workspace counts as the path in the repository
    const done = await runtime.last.call('ready_for_review', { summary: 'Fertig.', demo: artifact(), files: [{ path: join(ws, 'docs', 'report.md'), caption: 'Der  Bericht\n' }, { path: 'notes.md', caption: 'Notizen' }] });
    expect(done).toContain('Recorded');
    expect(board.item(c.id)!.files).toEqual([{ path: 'docs/report.md', caption: 'Der Bericht' }]);
    workers.message(c.id, 'Noch die Einleitung kürzen.');
    expect(await runtime.last.call('ready_for_review', { summary: 'Gekürzt.' })).toContain('Recorded');
    expect(board.item(c.id)!.files).toEqual([{ path: 'docs/report.md', caption: 'Der Bericht' }]);
    // an empty list takes them back
    workers.message(c.id, 'Doch kein Bericht.');
    expect(await runtime.last.call('ready_for_review', { summary: 'Gut.', files: [] })).toContain('Recorded');
    expect(board.item(c.id)!.files).toBeUndefined();
  });

  test('the size of the change goes with the card from its handover on, and is kept as the change is read again', async () => {
    const { c, ws } = await reportCard();
    expect(board.item(c.id)!.changeSize).toBeUndefined();
    expect(await runtime.last.call('ready_for_review', { summary: 'Fertig.', demo: artifact() })).toContain('Recorded');
    // read beside the handover, so the page has it from the first time it opens the card
    for (let i = 0; i < 100 && !board.item(c.id)!.changeSize; i++) await Bun.sleep(20);
    expect(board.item(c.id)!.changeSize).toEqual({ files: 2, added: 4, removed: 1 });
    writeFileSync(join(ws, 'docs', 'more.md'), 'more\n');
    await workers.diff(c.id, false);
    expect(board.item(c.id)!.changeSize).toEqual({ files: 3, added: 5, removed: 1 });
  });

  test('Obeya serves a file the card made or changed, and an image a Markdown file of it shows; no other file of the workspace', async () => {
    const { c } = await reportCard();
    const ws = realpathSync(board.row(c.id).workspace!);
    expect(await workers.file(c.id, 'docs/report.md')).toEqual({ path: join(ws, 'docs', 'report.md') });
    expect(await workers.file(c.id, './README.md')).toEqual({ path: join(ws, 'README.md') });
    // unchanged, but the report shows it
    expect(await workers.file(c.id, 'docs/chart.png')).toEqual({ path: join(ws, 'docs', 'chart.png') });
    expect(await workers.file(c.id, 'notes.md')).toBeNull();
    expect(await workers.file(c.id, '.git/config')).toBeNull();
    expect(await workers.file(c.id, '../main/notes.md')).toBeNull();
    // a link the card made stands for no other file of the workspace
    symlinkSync('../notes.md', join(ws, 'docs', 'link.md'));
    expect((await workers.diff(c.id, false))!.files.map((f) => f.file)).toContain('docs/link.md');
    expect(await workers.file(c.id, 'docs/link.md')).toBeNull();
    // a name that reads as another in a diff's header passes for none
    // (`diff --git a/x b/notes.md b/x b/notes.md`, with no `+++` line for a binary file)
    mkdirSync(join(ws, 'x b'));
    writeFileSync(join(ws, 'x b', 'notes.md'), new Uint8Array([0, 1, 2]));
    expect(await workers.file(c.id, 'notes.md')).toBeNull();
    expect(await workers.file(c.id, 'x b/notes.md')).toEqual({ path: join(ws, 'x b', 'notes.md') });
  });

  test('without its workspace, a file comes from a commit in the repository', async () => {
    await reportCard();
    const at = await spaces.fileOf('gone', 'docs/chart.png', 'main');
    expect(at && 'data' in at && new TextDecoder().decode(at.data)).toBe('png');
    expect(await spaces.fileOf('gone', 'docs/none.png', 'main')).toBeNull();
    // to open it, the checkout's copy
    expect(await spaces.fileOf('gone', 'docs/chart.png', 'main', true)).toMatchObject({ path: expect.stringMatching(/docs[\\/]chart\.png$/) });
  });

  test('a PDF comes as it is, for the browser\'s viewer; anything else sandboxed as an HTML artifact\'s files', async () => {
    const { c, ws } = await reportCard();
    writeFileSync(join(ws, 'docs', 'report.pdf'), '%PDF-1.4\n');
    writeFileSync(join(ws, 'docs', 'page.html'), '<p>Hi</p>');
    const files = `http://127.0.0.1:4417/api/c/c/cards/${c.id}/files/`;
    const get = (path: string) => workers.file(c.id, path);
    const sentOn = await serveCardFile('docs/report.pdf', false, new Request(`${files}docs/report.pdf`), get);
    expect(sentOn.status).toBe(302);
    const key = /\/(~[0-9a-f]{32})\//.exec(sentOn.headers.get('location')!)![1];
    const serve = (name: string, download = false) => serveCardFile(`${key}/${name}`, download, new Request(`${files}${key}/${name}`), get);
    const pdf = await serve('docs/report.pdf');
    expect(pdf.headers.get('content-type')).toBe('application/pdf');
    expect(pdf.headers.get('x-content-type-options')).toBe('nosniff');
    expect(pdf.headers.get('content-security-policy')).not.toContain('sandbox');
    expect(pdf.headers.get('connection-allowlist')).toBe('(response-origin)');
    const page = await serve('docs/page.html');
    expect(page.headers.get('content-security-policy')).toBe(`sandbox allow-scripts; ${pagePolicy('http://127.0.0.1:4417')}`);
    expect(await page.text()).toContain('obeyaHeight');
    const md = await serve('docs/report.md', true);
    expect(md.headers.get('content-disposition')).toContain('report.md');
    expect(md.headers.get('content-security-policy')).toContain('sandbox');
    expect((await serve('notes.md')).status).toBe(404);
  });
});
