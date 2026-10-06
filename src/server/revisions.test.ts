import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Item } from '../core/types';
import { CanvasRuntime } from './canvas';
import { Store } from './db';
import { FakeRuntime, type FakeSession, gitRepo, noForge } from './testing';

let dir: string;
let main: string;
let store: Store;
let runtime: FakeRuntime;
let canvas: CanvasRuntime;

const open = () => new CanvasRuntime({ repos: [{ path: main, clones: 1 }] }, { store, home: dir, runtime, forge: noForge, commandDelayMs: 10 });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'obeya-revisions-'));
  main = join(dir, 'main');
  gitRepo(main);
  store = new Store(':memory:');
  runtime = new FakeRuntime();
  canvas = open();
});
afterEach(() => {
  canvas.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

const settle = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const board = () => canvas.board;
const isKoordinator = (s: FakeSession) => s.spec.tools.some((t) => t.name === 'look_up');
const reviser = () => runtime.sessions.filter((s) => s.spec.tools.some((t) => t.name === 'revise_proposal')).at(-1);

/** A proposal from the agent of "Export", with one question. */
function proposal(): Item {
  const from = board().create({ title: 'Export', x: 0, y: 0 });
  return board().propose(from.id, {
    title: 'CSV-Export prüfen',
    task: 'Der CSV-Export schreibt Umlaute falsch.',
    reason: 'Beim Export aufgefallen.',
    questions: [{ text: 'Welche Kodierung?', options: ['UTF-8', 'Latin-1'] }],
  });
}

/** Says `text` with the proposal open; the Koordinator acts with `actions` (its tags looked up by title). */
async function say(text: string, card: Item, actions: (tag: string) => Record<string, unknown>[], typed = false) {
  const heard = canvas.commander.hear(text, { card: card.id }, [], typed ? { typed: true, field: 'revise' } : {});
  await settle();
  const s = runtime.sessions.filter(isKoordinator).at(-1)!;
  const brief = s.inbox.at(-1)!;
  const tag = brief.match(new RegExp(`(K\\d+) \\[proposal\\] "${card.title}"`))![1]!;
  const result = s.call('act', { actions: actions(tag), confirm: 'Ich überarbeite den Vorschlag.' });
  s.emit({ type: 'idle' });
  return { heard: await heard, brief, result };
}

describe('a proposal reworked by what the owner says', () => {
  test('a reviser rewrites text and questions after the undo window; accepting waits for it', async () => {
    const p = proposal();
    const { heard, brief } = await say('Nimm auch Excel mit, und UTF-8 ist gesetzt.', p, (tag) => [{ do: 'revise', card: tag, text: 'Excel auch, UTF-8 gesetzt' }]);
    expect(brief).toContain('[proposal] "CSV-Export prüfen"');
    expect(heard.token).toBeDefined();
    canvas.commander.arm(heard.token!);
    await settle(30);

    const item = board().item(p.id)!;
    // the owner's whole words, as said, with how they came
    expect(item.proposal?.revising).toEqual({ words: 'Nimm auch Excel mit, und UTF-8 ist gesetzt.', spoken: true });
    const r = reviser()!;
    expect(r.spec.readOnly).toBe(true);
    expect(r.inbox[0]).toContain('Der CSV-Export schreibt Umlaute falsch.');
    expect(r.inbox[0]).toContain('Welche Kodierung? (options: UTF-8 / Latin-1)');
    expect(r.inbox[0]).toContain('Beim Export aufgefallen.');
    expect(r.inbox[0]).toContain('It came from the card "Export"');
    expect(r.inbox[0]).toContain('said about it (speech recognition, may contain errors)');
    expect(r.inbox[0]).toContain('Nimm auch Excel mit, und UTF-8 ist gesetzt.');
    expect(() => board().accept(p.id)).toThrow('being reworked');

    r.call('revise_proposal', { title: 'CSV- und Excel-Export prüfen', task: 'CSV und Excel schreiben Umlaute falsch. Kodierung: UTF-8.', reason: 'Beim Export aufgefallen.', questions: [] });
    r.emit({ type: 'idle' });
    await settle();
    const after = board().item(p.id)!;
    expect(after.state).toBe('proposal');
    expect(after.title).toBe('CSV- und Excel-Export prüfen');
    expect(after.body).toBe('CSV und Excel schreiben Umlaute falsch. Kodierung: UTF-8.');
    expect(after.proposal).toEqual({ reason: 'Beim Export aufgefallen.', questions: [] });
    expect(board().events(p.id).map((e) => [e.kind, e.author, e.text])).toEqual([
      ['say', 'owner', 'Nimm auch Excel mit, und UTF-8 ist gesetzt.'],
      ['say', 'koordinator', 'Ich überarbeite den Vorschlag.'],
      ['state', 'koordinator', 'Vorschlag überarbeitet.'],
    ]);
  });

  test('typed into the field, the reviser hears the words as written', async () => {
    const p = proposal();
    const { heard, brief } = await say('Lass die Frage weg', p, (tag) => [{ do: 'revise', card: tag, text: 'Frage weg' }], true);
    expect(brief).toContain('into the field for what should change in the proposal');
    canvas.commander.arm(heard.token!);
    await settle(30);
    expect(board().item(p.id)!.proposal?.revising).toEqual({ words: 'Lass die Frage weg' });
    expect(reviser()!.inbox[0]).toContain('wrote about it');
  });

  test('options picked in the panel go to the reviser at once and stand in the conversation', async () => {
    const p = proposal();
    canvas.press(p.id, { action: 'revise', text: '**Welche Kodierung?** UTF-8' });
    expect(board().item(p.id)!.proposal?.revising).toEqual({ words: '**Welche Kodierung?** UTF-8' });
    expect(reviser()!.inbox[0]).toContain('**Welche Kodierung?** UTF-8');
    expect(board().events(p.id).at(-1)).toMatchObject({ kind: 'say', author: 'owner', text: '**Welche Kodierung?** UTF-8' });
  });

  test('accepting in the same breath, or while it is reworked, is refused', async () => {
    const p = proposal();
    const both = await say('Excel auch, und dann übernehmen', p, (tag) => [
      { do: 'revise', card: tag, text: 'Excel auch' },
      { do: 'accept', card: tag },
    ]);
    expect(both.result).toContain('accepting a proposal waits for its reworked text');

    board().revising(p.id, 'Excel auch', true);
    const later = await say('übernehmen', p, (tag) => [{ do: 'accept', card: tag }]);
    expect(later.result).toContain('the proposal is being reworked');
    const again = await say('und noch Word', p, (tag) => [{ do: 'revise', card: tag, text: 'Word' }]);
    expect(again.result).toContain('still being reworked');
  });

  test('accepted and started while it is reworked, it starts once the new text is there', async () => {
    const p = proposal();
    canvas.press(p.id, { action: 'revise', text: '**Welche Kodierung?** UTF-8' });
    // the second click and the plain "Übernehmen" change nothing
    canvas.act(p.id, { action: 'accept', picks: [['Latin-1']] });
    canvas.act(p.id, { action: 'accept' });
    expect(() => canvas.act(p.id, { action: 'accept', start: false })).toThrow('being reworked');
    expect(board().item(p.id)).toMatchObject({ state: 'proposal', proposal: { revising: { words: '**Welche Kodierung?** UTF-8' }, acceptAfterRevision: true } });
    expect(board().events(p.id).filter((e) => e.text.startsWith('Übernehmen und starten, sobald'))).toHaveLength(1);

    reviser()!.call('revise_proposal', { title: 'CSV-Export prüfen', task: 'Der CSV-Export schreibt Umlaute falsch. Kodierung: UTF-8.', questions: [] });
    reviser()!.emit({ type: 'idle' });
    await settle();
    // the new text is the task, without the picks clicked on the old questions, and its worker starts
    expect(board().item(p.id)).toMatchObject({ state: 'working', body: 'Der CSV-Export schreibt Umlaute falsch. Kodierung: UTF-8.' });
    expect(board().item(p.id)!.proposal).toBeUndefined();
  });

  test('accepted while it is reworked, it stays a proposal when the new text asks questions, when the reviser fails, or when taken back', async () => {
    const p = proposal();
    canvas.revisions.revise(p.id, 'Excel auch', false);
    canvas.act(p.id, { action: 'accept' });
    reviser()!.call('revise_proposal', { title: 'CSV- und Excel-Export', task: 'Auch Excel.', questions: [{ question: 'Welche Kodierung?', options: ['UTF-8'] }] });
    reviser()!.emit({ type: 'idle' });
    await settle();
    expect(board().item(p.id)).toMatchObject({ state: 'proposal', title: 'CSV- und Excel-Export' });
    expect(board().item(p.id)!.proposal?.acceptAfterRevision).toBeUndefined();
    expect(board().events(p.id).at(-1)).toMatchObject({ kind: 'state', text: 'Nicht übernommen: Der Vorschlag hat noch eine Frage.' });

    canvas.revisions.revise(p.id, 'UTF-8', false);
    canvas.act(p.id, { action: 'accept' });
    reviser()!.emit({ type: 'idle' });
    await settle();
    expect(board().item(p.id)!.state).toBe('proposal');
    expect(board().events(p.id).at(-1)).toMatchObject({ kind: 'state', text: 'Nicht übernommen: Die Überarbeitung kam nicht zustande.' });

    canvas.revisions.revise(p.id, 'UTF-8', false);
    canvas.act(p.id, { action: 'accept' });
    canvas.act(p.id, { action: 'unaccept' });
    expect(board().events(p.id).at(-1)).toMatchObject({ kind: 'state', author: 'owner', text: 'Doch nicht übernehmen.' });
    reviser()!.call('revise_proposal', { title: 'CSV-Export', task: 'UTF-8.', questions: [] });
    reviser()!.emit({ type: 'idle' });
    await settle();
    expect(board().item(p.id)).toMatchObject({ state: 'proposal', title: 'CSV-Export', proposal: { questions: [] } });
  });

  test('a proposed idea accepted while it is reworked opens its discussion once the new text is there', async () => {
    const from = board().create({ title: 'Export', x: 0, y: 0 });
    const p = board().propose(from.id, { title: 'Exportformate', task: 'Welche Formate brauchen Vermieter?', idea: true, questions: [] });
    canvas.revisions.revise(p.id, 'Auch an Excel denken', false);
    canvas.act(p.id, { action: 'accept' });
    expect(board().events(p.id).at(-1)!.text).toStartWith('Übernehmen und besprechen, sobald');
    reviser()!.call('revise_proposal', { title: 'Exportformate', task: 'Welche Formate, auch Excel?', idea: true, questions: [] });
    reviser()!.emit({ type: 'idle' });
    await settle();
    expect(board().item(p.id)).toMatchObject({ state: 'idea', body: 'Welche Formate, auch Excel?' });
  });

  test('a reviser that ends without a text leaves the proposal as it was', async () => {
    const p = proposal();
    canvas.revisions.revise(p.id, 'Excel auch', false);
    reviser()!.emit({ type: 'idle' });
    await settle();
    const item = board().item(p.id)!;
    expect(item.title).toBe('CSV-Export prüfen');
    expect(item.proposal?.revising).toBeUndefined();
    expect(item.proposal?.questions).toHaveLength(1);
    expect(board().events(p.id).at(-1)).toMatchObject({ kind: 'error', text: expect.stringContaining('Überarbeiten ging nicht') });
  });

  test('a proposal dismissed meanwhile stays gone', async () => {
    const p = proposal();
    canvas.revisions.revise(p.id, 'Excel auch', false);
    await canvas.act(p.id, { action: 'dismiss' });
    reviser()!.call('revise_proposal', { title: 'X', task: 'Y', questions: [] });
    reviser()!.emit({ type: 'idle' });
    await settle();
    expect(board().item(p.id)).toBeUndefined();
  });

  test('after a restart, a proposal still being reworked is reworked again', async () => {
    const p = proposal();
    canvas.revisions.revise(p.id, 'Excel auch', false);
    const before = runtime.sessions.length;
    canvas.shutdown();
    canvas = open();
    expect(runtime.sessions.length).toBe(before + 1);
    expect(reviser()!.inbox[0]).toContain('Excel auch');
  });
});
