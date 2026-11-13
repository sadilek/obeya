import { describe, expect, test } from 'bun:test';
import type { Item } from '../core/types';
import { agentListens } from '../core/card';
import { board, canvas, eachTest, restart, runtime, say as tell, settle } from './canvas-fixture';
import { until } from './testing';

eachTest({ deps: () => ({ limitMargin: 10 }) });

const reviser = () => runtime.withTool('revise_proposal').at(-1);

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

/** Says `text` with the proposal open; the Coordinator acts with `actions` (its tags looked up by title). */
function say(text: string, card: Item, actions: (tag: string) => Record<string, unknown>[], typed = false, images: string[] = []) {
  return tell(
    text,
    { card: card.id },
    'act',
    (brief) => ({ actions: actions(brief.match(new RegExp(`(K\\d+) \\[proposal\\] "${card.title}"`))![1]!), confirm: 'Ich überarbeite den Vorschlag.' }),
    { images, input: typed ? { typed: true, field: 'revise' } : {} },
  );
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

    r.call('revise_proposal', { title: 'CSV- und Excel-Export prüfen', task: 'CSV und Excel schreiben Umlaute falsch. Kodierung: UTF-8.', reason: 'Beim Export aufgefallen.', questions: [], reply: 'Excel ist dabei, UTF-8 steht im Text.' });
    r.emit({ type: 'idle' });
    await settle();
    const after = board().item(p.id)!;
    expect(after.state).toBe('proposal');
    expect(after.title).toBe('CSV- und Excel-Export prüfen');
    expect(after.body).toBe('CSV und Excel schreiben Umlaute falsch. Kodierung: UTF-8.');
    expect(after.proposal).toEqual({ reason: 'Beim Export aufgefallen.', questions: [] });
    // the question it settled stays in the conversation where it was asked, the reviser's answer after the owner's words
    expect(board().events(p.id).map((e) => [e.kind, e.author, e.text])).toEqual([
      ['question', 'worker', 'Welche Kodierung?\n– UTF-8\n– Latin-1'],
      ['say', 'owner', 'Nimm auch Excel mit, und UTF-8 ist gesetzt.'],
      ['say', 'coordinator', 'Ich überarbeite den Vorschlag.'],
      ['talk', 'worker', 'Excel ist dabei, UTF-8 steht im Text.'],
      ['state', 'coordinator', 'Vorschlag überarbeitet.'],
    ]);
  });

  test('words on the open proposal go straight to its reviser, without the Coordinator or an undo window', () => {
    const p = proposal();
    expect(agentListens(board().item(p.id)!)).toBe(true);
    canvas.tell(p.id, 'Was würdest du nehmen?', [], false);
    expect(board().item(p.id)!.proposal?.revising).toMatchObject({ words: 'Was würdest du nehmen?' });
    expect(reviser()!.inbox[0]).toContain('Was würdest du nehmen?');
    expect(reviser()!.spec.tools.map((t) => t.name)).toContain('to_obeya');
    expect(runtime.withTool('look_up')).toEqual([]);
    // the question stays above the owner's words
    expect(board().events(p.id).map((e) => [e.kind, e.author])).toEqual([
      ['question', 'worker'],
      ['say', 'owner'],
    ]);
  });

  test('words said while it is reworked wait, unread, for the rework after it, and can be taken back until then', async () => {
    const p = proposal();
    canvas.tell(p.id, 'Nimm UTF-8.', [], false);
    const first = reviser()!;
    // the reviser still listens: the words wait for it
    expect(agentListens(board().item(p.id)!)).toBe(true);
    canvas.tell(p.id, 'Und Excel auch.', [], false);
    canvas.tell(p.id, 'Doch nicht.', [], false);
    const [excel, not] = board().events(p.id).slice(-2);
    expect([excel!.unread, not!.unread]).toEqual([true, true]);
    expect(reviser()).toBe(first);
    canvas.press(p.id, { action: 'unsay', id: not!.id });
    expect(board().events(p.id).map((e) => e.text)).not.toContain('Doch nicht.');
    // the first rework is done: the next takes in what waited
    first.call('revise_proposal', { title: p.title, task: `${p.body} Kodierung: UTF-8.`, questions: [], reply: 'UTF-8 steht im Text.' });
    first.emit({ type: 'idle' });
    await settle();
    const next = reviser()!;
    expect(next).not.toBe(first);
    expect(next.inbox[0]).toContain('Und Excel auch.');
    expect(next.inbox[0]).not.toContain('Nimm UTF-8.');
    const read = board().events(p.id).find((e) => e.id === excel!.id)!;
    expect(read.unread).toBeUndefined();
    // it stands after the reply it waited for
    expect(read.readAfter).toBeGreaterThan(excel!.id);
    expect(() => canvas.press(p.id, { action: 'unsay', id: excel!.id })).toThrow();
  });

  test('accepting, passed on by the reviser, waits for the rework and then starts the proposal', async () => {
    const from = board().create({ title: 'Export', x: 0, y: 0 });
    const p = board().propose(from.id, { title: 'CSV-Export prüfen', task: 'Der CSV-Export schreibt Umlaute falsch.', reason: 'Beim Export aufgefallen.' });
    canvas.tell(p.id, 'Übernimm ihn und leg los', [], true);
    const r = reviser()!;
    const result = r.call('to_obeya', { request: 'Accept the proposal and start it' }) as Promise<string>;
    await settle();
    const k = runtime.withTool('look_up').at(-1)!;
    const tag = k.inbox.at(-1)!.match(/(K\d+) \[proposal\] "CSV-Export prüfen"/)![1]!;
    expect(k.call('act', { actions: [{ do: 'accept', card: tag }], confirm: 'Ich übernehme den Vorschlag und starte ihn.' })).not.toContain('goes by a click');
    k.emit({ type: 'idle' });
    expect(await result).toBe('Obeya: Ich übernehme den Vorschlag und starte ihn.');
    await settle(30);
    expect(board().item(p.id)!.proposal?.acceptAfterRevision).toBe(true);
    // nothing to rework: the reviser ends without a new text, and the proposal goes as it is
    r.emit({ type: 'idle' });
    await settle();
    expect(board().item(p.id)!.state).not.toBe('proposal');
    expect(board().events(p.id).some((e) => e.kind === 'error')).toBe(false);
  });

  test('words that only ask are answered, and the proposal stays as it was', async () => {
    const p = proposal();
    canvas.press(p.id, { action: 'revise', text: 'Was würdest du nehmen?' });
    const r = reviser()!;
    r.call('revise_proposal', { title: p.title, task: p.body, reason: 'Beim Export aufgefallen.', questions: [{ question: 'Welche Kodierung?', options: ['UTF-8', 'Latin-1'] }], reply: 'UTF-8: das lesen alle heutigen Programme.' });
    r.emit({ type: 'idle' });
    await settle();
    expect(board().item(p.id)!.proposal).toEqual({ reason: 'Beim Export aufgefallen.', questions: [{ text: 'Welche Kodierung?', options: ['UTF-8', 'Latin-1'] }] });
    // the kept question is not asked a second time, and nothing reads as revised
    expect(board().events(p.id).map((e) => [e.kind, e.author, e.text])).toEqual([
      ['question', 'worker', 'Welche Kodierung?\n– UTF-8\n– Latin-1'],
      ['say', 'owner', 'Was würdest du nehmen?'],
      ['talk', 'worker', 'UTF-8: das lesen alle heutigen Programme.'],
    ]);
  });

  test('a question the reviser asks anew stands in the conversation after its reply', async () => {
    const p = proposal();
    canvas.press(p.id, { action: 'revise', text: '**Welche Kodierung?** UTF-8. Und Excel?' });
    const r = reviser()!;
    r.call('revise_proposal', { title: p.title, task: `${p.body} Kodierung: UTF-8.`, questions: [{ question: 'Excel auch?', options: ['Ja', 'Nein'] }], reply: 'UTF-8 steht im Text; ob Excel dazukommt, entscheidest du.' });
    r.emit({ type: 'idle' });
    await settle();
    expect(board().events(p.id).map((e) => [e.kind, e.author, e.text]).slice(1)).toEqual([
      ['say', 'owner', '**Welche Kodierung?** UTF-8. Und Excel?'],
      ['talk', 'worker', 'UTF-8 steht im Text; ob Excel dazukommt, entscheidest du.'],
      ['state', 'coordinator', 'Vorschlag überarbeitet.'],
      ['question', 'worker', 'Excel auch?\n– Ja\n– Nein'],
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
    expect(board().item(p.id)!.proposal?.revising).toMatchObject({ words: '**Welche Kodierung?** UTF-8' });
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
    // the second click and the plain "Accept" change nothing
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

  test('a proposed task taken as an idea while it is reworked opens its discussion once the new text is there', async () => {
    const from = board().create({ title: 'Export', x: 0, y: 0 });
    const p = board().propose(from.id, { title: 'Exportformate', task: 'PDF-Export bauen.', questions: [] });
    canvas.revisions.revise(p.id, 'Auch an Excel denken', false);
    canvas.act(p.id, { action: 'accept', start: false, idea: true });
    expect(board().item(p.id)!.proposal?.acceptAfterRevision).toBe('idea');
    expect(board().events(p.id).at(-1)!.text).toStartWith('Als Idee besprechen, sobald');
    reviser()!.call('revise_proposal', { title: 'Exportformate', task: 'PDF- und Excel-Export bauen.', questions: [] });
    reviser()!.emit({ type: 'idle' });
    await settle();
    expect(board().item(p.id)).toMatchObject({ state: 'idea', body: 'PDF- und Excel-Export bauen.' });
  });

  test('said to the Coordinator, a proposed task is taken as an idea', async () => {
    const from = board().create({ title: 'Export', x: 0, y: 0 });
    const p = board().propose(from.id, { title: 'Exportformate', task: 'PDF-Export bauen.' });
    const heard = canvas.commander.hear('Das will ich erst als Idee besprechen', {});
    await settle();
    const k = runtime.withTool('look_up').at(-1)!;
    const tag = k.inbox.at(-1)!.match(/(K\d+) \[proposal\] "Exportformate"/)![1]!;
    k.call('act', { actions: [{ do: 'accept', card: tag, idea: true }], confirm: 'Ich übernehme ihn als Idee.' });
    k.emit({ type: 'idle' });
    canvas.commander.arm((await heard).token!);
    await settle(30);
    expect(board().item(p.id)!.state).toBe('idea');
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

  test('with an English interface, why it ended without a text is said in English too', async () => {
    await restart({ deps: { language: () => 'en' } });
    const p = proposal();
    canvas.revisions.revise(p.id, 'Excel too', false);
    reviser()!.emit({ type: 'idle' });
    await settle();
    expect(board().events(p.id).at(-1)).toMatchObject({ kind: 'error', text: 'Revising did not work: the agent gave no new text' });
  });

  test('a reviser the usage limit stops waits on the proposal and reworks it once the limit lifts', async () => {
    const p = proposal();
    canvas.revisions.revise(p.id, 'Excel auch', false);
    const r = reviser()!;
    r.emit({ type: 'error', message: "You've hit your session limit · resets 2:40pm (Europe/Berlin)", limit: { resetsAt: Date.now() + 20 } });
    r.emit({ type: 'idle' });
    await settle();
    // no error: the proposal waits for its rework, and says until when
    expect(board().item(p.id)!.proposal?.revising).toMatchObject({ words: 'Excel auch' });
    expect(board().item(p.id)!.limitedUntil).toBeDefined();
    expect(board().events(p.id).some((e) => e.kind === 'error')).toBe(false);
    await until(() => board().item(p.id)!.limitedUntil === undefined);
    expect(r.inbox.at(-1)).toContain('usage limit');
    r.call('revise_proposal', { title: 'CSV- und Excel-Export prüfen', task: 'Beide schreiben Umlaute falsch.', questions: [], reply: 'Excel ist drin.' });
    r.emit({ type: 'idle' });
    await settle();
    expect(board().item(p.id)).toMatchObject({ title: 'CSV- und Excel-Export prüfen' });
    expect(board().item(p.id)!.proposal?.revising).toBeUndefined();
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
    await restart();
    expect(runtime.sessions.length).toBe(before + 1);
    expect(reviser()!.inbox[0]).toContain('Excel auch');
  });
});

describe("screenshots in a proposal's conversation", () => {
  const shot = (n: number) => canvas.images.save(new Uint8Array([n]), 'image/png');

  test('they stand with the words, reach the reviser, and those it keeps go with the accepted task', async () => {
    const p = proposal();
    const a = shot(1);
    canvas.tell(p.id, 'So sieht der Export in Excel aus', [a], false);
    expect(board().events(p.id).at(-1)).toMatchObject({ kind: 'say', author: 'owner', images: [a] });
    const r = reviser()!;
    expect(r.images[0]).toEqual([canvas.images.path(a)!]);
    expect(r.inbox[0]).toContain(`The owner attached a screenshot (shown below; files: ${a})`);
    expect(r.inbox[0]).toContain("No screenshot goes with the card's task now.");
    expect(r.spec.tools.find((t) => t.name === 'revise_proposal')!.description).toContain('images:');
    r.call('revise_proposal', { title: p.title, task: p.body, reason: 'Beim Export aufgefallen.', questions: p.proposal!.questions.map((q) => ({ question: q.text, options: q.options })), reply: 'Der Screenshot geht mit.', images: [a, 'unknown.png'] });
    r.emit({ type: 'idle' });
    await settle();
    expect(board().item(p.id)!.images).toEqual([a]);
    // what goes with it changed, so the proposal reads otherwise
    expect(board().events(p.id).at(-1)).toMatchObject({ kind: 'state', text: 'Vorschlag überarbeitet.' });
    canvas.act(p.id, { action: 'accept', start: false });
    expect(board().item(p.id)).toMatchObject({ state: 'planned', images: [a] });
  });

  test('one the reviser leaves out stays only in the conversation; one it kept before it may drop', async () => {
    const p = proposal();
    const [a, b] = [shot(1), shot(2)];
    canvas.tell(p.id, 'So ist es heute', [a], false);
    reviser()!.call('revise_proposal', { title: p.title, task: p.body, questions: [], reply: 'Das Bild geht mit.', images: [a] });
    reviser()!.emit({ type: 'idle' });
    await settle();
    canvas.tell(p.id, 'Das alte Bild stimmt nicht mehr, so ist es jetzt', [b], false);
    const r = reviser()!;
    // the words' screenshot first, then the task's
    expect(r.images[0]).toEqual([canvas.images.path(b)!, canvas.images.path(a)!]);
    expect(r.inbox[0]).toContain(`Screenshots that go with the card's task now: ${a}.`);
    r.call('revise_proposal', { title: p.title, task: p.body, questions: [], reply: 'Nur noch das neue.', images: [b] });
    r.emit({ type: 'idle' });
    await settle();
    expect(board().item(p.id)!.images).toEqual([b]);

    // the next rework sees the one it dropped as shown earlier; leaving the list out keeps what goes with the task
    canvas.tell(p.id, 'Und der Titel kürzer', [], false);
    const next = reviser()!;
    expect(next.inbox[0]).toContain(`Screenshots that go with the card's task now: ${b}.`);
    expect(next.inbox[0]).toContain(`which do not go with it: ${a}.`);
    next.call('revise_proposal', { title: 'CSV-Export', task: p.body, questions: [], reply: 'Kürzer.' });
    next.emit({ type: 'idle' });
    await settle();
    expect(board().item(p.id)!.images).toEqual([b]);
  });

  test('words that wait for the next rework bring their screenshots to it', async () => {
    const p = proposal();
    canvas.tell(p.id, 'Nimm UTF-8.', [], false);
    const first = reviser()!;
    const a = shot(1);
    canvas.tell(p.id, 'Und so soll es aussehen', [a], false);
    expect(board().item(p.id)!.proposal?.revising?.next).toEqual([{ words: 'Und so soll es aussehen', said: [board().events(p.id).at(-1)!.id], images: [a] }]);
    first.call('revise_proposal', { title: p.title, task: p.body, questions: [], reply: 'UTF-8.' });
    first.emit({ type: 'idle' });
    await settle();
    const next = reviser()!;
    expect(next).not.toBe(first);
    expect(next.images[0]).toEqual([canvas.images.path(a)!]);
    expect(next.inbox[0]).toContain(`files: ${a}`);
  });

  test('said to the Coordinator, they go with the revise action to the reviser', async () => {
    const p = proposal();
    const a = shot(1);
    const { heard } = await say('Schau, so sieht es aus', p, (tag) => [{ do: 'revise', card: tag, text: 'So sieht es aus' }], false, [a]);
    canvas.commander.arm(heard.token!);
    await settle(30);
    expect(board().item(p.id)!.proposal?.revising).toMatchObject({ images: [a] });
    expect(reviser()!.images[0]).toEqual([canvas.images.path(a)!]);
    expect(board().events(p.id).find((e) => e.author === 'owner')).toMatchObject({ kind: 'say', images: [a] });
  });
});

describe('a proposal its agent takes back', () => {
  test('withdrawn while it is reworked, it stays gone', async () => {
    const p = proposal();
    canvas.revisions.revise(p.id, 'Excel auch', false);
    expect(board().retract(p.from!, 'CSV-Export prüfen', { why: 'Falsch.' }).kind).toBe('gone');
    reviser()!.call('revise_proposal', { title: 'X', task: 'Y', questions: [] });
    reviser()!.emit({ type: 'idle' });
    await settle();
    expect(board().item(p.id)).toBeUndefined();
  });

  test('accepted and replaced since, the owner removes it by a click or keeps it by voice', async () => {
    const p = proposal();
    board().accept(p.id);
    const q = board().propose(p.from!, { title: 'CSV-Kodierung festlegen', task: 'T' });
    expect(board().retract(p.from!, 'CSV-Export prüfen', { by: q.id, title: q.title }).kind).toBe('marked');

    // the Coordinator sees the mark, and keep takes it off
    const heard = canvas.commander.hear('Behalte die alte Karte', { card: p.id }, []);
    await settle();
    const s = runtime.withTool('look_up').at(-1)!;
    expect(s.inbox.at(-1)).toContain('replaced it by "CSV-Kodierung festlegen"; the owner removes it (dismiss) or keeps it (keep)');
    const tag = s.inbox.at(-1)!.match(/(K\d+) \[planned\] "CSV-Export prüfen"/)![1]!;
    s.call('act', { actions: [{ do: 'keep', card: tag }], confirm: 'Sie bleibt.' });
    s.emit({ type: 'idle' });
    canvas.commander.arm((await heard).token!);
    await settle(30);
    expect(board().item(p.id)!.superseded).toBeUndefined();

    board().retract(p.from!, 'CSV-Export prüfen', { why: 'Doch nicht nötig.' });
    await canvas.act(p.id, { action: 'dismiss' });
    expect(board().item(p.id)).toBeUndefined();
  });
});
