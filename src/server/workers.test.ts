import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generic } from '../adapters/generic';
import { needsYou, pausable } from '../core/types';
import { BadRequest, Board } from './board';
import { OBEYA_PLUGIN } from './demo';
import { Images } from './images';
import { Restarter } from './self-update';
import { artifact } from './testing';
import { Workers } from './workers';
import { board, dir, eachTest, flush, main, manual, runtime, setConversation, setLanguage, setWorkers, spaces, state, store, workers } from './workers-fixture';
import { git } from './workspaces';

eachTest();

describe('workers', () => {
  test("a follow-up's worker hears which card it comes from and that card's summary", async () => {
    const src = manual();
    board.work(src.id, { state: 'live', detail: JSON.stringify({ summary: 'CSV-Export gebaut; Excel fehlt noch.' }) });
    const c = board.create({ title: 'Excel-Export', body: 'Excel fehlt.', from: src.id });
    await workers.start(c.id);
    expect(runtime.last.inbox[0]).toContain('Excel fehlt.');
    expect(runtime.last.inbox[0]).toContain('This card follows up on the card “Zählerstände exportieren”. Its worker handed it over with this summary:\n\nCSV-Export gebaut; Excel fehlt noch.');
  });

  test('with an English interface and a German conversation, the worker writes the owner in German until their words say otherwise, commits in English, and the log says what happens in English', async () => {
    setLanguage('en');
    setConversation('de');
    const c = manual();
    await workers.start(c.id);
    expect(runtime.last.spec.system).toContain("ready_for_review) is in the owner's language");
    expect(runtime.last.spec.system).toContain("The owner's language is the one of their most recent words to you, typed or spoken");
    expect(runtime.last.spec.system).toContain('until they have said anything, German.');
    expect(runtime.last.spec.system).toContain('What you commit (code, comments, commit messages, docs, plan docs, CLAUDE.md) is in English, whatever language the owner talks to you in.');
    expect(runtime.last.spec.tools.find((t) => t.name === 'ask')!.description).toContain("Write the question in the owner's language");
    expect(board.events(c.id).at(-1)).toMatchObject({ kind: 'state', text: `Agent started on ${board.row(c.id).branch}.` });
    runtime.last.call('ask', { question: 'Which columns?', options: ['Date', 'Reading'], multiple: true });
    expect(board.events(c.id).at(-1)!.text).toBe('Which columns? (multiple choice)\n– Date\n– Reading');
    await workers.stop(c.id);
    expect(board.events(c.id).at(-1)!.text).toBe('Stopped.');
  });

  test("a repository that names German for what lands in it has its worker commit in German, whatever the owner's language", async () => {
    setConversation('en');
    setWorkers(new Workers({ board, runtime, workspaces: spaces, adapter: { ...generic, land: 'main', workspaces: 'clones', language: 'de' } }));
    await workers.start(manual().id);
    expect(runtime.last.spec.system).toContain('until they have said anything, English.');
    expect(runtime.last.spec.system).toContain('What you commit (code, comments, commit messages, docs, plan docs, CLAUDE.md) is in German');
  });

  test('start leases a clean clone, branches and briefs the worker', async () => {
    const c = manual();
    await workers.start(c.id);
    const row = board.row(c.id);
    expect(state(c.id)).toBe('working');
    expect(row.branch).toMatch(/^obeya\/zahlerstande-exportieren-/);
    expect(git(row.workspace!, 'branch', '--show-current')).toBe(row.branch!);
    expect(runtime.last.spec.cwd).toBe(row.workspace!);
    expect(runtime.last.inbox[0]).toContain('Zählerstände exportieren');
    expect(runtime.last.inbox[0]).toContain('`bun install`');
    expect(runtime.last.inbox[0]).toContain('How to run the app: Start it with `bun run stack`; after an API change, `bun run api:restart`. The URL is in `.stack.env` under WEB_URL.');
    expect(runtime.last.inbox[0]).toContain('Run the app for it as the recipe above says.');
    // a repository without demos gets Obeya's skills all the same: the one that writes its settings among them
    expect(runtime.last.spec.plugins).toEqual([OBEYA_PLUGIN]);
    // the only clone is taken
    const d = manual();
    expect(() => workers.start(d.id)).toThrow(BadRequest);
  });

  test('the screenshots of the task go with it when the worker starts', async () => {
    const images = new Images(join(dir, 'images'));
    const shot = images.save(new Uint8Array([1, 2, 3]), 'image/png');
    setWorkers(new Workers({ board, runtime, workspaces: spaces, adapter: generic, imageFiles: (ids = []) => ids.flatMap((i) => images.path(i) ?? []) }));
    const c = board.create({ title: 'Seite bricht um', x: 0, y: 0, images: [shot] });
    await workers.start(c.id);
    expect(runtime.last.images[0]).toEqual([images.path(shot)!]);
    expect(runtime.last.inbox[0]).toContain(`The owner attached a screenshot to the card (shown with this message; files: ${images.path(shot)})`);
  });

  test('a worker is busy from a message to the end of the turn it starts', async () => {
    const c = manual();
    await workers.start(c.id);
    expect(workers.busyCards().length).toBeGreaterThan(0);
    expect(workers.busyCards()).toEqual([c.id]);
    runtime.last.call('ask', { question: 'CSV oder Excel?' });
    runtime.last.emit({ type: 'idle' });
    expect(workers.busyCards()).toEqual([]);
    expect(workers.busyCards()).toEqual([]);
    workers.answer(c.id, 'CSV');
    expect(workers.busyCards().length).toBeGreaterThan(0);
    runtime.last.emit({ type: 'text', text: 'Dann CSV.' });
    runtime.last.emit({ type: 'idle' });
    // the nudge starts a turn as well
    expect(workers.busyCards().length).toBeGreaterThan(0);
    runtime.last.emit({ type: 'idle' });
    expect(workers.busyCards()).toEqual([]);
    // a turn Obeya did not start, e.g. after a background command finished
    runtime.last.emit({ type: 'text', text: 'Fertig gerendert.' });
    expect(workers.busyCards().length).toBeGreaterThan(0);
  });

  test("the worker's words stand whole in the log: the last of a turn may be its answer to the owner", async () => {
    const c = manual();
    await workers.start(c.id);
    const long = `Nach dem Plan bleibt wenig zu tun. ${'Ein Satz, der weitergeht. '.repeat(60)}Das ist alles.`;
    runtime.last.emit({ type: 'text', text: long });
    expect(board.events(c.id).at(-1)).toMatchObject({ kind: 'say', author: 'worker', text: long });
  });

  test('a due restart is announced to busy workers, who pause for it instead of being nudged', async () => {
    const c = manual();
    await workers.start(c.id);
    const busy = runtime.last;
    busy.emit({ type: 'text', text: 'Ich lasse die Tests laufen.' });
    workers.restartDue({ reason: 'code', deadline: Date.now() + 15 * 60_000 });
    expect(busy.inbox.at(-1)).toContain('Obeya is about to restart (new code landed on main)');
    expect(busy.inbox.at(-1)).toContain('at most 15 more minutes');
    // heard once, however often the restart's waiting list changes
    const told = busy.inbox.length;
    workers.restartDue({ reason: 'code', deadline: Date.now() + 15 * 60_000 });
    expect(busy.inbox.length).toBe(told);
    // the worker ends its turn without handing over: it paused, the owner is not asked
    busy.emit({ type: 'idle' });
    expect(workers.busyCards()).toEqual([]);
    expect(busy.inbox.length).toBe(told);
    expect(state(c.id)).toBe('working');
    expect(board.events(c.id).at(-1)).toMatchObject({ kind: 'state', text: 'Pausiert bis zum Neustart von Obeya.' });
  });

  test('a worker that paused for the restart with its render still running hears, when the render wakes it, that Obeya still waits', async () => {
    const c = manual();
    await workers.start(c.id);
    const busy = runtime.last;
    busy.emit({ type: 'text', text: 'Das Video rendert.' });
    workers.restartDue({ reason: 'code', deadline: Date.now() + 15 * 60_000 });
    expect(busy.inbox.at(-1)).toContain('take in its result and end that turn as well');
    // still in its turn, before it paused: nothing more to hear
    expect(busy.toolStep()).toBeUndefined();
    busy.emit({ type: 'text', text: 'Pausiert; das Rendern läuft weiter.' });
    busy.emit({ type: 'idle', background: 1 });
    expect(workers.busyCards().length).toBeGreaterThan(0);
    // the render finishes and wakes the worker, which would go on from there
    const told = busy.inbox.length;
    busy.emit({ type: 'tool', name: 'Bash', input: { command: 'tail -2 render.log' } });
    expect(busy.toolStep()).toContain('Obeya still waits for the restart (new code landed on main) you paused for, at most 15 more minutes');
    expect(board.events(c.id).at(-1)).toMatchObject({ kind: 'state', text: 'Der Agent ist vor dem Neustart wieder aufgewacht; Obeya sagt ihm, dass der Neustart noch auf ihn wartet.' });
    // once per turn
    expect(busy.toolStep()).toBeUndefined();
    expect(busy.inbox.length).toBe(told);
    busy.emit({ type: 'idle' });
    expect(workers.busyCards()).toEqual([]);
    expect(state(c.id)).toBe('working');
    expect(board.events(c.id).at(-1)).toMatchObject({ kind: 'state', text: 'Pausiert bis zum Neustart von Obeya.' });
    // a note from the owner before the restart says so with the note
    workers.message(c.id, 'Nimm die dunkle Variante.');
    expect(busy.inbox.at(-1)).toContain('Nimm die dunkle Variante.');
    expect(busy.inbox.at(-1)).toContain('Obeya still waits for the restart');
    expect(busy.toolStep()).toBeUndefined();
  });

  test('a status line the worker reports as it pauses for the restart gives way to the one from before: it goes on after the restart', async () => {
    const c = manual();
    await workers.start(c.id);
    const busy = runtime.last;
    busy.call('report', { status: 'Backend steht, jetzt die UI' });
    workers.restartDue({ reason: 'code', deadline: Date.now() + 15 * 60_000 });
    busy.call('report', { status: 'Pausiert für den Neustart; danach: UI' });
    busy.emit({ type: 'idle' });
    expect(board.item(c.id)!.statusLine).toBe('Backend steht, jetzt die UI');
  });

  test('stopping Obeya is announced like a restart, and the worker pauses until Obeya runs again', async () => {
    const c = manual();
    await workers.start(c.id);
    const busy = runtime.last;
    workers.restartDue({ reason: 'stop', deadline: Date.now() + 15 * 60_000 });
    expect(busy.inbox.at(-1)).toContain('Obeya is about to stop (the owner is shutting it down)');
    expect(busy.inbox.at(-1)).toContain('Obeya resumes you once it runs again');
    expect(board.events(c.id).at(-1)).toMatchObject({ kind: 'state', text: 'Beenden von Obeya angekündigt; der Agent pausiert beim nächsten sicheren Punkt.' });
    busy.emit({ type: 'idle' });
    expect(workers.busyCards()).toEqual([]);
    expect(state(c.id)).toBe('working');
    expect(board.events(c.id).at(-1)).toMatchObject({ kind: 'state', text: 'Pausiert, bis Obeya wieder läuft.' });
  });

  test('a restart goes ahead once the workers it announced itself to have paused', async () => {
    const c = manual();
    await workers.start(c.id);
    let gone = 0;
    const restarter = new Restarter({ busy: () => workers.busyCards().map((card) => ({ canvas: 'c', card })), go: () => gone++, intervalMs: 5 });
    restarter.onChange(() => {
      const due = restarter.due();
      workers.restartDue(due && { reason: due.reason, deadline: due.deadline });
    });
    restarter.request('code');
    expect(runtime.last.inbox.at(-1)).toContain('Obeya is about to restart');
    await Bun.sleep(20);
    expect(gone).toBe(0);
    runtime.last.emit({ type: 'idle' });
    await Bun.sleep(20);
    expect(gone).toBe(1);
  });

  test('an answer tells the worker the options picked apart from the owner’s own words', async () => {
    const c = manual();
    await workers.start(c.id);
    runtime.last.call('ask', { question: 'CSV oder Excel?', options: ['CSV', 'Excel'] });
    runtime.last.emit({ type: 'idle' });
    // an option the question does not offer is dropped
    workers.answer(c.id, 'Und mit Kopfzeile.', [], false, undefined, ['CSV', 'PDF']);
    expect(runtime.last.inbox.at(-1)).toContain('Answer to your question (from the owner):\n\nThey picked „CSV“.\n\nThey added in their own words:\n\nUnd mit Kopfzeile.');
    // the log holds the answer as one text, and which options it picked
    expect(board.events(c.id).findLast((e) => e.kind === 'answer')).toMatchObject({ text: 'CSV\n\nUnd mit Kopfzeile.', picks: ['CSV'] });
    runtime.last.emit({ type: 'idle' });
    runtime.last.call('ask', { question: 'Auch PDF?', options: ['Ja', 'Nein'] });
    runtime.last.emit({ type: 'idle' });
    workers.answer(c.id, '', [], false, undefined, ['Nein']);
    expect(runtime.last.inbox.at(-1)).toEndWith('They picked „Nein“.');
  });

  test('a turn that starts while a restart is due hears of it with its message', async () => {
    const c = manual();
    await workers.start(c.id);
    runtime.last.call('ask', { question: 'CSV oder Excel?' });
    runtime.last.emit({ type: 'idle' });
    // not in a turn: nothing to pause
    workers.restartDue({ reason: 'config', deadline: Date.now() + 60_000 });
    const before = runtime.last.inbox.length;
    expect(runtime.last.inbox.at(-1)).not.toContain('about to restart');
    workers.answer(c.id, 'CSV');
    expect(runtime.last.inbox.length).toBe(before + 1);
    expect(runtime.last.inbox.at(-1)).toContain('Answer to your question');
    expect(runtime.last.inbox.at(-1)).toContain('Obeya is about to restart (the owner saved a new configuration)');
    expect(runtime.last.inbox.at(-1)).toContain('at most 1 more minute, and this turn keeps it waiting');
    // not the notice for a worker in the middle of a step: the answer's work waits for the restart
    expect(runtime.last.inbox.at(-1)).toContain('leave the work it asks for until Obeya resumes you');
    expect(runtime.last.inbox.at(-1)).not.toContain('finish the step you are in');
    expect(board.events(c.id).at(-1)).toMatchObject({ kind: 'state', text: 'Obeya wartet auf einen Neustart; der Agent macht danach weiter.' });
    runtime.last.emit({ type: 'idle' });
    expect(state(c.id)).toBe('working');
    expect(board.events(c.id).at(-1)).toMatchObject({ kind: 'state', text: 'Pausiert bis zum Neustart von Obeya.' });
  });

  test('a worker started while a restart is due hears of it in its briefing', async () => {
    workers.restartDue({ reason: 'code', deadline: Date.now() + 10 * 60_000 });
    const c = manual();
    await workers.start(c.id);
    expect(runtime.last.inbox[0]).toContain('Zählerstände exportieren');
    expect(runtime.last.inbox[0]).toContain('Obeya is about to restart');
  });

  test('without a restart due, a turn that ends without handing over is nudged as before', async () => {
    const c = manual();
    await workers.start(c.id);
    workers.restartDue(null);
    runtime.last.emit({ type: 'idle' });
    expect(runtime.last.inbox.at(-1)).toContain('ready_for_review');
  });

  test('report shows on the card and in the log', async () => {
    const c = manual();
    await workers.start(c.id);
    runtime.last.call('report', { status: 'Tests grün' });
    expect(board.item(c.id)!.statusLine).toBe('Tests grün');
    expect(board.events(c.id).at(-1)).toMatchObject({ kind: 'report', text: 'Tests grün' });
  });

  test('a standalone card asks the owner; the answer goes back to the worker', async () => {
    const c = manual();
    await workers.start(c.id);
    expect(runtime.last.inbox[0]).not.toContain('Decisions taken');
    runtime.last.call('ask', { question: 'CSV oder Excel?', options: ['CSV', 'Excel'] });
    expect(state(c.id)).toBe('waiting:question');
    expect(board.item(c.id)!.question).toEqual({ text: 'CSV oder Excel?', options: ['CSV', 'Excel'] });
    workers.answer(c.id, 'CSV');
    expect(state(c.id)).toBe('working');
    expect(runtime.last.inbox.at(-1)).toContain('CSV');
  });

  test('a long option reaches the owner whole', async () => {
    const c = manual();
    await workers.start(c.id);
    const long = 'Die Prototypen bleiben stehen, „Diesen Prototyp bauen“ gibt es nach der Umwandlung aber nicht mehr. Sie lassen sich nur noch ansehen und verwerfen.';
    runtime.last.call('ask', { question: 'Was passiert mit den Prototypen?', options: [long, 'Verwerfen'] });
    expect(board.item(c.id)!.question!.options).toEqual([long, 'Verwerfen']);
  });

  test('a long question reaches the owner whole', async () => {
    const c = manual();
    await workers.start(c.id);
    const script = Array.from({ length: 40 }, (_, i) => `${i + 1} Szene: „Ein Satz für den Sprecher, lang genug zum Gegenlesen.“`).join('\n\n');
    expect(script.length).toBeGreaterThan(2000);
    runtime.last.call('ask', { question: `Hier das Sprechskript:\n\n${script}`, options: ['Passt'] });
    expect(board.item(c.id)!.question!.text).toBe(`Hier das Sprechskript:\n\n${script}`);
    expect(board.events(c.id).at(-1)!.text).toContain('40 Szene');
  });

  test('a question may let the owner choose several options', async () => {
    const c = manual();
    await workers.start(c.id);
    runtime.last.call('ask', { question: 'Welche Spalten?', options: ['Datum', 'Stand', 'Zähler'], multiple: true });
    expect(board.item(c.id)!.question).toEqual({ text: 'Welche Spalten?', options: ['Datum', 'Stand', 'Zähler'], multiple: true });
    expect(board.events(c.id).at(-1)!.text).toContain('Mehrfachauswahl');
    workers.answer(c.id, 'Datum, Stand');
    expect(runtime.last.inbox.at(-1)).toContain('Datum, Stand');
  });

  test('a note instead of an answer takes the question back: the worker goes on or asks anew', async () => {
    const c = manual();
    await workers.start(c.id);
    runtime.last.call('ask', { question: 'CSV oder Excel?', options: ['CSV', 'Excel'] });
    runtime.last.emit({ type: 'idle' });
    workers.message(c.id, 'Exportier erst mal gar nichts, ich kläre das.');
    expect(state(c.id)).toBe('working');
    expect(board.item(c.id)!.question).toBeUndefined();
    expect(runtime.last.inbox.at(-1)).toContain('withdraws your question („CSV oder Excel?“)');
    expect(runtime.last.inbox.at(-1)).toContain('Exportier erst mal gar nichts');
    // a remark is not a decision
    expect(board.decisionsOn(c.id)).toEqual([]);
    expect(() => workers.answer(c.id, 'CSV')).toThrow(BadRequest);
  });

  test('reply answers a note in the conversation, and the worker works on', async () => {
    const c = manual();
    await workers.start(c.id);
    workers.message(c.id, 'Bitte auch Excel.');
    expect(runtime.last.toolStep()).toContain('Bitte auch Excel.');
    expect(runtime.last.call('reply', { text: 'Mache ich: Excel kommt als zweites Format dazu.' })).toBe('Shown to the owner.');
    expect(board.events(c.id).at(-1)).toMatchObject({ kind: 'talk', author: 'worker', text: 'Mache ich: Excel kommt als zweites Format dazu.' });
    expect(state(c.id)).toBe('working');
    // a reply is no handover: the turn ending after it is nudged
    runtime.last.emit({ type: 'text', text: 'Excel ist eingebaut.' });
    const before = runtime.last.inbox.length;
    runtime.last.emit({ type: 'idle' });
    expect(runtime.last.inbox.length).toBe(before + 1);
  });

  test('a note during a turn waits, unread, for the next step, and stands where the worker read it', async () => {
    const c = manual();
    await workers.start(c.id);
    const s = runtime.last;
    s.emit({ type: 'tool', name: 'Read', input: { file_path: 'export.ts' } });
    workers.message(c.id, 'Bitte auch Excel.', ['/tmp/shot.png']);
    const note = board.events(c.id).at(-1)!;
    expect(note).toMatchObject({ kind: 'hint', unread: true });
    // not in the session's input, where the CLI would take it at a moment Obeya does not learn
    expect(s.inbox.join()).not.toContain('Bitte auch Excel.');
    s.emit({ type: 'tool', name: 'Edit', input: { file_path: 'export.ts' } });
    const edit = board.events(c.id).at(-1)!;
    const heard = s.toolStep()!;
    expect(heard).toContain('A note from the owner');
    expect(heard).toContain('Bitte auch Excel.');
    // a tool result carries no images: the worker reads the file
    expect(heard).toContain('read their files to see them (/tmp/shot.png)');
    expect(board.events(c.id).find((e) => e.id === note.id)).toMatchObject({ readAfter: edit.id });
    expect(board.events(c.id).find((e) => e.id === note.id)!.unread).toBeUndefined();
    // taken once
    expect(s.toolStep()).toBeUndefined();
  });

  test('a note that waited for a step that asks comes with its result, which leaves the worker to answer it or ask anew', async () => {
    const c = manual();
    await workers.start(c.id);
    const s = runtime.last;
    s.emit({ type: 'tool', name: 'Read', input: { file_path: 'export.ts' } });
    workers.message(c.id, 'Bitte vorher auf main rebasen.');
    const result = s.call('ask', { question: 'Soll das Video Ton haben?', options: ['Ja', 'Nein'] }) as string;
    expect(result).not.toContain('without further work');
    expect(result).toContain('your question waits for the owner on the card');
    expect(result).toContain('Answer them with reply where they call for an answer');
    expect(result).toContain('ask it anew');
    expect(result).toContain('Bitte vorher auf main rebasen.');
    // the note stands below the question, where the worker read it, and the step's context carries it no more
    const question = board.events(c.id).findLast((e) => e.kind === 'question')!;
    expect(board.events(c.id).find((e) => e.text === 'Bitte vorher auf main rebasen.')).toMatchObject({ readAfter: question.id });
    expect(s.toolStep()).toBeUndefined();
    // it answers, and asks anew: the card waits for the new question
    s.call('reply', { text: 'Mache ich, bevor ich neu rendere.' });
    s.call('ask', { question: 'Soll das Video nach dem Rebase Ton haben?', options: ['Ja', 'Nein'] });
    s.emit({ type: 'idle' });
    expect(state(c.id)).toBe('waiting:question');
    expect(board.item(c.id)!.question?.text).toBe('Soll das Video nach dem Rebase Ton haben?');
    // without words waiting, the result just ends the turn
    workers.answer(c.id, 'Ja');
    expect(s.call('ask', { question: 'Mit Untertiteln?' })).toContain('End your turn now without further work');
  });

  test('a note that waited for a handover comes with its result', async () => {
    const c = manual();
    await workers.start(c.id);
    const s = runtime.last;
    workers.message(c.id, 'Und die Spaltennamen auf Deutsch.');
    const result = (await s.call('ready_for_review', { summary: 'Export als CSV.', demo: artifact() })) as string;
    expect(result).toContain("your handover waits for the owner's approval");
    expect(result).toContain('hand it over again');
    expect(result).toContain('Und die Spaltennamen auf Deutsch.');
    expect(s.toolStep()).toBeUndefined();
  });

  test('a note the turn ended before taking in starts the next turn', async () => {
    const c = manual();
    await workers.start(c.id);
    const s = runtime.last;
    s.emit({ type: 'text', text: 'Fertig mit dem Export.' });
    workers.message(c.id, 'Und die Spaltennamen auf Deutsch.');
    const before = s.inbox.length;
    s.emit({ type: 'idle' });
    expect(s.inbox.length).toBe(before + 1);
    expect(s.inbox.at(-1)).toContain('Und die Spaltennamen auf Deutsch.');
    // no nudge for the turn: the note's is the next
    expect(s.inbox.join()).not.toContain('without a handover');
    expect(board.events(c.id).find((e) => e.text === 'Und die Spaltennamen auf Deutsch.')!.unread).toBeUndefined();
    // between turns a note goes in at once, read
    s.emit({ type: 'idle' });
    workers.message(c.id, 'Danke.');
    expect(s.inbox.at(-1)).toContain('Danke.');
    expect(board.events(c.id).at(-1)!.unread).toBeUndefined();
  });

  test('a note not read yet can be taken back: the worker never hears it', async () => {
    const c = manual();
    await workers.start(c.id);
    const s = runtime.last;
    workers.message(c.id, 'Bitte auch Excel.');
    workers.message(c.id, 'Und PDF.');
    const [excel, pdf] = board.events(c.id).slice(-2);
    workers.unsay(c.id, excel!.id);
    expect(board.events(c.id).map((e) => e.id)).not.toContain(excel!.id);
    const heard = s.toolStep()!;
    expect(heard).not.toContain('Bitte auch Excel.');
    expect(heard).toContain('Und PDF.');
    // once read, it stays
    expect(() => workers.unsay(c.id, pdf!.id)).toThrow(BadRequest);
  });

  test('notes not read when the session ends go to it when it goes on', async () => {
    const c = manual();
    await workers.start(c.id);
    runtime.last.emit({ type: 'session', id: 'sess-1' });
    workers.message(c.id, 'Bitte auch Excel.');
    workers.pause(c.id);
    expect(board.events(c.id).find((e) => e.text === 'Bitte auch Excel.')!.unread).toBe(true);
    workers.resume(c.id);
    expect(runtime.last.inbox[0]).toContain('Bitte auch Excel.');
    expect(board.events(c.id).find((e) => e.text === 'Bitte auch Excel.')!.unread).toBeUndefined();
  });

  test('a note in reply to a message points the worker at it, and the conversation keeps which one', async () => {
    const c = manual();
    await workers.start(c.id);
    runtime.last.call('reply', { text: `Ich exportiere die Zählerstände als CSV mit Semikolon als Trenner, wie Excel es in Deutschland erwartet. ${'Mehr dazu. '.repeat(30)}` });
    const replied = board.events(c.id).at(-1)!;
    workers.message(c.id, 'Lieber Komma.', [], false, replied.id);
    // the worker has the whole message in its session: the start of it says which one
    expect(runtime.last.toolStep()).toContain('[In reply to your message: „Ich exportiere die Zählerstände als CSV mit Semikolon als Trenner, wie Excel es in Deutschland erwartet. Mehr dazu. Mehr dazu. Mehr dazu. Mehr dazu. Mehr dazu. …“]\n\nLieber Komma.');
    expect(board.events(c.id).at(-1)).toMatchObject({ kind: 'hint', author: 'owner', text: 'Lieber Komma.', replyTo: replied.id });
    // Obeya's words in the conversation the worker never had: it reads them whole
    const aside = board.log(c.id, 'say', 'koordinator', 'Die Karte „Import“ liegt auf einer anderen Leinwand.');
    workers.message(c.id, 'Dann lass es.', [], false, aside.id);
    expect(runtime.last.toolStep()).toContain("[In reply to Obeya's message in the card's conversation: „Die Karte „Import“ liegt auf einer anderen Leinwand.“]\n\nDann lass es.");
    // a question answered in reply to it says so too
    runtime.last.call('ask', { question: 'CSV oder Excel?', options: ['CSV', 'Excel'] });
    const asked = board.events(c.id).findLast((e) => e.kind === 'question')!;
    workers.answer(c.id, 'CSV', [], false, asked.id);
    runtime.last.emit({ type: 'idle' });
    expect(runtime.last.inbox.at(-1)).toContain('[In reply to your question: „CSV oder Excel?');
    expect(board.events(c.id).at(-1)).toMatchObject({ kind: 'answer', replyTo: asked.id });
  });

  test('a reply to a step, a state line or another card is the words alone', async () => {
    const c = manual();
    const other = manual();
    await workers.start(c.id);
    const line = board.events(c.id).findLast((e) => e.kind === 'state')!;
    const elsewhere = board.log(other.id, 'say', 'koordinator', 'Anderswo.');
    for (const id of [line.id, elsewhere.id, 99999]) {
      expect(board.quoted(c.id, id)).toBeUndefined();
      workers.message(c.id, 'Weiter.', [], false, board.quoted(c.id, id)?.id);
      expect(runtime.last.inbox.at(-1)).not.toContain('In reply to');
      expect(board.events(c.id).at(-1)!.replyTo).toBeUndefined();
    }
  });

  const words = (id: string) => board.events(id).filter((e) => e.author === 'worker' && ['say', 'talk', 'closing'].includes(e.kind)).map((e) => `${e.kind}: ${e.text}`);

  test("after a reply on a card waiting for review, the worker's closing words are logged as such, to fold under the reply; after a handover they are left out", async () => {
    const c = manual();
    await workers.start(c.id);
    await runtime.last.call('ready_for_review', { summary: 'Export gebaut.', demo: artifact() });
    // those after a handover repeat it
    runtime.last.emit({ type: 'text', text: 'Übergeben: Export gebaut.' });
    runtime.last.emit({ type: 'idle' });
    workers.message(c.id, 'Die App läuft nicht mehr.');
    runtime.last.emit({ type: 'text', text: 'I will restart the app.' });
    runtime.last.emit({ type: 'tool', name: 'Bash', input: { command: 'bun start' } });
    runtime.last.call('reply', { text: 'Die App läuft jetzt unter http://127.0.0.1:62582.' });
    runtime.last.emit({ type: 'text', text: "I restarted the app; it's at http://127.0.0.1:62582." });
    runtime.last.emit({ type: 'idle' });
    expect(state(c.id)).toBe('waiting:demo');
    expect(words(c.id)).toEqual([
      'say: I will restart the app.',
      'talk: Die App läuft jetzt unter http://127.0.0.1:62582.',
      "closing: I restarted the app; it's at http://127.0.0.1:62582.",
    ]);
  });

  test("after a reply on a card at work, the worker's words before its next step are its words, its turn's last its closing words", async () => {
    const d = manual();
    await workers.start(d.id);
    workers.message(d.id, 'Bitte auch Excel.');
    runtime.last.call('reply', { text: 'Mache ich.' });
    runtime.last.emit({ type: 'text', text: 'Now the Excel export.' });
    runtime.last.emit({ type: 'tool', name: 'Edit', input: {} });
    runtime.last.emit({ type: 'text', text: 'Excel is in, as I said.' });
    runtime.last.emit({ type: 'idle' });
    expect(words(d.id)).toEqual(['talk: Mache ich.', 'say: Now the Excel export.', 'closing: Excel is in, as I said.']);
    // the next turn's words are words again
    runtime.last.emit({ type: 'text', text: 'Weiter mit den Tests.' });
    expect(words(d.id).at(-1)).toBe('say: Weiter mit den Tests.');
  });

  test("a task the owner wrote tells the worker the language they talk in; one from a plan doc tells nothing", async () => {
    const c = board.create({ title: 'Contributing guide', body: 'Add a CONTRIBUTING.md.', x: 0, y: 0 });
    await workers.start(c.id);
    expect(runtime.last.spec.system).toContain("until they have said anything, the language the card's task is written in, since the owner wrote it themselves: they told you their language with it (only where it tells none, German).");
    expect(runtime.last.inbox[0]).toContain('Add a CONTRIBUTING.md.\n\nThe owner wrote this task themselves: write to them in its language.');
    await workers.stop(c.id);
    const w = board.snapshot().items.find((i) => i.label === 'W1')!;
    await workers.start(w.id);
    expect(runtime.last.spec.system).toContain("until they have said anything, German. What you write to the owner is in the owner's language, also where what you work on is in another. The card's task comes from the project's plan doc, not from the owner: its language tells nothing about theirs.");
    expect(runtime.last.inbox[0]).not.toContain('The owner wrote this task themselves');
  });

  test("a workstream's question goes straight to the owner, too", async () => {
    const w = board.snapshot().items.find((i) => i.label === 'W1')!;
    await workers.start(w.id);
    runtime.last.call('ask', { question: 'Darf ich den Dienst X buchen?', options: ['Ja', 'Nein'] });
    expect(state(w.id)).toBe('waiting:question');
    expect(board.item(w.id)!.question).toEqual({ text: 'Darf ich den Dienst X buchen?', options: ['Ja', 'Nein'] });
    expect(board.item(w.id)!.statusLine).toBeUndefined();
    workers.answer(w.id, 'Nein');
    expect(runtime.last.inbox.at(-1)).toContain('from the owner');
    expect(board.decisions(board.item(w.id)!.parent!).at(-1)).toMatchObject({ question: expect.stringContaining('Dienst X'), answer: 'Nein', by: 'owner' });
  });

  test("the worker's own pick goes with its question, and the owner still decides", async () => {
    const c = manual();
    await workers.start(c.id);
    runtime.last.call('ask', { question: 'CSV oder Excel?', options: ['CSV', 'Excel'], pick: ['Excel'], pick_why: 'Die Buchhaltung arbeitet in Excel.' });
    expect(state(c.id)).toBe('waiting:question');
    expect(board.item(c.id)!.question).toEqual({ text: 'CSV oder Excel?', options: ['CSV', 'Excel'], pick: { options: ['Excel'], why: 'Die Buchhaltung arbeitet in Excel.' } });
    workers.answer(c.id, 'CSV');
    expect(runtime.last.inbox.at(-1)).toContain('CSV');
    // a pick that names no option, or several on a single choice, is left out or cut to one
    runtime.last.call('ask', { question: 'Trennzeichen?', options: ['Komma', 'Semikolon'], pick: ['Tab'], pick_why: 'Egal.' });
    expect(board.item(c.id)!.question!.pick).toBeUndefined();
    workers.answer(c.id, 'Komma');
    runtime.last.call('ask', { question: 'Kopfzeile?', options: ['Ja', 'Nein'], pick: ['Ja', 'Nein'] });
    expect(board.item(c.id)!.question!.pick).toEqual({ options: ['Ja'], why: '' });
  });

  test("a workstream's worker gets its project's decisions, and those taken while it works once", async () => {
    const w = board.snapshot().items.find((i) => i.label === 'W1')!;
    const project = w.parent!;
    // the project's other cards: here the project itself stands in for them
    board.decide({ project_id: project, card_id: project, question: 'Welche Spalten?', answer: 'Alle.', by: 'owner' });
    await workers.start(w.id);
    const s = runtime.last;
    expect(s.inbox[0]).toContain('Decisions taken in this project so far:\n- Welche Spalten? → Alle. (owner)');
    expect(s.toolStep()).toBeUndefined();

    s.call('ask', { question: 'Kopfzeile?', options: ['Ja', 'Nein'] });
    workers.answer(w.id, 'Ja');
    // its own answer it heard as one
    expect(s.toolStep()).toBeUndefined();
    board.decide({ project_id: project, card_id: project, question: 'Datumsformat?', answer: 'ISO', by: 'owner' });
    expect(s.toolStep()).toBe('Decisions taken in this project while you work:\n- Datumsformat? → ISO (owner)');
    expect(s.toolStep()).toBeUndefined();
  });

  test('a turn that ends without handing over is nudged once, then goes to the owner', async () => {
    const c = manual();
    await workers.start(c.id);
    runtime.last.emit({ type: 'text', text: 'Ich komme nicht an die Datenbank.' });
    runtime.last.emit({ type: 'idle' });
    expect(state(c.id)).toBe('working');
    expect(runtime.last.inbox.at(-1)).toContain('ready_for_review');
    runtime.last.emit({ type: 'idle' });
    expect(state(c.id)).toBe('waiting:question');
    expect(board.item(c.id)!.question!.text).toBe('Ich komme nicht an die Datenbank.');
  });

  test('a session that fails again after the nudge goes to the owner with the reason', async () => {
    const c = manual();
    await workers.start(c.id);
    runtime.last.emit({ type: 'text', text: 'Ich fange an.' });
    runtime.last.emit({ type: 'error', message: 'Not logged in · Please run /login' });
    runtime.last.emit({ type: 'idle' });
    expect(state(c.id)).toBe('working');
    runtime.last.emit({ type: 'error', message: 'Not logged in · Please run /login' });
    runtime.last.emit({ type: 'idle' });
    expect(state(c.id)).toBe('waiting:question');
    expect(board.item(c.id)!.question!.text).toContain('nicht angemeldet');
  });

  test('an error of a session that signed in with a token says so in the conversation', async () => {
    const c = manual();
    await workers.start(c.id);
    runtime.last.emit({ type: 'error', message: 'OAuth token has expired', token: true });
    runtime.last.emit({ type: 'error', message: 'API Error: 500' });
    const errors = board.events(c.id).filter((e) => e.kind === 'error');
    expect(errors.map((e) => e.token)).toEqual([true, undefined]);
  });

  test('a worker the usage limit stopped goes on by itself once the limit lifts', async () => {
    setWorkers(new Workers({ board, runtime, workspaces: spaces, adapter: { ...generic, land: 'main', workspaces: 'clones' }, limitMargin: 30 }));
    const c = manual();
    await workers.start(c.id);
    runtime.last.call('report', { status: 'Exporter steht' });
    runtime.last.emit({ type: 'text', text: 'Ich schreibe die Tests.' });
    const hit = "You've hit your session limit · resets 2:40pm (Europe/Berlin)";
    runtime.last.emit({ type: 'error', message: hit, limit: { resetsAt: Date.now() + 20 } });
    runtime.last.emit({ type: 'idle' });
    const sent = runtime.last.inbox.length;
    // no nudge, no question to the owner: the card waits for the limit, and a restart need not wait for it
    expect(state(c.id)).toBe('working');
    expect(workers.busyCards()).toEqual([]);
    expect(board.item(c.id)!.statusLine).toStartWith('Nutzungslimit · weiter um ');
    expect(board.events(c.id).at(-1)).toMatchObject({ kind: 'state', author: 'obeya' });
    expect(board.events(c.id).at(-1)!.text).toContain('automatisch weiter');
    await Bun.sleep(60);
    expect(runtime.last.inbox.length).toBe(sent + 1);
    expect(runtime.last.inbox.at(-1)).toContain('usage limit');
    expect(workers.busyCards().length).toBeGreaterThan(0);
    // the limit still holds: it waits again, and its status line stays what it was before
    runtime.last.emit({ type: 'error', message: hit, limit: { resetsAt: Date.now() + 10_000 } });
    runtime.last.emit({ type: 'idle' });
    expect(state(c.id)).toBe('working');
    runtime.last.emit({ type: 'text', text: 'Weiter mit den Tests.' });
    expect(board.item(c.id)!.statusLine).toBe('Exporter steht');
    await workers.stop(c.id);
  });

  test("a worker the usage limit stopped while it took in the owner's words on its handover stays at them and goes on once it lifts", async () => {
    setWorkers(new Workers({ board, runtime, workspaces: spaces, adapter: { ...generic, land: 'main', workspaces: 'clones' }, limitMargin: 30 }));
    const c = manual();
    await workers.start(c.id);
    await runtime.last.call('ready_for_review', { summary: 'Studie fertig.', demo: artifact() });
    runtime.last.emit({ type: 'idle' });
    workers.message(c.id, 'Und wenn wir früher handeln?');
    runtime.last.call('reply', { text: 'Ich rechne das nach.' });
    runtime.last.call('report', { status: 'Rechne frühes Handeln nach' });
    runtime.last.emit({ type: 'tool', name: 'Bash', input: { command: 'python3 study.py' } });
    runtime.last.emit({ type: 'error', message: "You've hit your session limit", limit: { resetsAt: Date.now() + 20 } });
    runtime.last.emit({ type: 'idle' });
    const sent = runtime.last.inbox.length;
    // the card does not wait for the owner: its worker is still at their words, and says why it rests
    expect(board.item(c.id)).toMatchObject({ state: 'waiting', need: 'demo', answering: true });
    expect(needsYou(board.item(c.id)!)).toBe(false);
    expect(board.item(c.id)!.statusLine).toStartWith('Nutzungslimit · weiter um ');
    expect(workers.busyCards()).toEqual([]);
    await Bun.sleep(60);
    expect(runtime.last.inbox.length).toBe(sent + 1);
    expect(runtime.last.inbox.at(-1)).toContain('usage limit');
    runtime.last.emit({ type: 'text', text: 'Weiter mit der Rechnung.' });
    expect(board.item(c.id)!.statusLine).toBe('Rechne frühes Handeln nach');
    await workers.stop(c.id);
  });

  test('a worker the usage limit stopped while its background work runs says so, and goes on once it lifts', async () => {
    setWorkers(new Workers({ board, runtime, workspaces: spaces, adapter: { ...generic, land: 'main', workspaces: 'clones' }, limitMargin: 30 }));
    const c = manual();
    await workers.start(c.id);
    runtime.last.call('report', { status: 'Rendere das Demo-Video' });
    runtime.last.emit({ type: 'background', tasks: [{ id: 'render', description: 'node demo.ts' }] });
    runtime.last.emit({ type: 'error', message: "You've hit your session limit", limit: { resetsAt: Date.now() + 20 } });
    runtime.last.emit({ type: 'idle', background: 1 });
    const sent = runtime.last.inbox.length;
    expect(state(c.id)).toBe('working');
    expect(board.item(c.id)!.statusLine).toStartWith('Nutzungslimit · weiter um ');
    // the render still runs in the session: a restart waits for it
    expect(workers.busyCards().length).toBeGreaterThan(0);
    // the owner's words the limit cut off need not wait for the render to end
    await Bun.sleep(60);
    expect(runtime.last.inbox.length).toBe(sent + 1);
    expect(runtime.last.inbox.at(-1)).toContain('usage limit');
    await workers.stop(c.id);
  });

  test('a worker the usage limit stopped is no longer busy once its background work stopped counting', async () => {
    setWorkers(new Workers({ board, runtime, workspaces: spaces, adapter: { ...generic, land: 'main', workspaces: 'clones' }, backgroundLimit: 10 }));
    const c = manual();
    await workers.start(c.id);
    runtime.last.emit({ type: 'background', tasks: [{ id: 'watch', description: 'watch the deploy' }] });
    runtime.last.emit({ type: 'error', message: "You've hit your session limit", limit: { resetsAt: Date.now() + 60_000 } });
    runtime.last.emit({ type: 'idle', background: 1 });
    expect(workers.busyCards().length).toBeGreaterThan(0);
    // the session never says the work ended: after the wait for it, the worker only waits for the limit
    await Bun.sleep(40);
    expect(workers.busyCards()).toEqual([]);
    expect(board.item(c.id)!.statusLine).toStartWith('Nutzungslimit · weiter um ');
    await workers.stop(c.id);
  });

  test('a worker the usage limit stopped is not woken once stopped', async () => {
    setWorkers(new Workers({ board, runtime, workspaces: spaces, adapter: { ...generic, land: 'main', workspaces: 'clones' }, limitMargin: 10 }));
    const c = manual();
    await workers.start(c.id);
    runtime.last.emit({ type: 'error', message: "You've hit your session limit", limit: { resetsAt: Date.now() + 20 } });
    runtime.last.emit({ type: 'idle' });
    const session = runtime.last;
    const sent = session.inbox.length;
    await workers.stop(c.id);
    await Bun.sleep(40);
    expect(session.inbox.length).toBe(sent);
    expect(runtime.sessions.length).toBe(1);
  });

  test('a turn in which the worker did nothing does not use up its nudge', async () => {
    setWorkers(new Workers({ board, runtime, workspaces: spaces, adapter: { ...generic, land: 'main', workspaces: 'clones' }, backgroundGrace: 5, backgroundLimit: 5 }));
    const c = manual();
    await workers.start(c.id);
    const before = runtime.last.inbox.length;
    // a resumed session first ends a turn over what the previous one left, before the worker's own
    runtime.last.emit({ type: 'idle' });
    expect(runtime.last.inbox.length).toBe(before);
    expect(workers.busyCards().length).toBeGreaterThan(0);
    runtime.last.emit({ type: 'tool', name: 'Bash', input: { command: 'node demo.ts' } });
    runtime.last.emit({ type: 'text', text: 'Die Demo wird neu gerendert.' });
    runtime.last.emit({ type: 'idle', background: 1 });
    await Bun.sleep(20);
    // the render outlasted the wait: the worker is nudged, its status is no question to the owner
    expect(state(c.id)).toBe('working');
    expect(runtime.last.inbox.at(-1)).toContain('ready_for_review');
  });

  test('a turn in which the worker did nothing counts as ended after a while', async () => {
    setWorkers(new Workers({ board, runtime, workspaces: spaces, adapter: { ...generic, land: 'main', workspaces: 'clones' }, backgroundGrace: 5 }));
    const c = manual();
    await workers.start(c.id);
    runtime.last.emit({ type: 'idle' });
    await Bun.sleep(20);
    expect(runtime.last.inbox.at(-1)).toContain('ready_for_review');
    runtime.last.emit({ type: 'idle' });
    expect(state(c.id)).toBe('waiting:question');
  });

  test('a turn that ends while background work runs waits for it, not for the owner', async () => {
    const c = manual();
    await workers.start(c.id);
    runtime.last.emit({ type: 'text', text: 'Das Video rendert noch, ich warte darauf.' });
    const before = runtime.last.inbox.length;
    runtime.last.emit({ type: 'idle', background: 1 });
    runtime.last.emit({ type: 'idle', background: 1 });
    expect(state(c.id)).toBe('working');
    expect(runtime.last.inbox.length).toBe(before);
    // a restart now would cut the render off
    expect(workers.busyCards().length).toBeGreaterThan(0);
    // the render ends and wakes the worker, which hands over
    runtime.last.emit({ type: 'text', text: 'Video fertig.' });
    await runtime.last.call('ready_for_review', { summary: 'Fertig.', demo: artifact() });
    runtime.last.emit({ type: 'idle' });
    expect(state(c.id)).toBe('waiting:demo');
  });

  test('a card handed over while its app is still served waits for the owner with nobody at work, the serving shown', async () => {
    const c = manual();
    await workers.start(c.id);
    runtime.last.emit({ type: 'background', tasks: [{ id: 'serve', description: 'Serve the app on port 8743 for 4 min' }] });
    // at work, the serving is part of the turn
    expect(board.item(c.id)).toMatchObject({ inTurn: true, background: [{ description: 'Serve the app on port 8743 for 4 min' }] });
    await runtime.last.call('ready_for_review', { summary: 'Fertig.', demo: artifact() });
    expect(board.item(c.id)!.inTurn).toBe(true);
    // as the server's push to the page does, the board is read at each change
    board.onChange(() => board.snapshot());
    runtime.last.emit({ type: 'idle', background: 1 });
    expect(state(c.id)).toBe('waiting:demo');
    // the turn is over: the serving still runs and holds the slot, but nothing is at work or to pause
    const card = board.item(c.id)!;
    expect(card.inTurn).toBeUndefined();
    expect(card.background?.map((b) => b.description)).toEqual(['Serve the app on port 8743 for 4 min']);
    expect(pausable(card)).toBe(false);
    expect(workers.busyCards()).toEqual([c.id]);
    // once it stops, nothing of it shows
    runtime.last.emit({ type: 'background', tasks: [] });
    expect(board.item(c.id)!.background).toBeUndefined();
    // a note from the owner starts a turn again: the agent is at work on it
    runtime.last.emit({ type: 'background', tasks: [{ id: 'serve', description: 'Serve the app on port 8743 for 4 min' }] });
    runtime.last.emit({ type: 'idle', background: 1 });
    expect(board.item(c.id)!.inTurn).toBeUndefined();
    runtime.last.emit({ type: 'text', text: 'Der Server läuft noch.' });
    expect(board.item(c.id)!.inTurn).toBe(true);
  });

  test('background work that ends without waking the worker counts as an ended turn after a while', async () => {
    setWorkers(new Workers({ board, runtime, workspaces: spaces, adapter: { ...generic, land: 'main', workspaces: 'clones' }, backgroundGrace: 5 }));
    const c = manual();
    await workers.start(c.id);
    runtime.last.emit({ type: 'text', text: 'Ich warte auf den Server.' });
    runtime.last.emit({ type: 'idle', background: 1 });
    await Bun.sleep(20);
    // as long as the work runs, the worker waits for it: nothing comes after its brief
    const brief = runtime.last.inbox.length;
    expect(workers.busyCards().length).toBeGreaterThan(0);
    runtime.last.emit({ type: 'background', tasks: [] });
    await Bun.sleep(20);
    expect(runtime.last.inbox.length).toBe(brief + 1);
    expect(runtime.last.inbox.at(-1)).toContain('ready_for_review');
    runtime.last.emit({ type: 'idle', background: 1 });
    runtime.last.emit({ type: 'background', tasks: [] });
    await Bun.sleep(20);
    expect(state(c.id)).toBe('waiting:question');
    expect(workers.busyCards()).toEqual([]);
    expect(board.item(c.id)!.question!.text).toBe('Ich warte auf den Server.');
  });

  test('background work the session never reports as ended counts as an ended turn after a long while', async () => {
    setWorkers(new Workers({ board, runtime, workspaces: spaces, adapter: { ...generic, land: 'main', workspaces: 'clones' }, backgroundGrace: 1000, backgroundLimit: 5 }));
    const c = manual();
    await workers.start(c.id);
    runtime.last.emit({ type: 'text', text: 'Ich warte auf den Server.' });
    runtime.last.emit({ type: 'idle', background: 1 });
    await Bun.sleep(20);
    expect(runtime.last.inbox.at(-1)).toContain('ready_for_review');
  });

  test('a worker that asks while its background work runs counts as busy until the work wakes it', async () => {
    setWorkers(new Workers({ board, runtime, workspaces: spaces, adapter: { ...generic, land: 'main', workspaces: 'clones' }, backgroundGrace: 5, backgroundLimit: 5 }));
    const c = manual();
    await workers.start(c.id);
    runtime.last.call('ask', { question: 'Soll das Video Ton haben?' });
    runtime.last.emit({ type: 'idle', background: 1 });
    // the question reaches the owner at once, but a restart now would cut the render off
    expect(state(c.id)).toBe('waiting:question');
    expect(workers.busyCards().length).toBeGreaterThan(0);
    await Bun.sleep(20);
    // a watcher nobody stopped does not keep a restart away for good
    expect(workers.busyCards()).toEqual([]);
    expect(state(c.id)).toBe('waiting:question');
  });

  test('the card shows the background work that keeps its worker in a turn, each since it started, until it ends', async () => {
    setWorkers(new Workers({ board, runtime, workspaces: spaces, adapter: { ...generic, land: 'main', workspaces: 'clones' }, backgroundGrace: 1000, backgroundLimit: 1000 }));
    const c = manual();
    await workers.start(c.id);
    const s = runtime.last;
    const t0 = Date.now();
    s.emit({ type: 'background', tasks: [{ id: 'b1', description: 'Run the test suite' }] });
    expect(board.item(c.id)!.background).toEqual([{ description: 'Run the test suite', since: expect.any(Number) }]);
    const since = board.item(c.id)!.background![0]!.since;
    expect(since).toBeGreaterThanOrEqual(t0);
    await Bun.sleep(5);
    s.emit({ type: 'background', tasks: [{ id: 'b1', description: 'Run the test suite' }, { id: 'a1', description: 'Review the diff' }] });
    s.call('ask', { question: 'Soll das Video Ton haben?' });
    s.emit({ type: 'idle', background: 2 });
    // after the question the turn stays open for the work, and the card says which
    expect(state(c.id)).toBe('waiting:question');
    const shown = board.item(c.id)!.background!;
    expect(shown.map((x) => x.description)).toEqual(['Run the test suite', 'Review the diff']);
    expect(shown[0]!.since).toBe(since);
    expect(shown[1]!.since).toBeGreaterThan(since);
    // one ends: it goes from the card, the other stays
    s.emit({ type: 'background', tasks: [{ id: 'a1', description: 'Review the diff' }] });
    expect(board.item(c.id)!.background!.map((x) => x.description)).toEqual(['Review the diff']);
    // the last one wakes the worker, whose turn then ends with nothing in the background
    s.emit({ type: 'background', tasks: [] });
    expect(board.item(c.id)!.background).toBeUndefined();
    s.emit({ type: 'text', text: 'Review gelesen.' });
    s.emit({ type: 'idle', background: 0 });
    expect(board.item(c.id)!.inTurn).toBeUndefined();
    expect(board.item(c.id)!.background).toBeUndefined();
  });

  test('a note to a worker waiting for its background work starts a turn of its own', async () => {
    setWorkers(new Workers({ board, runtime, workspaces: spaces, adapter: { ...generic, land: 'main', workspaces: 'clones' }, backgroundGrace: 5 }));
    const c = manual();
    await workers.start(c.id);
    runtime.last.emit({ type: 'idle', background: 1 });
    const before = runtime.last.inbox.length;
    workers.message(c.id, 'Nimm die dunkle Variante.');
    await Bun.sleep(20);
    // the wait ended with the note, not with a nudge in the middle of the note's turn
    expect(runtime.last.inbox.length).toBe(before + 1);
    expect(workers.busyCards().length).toBeGreaterThan(0);
  });

  test('a preference learned while a worker runs reaches it once, with its next tool step', async () => {
    setWorkers(new Workers({ board, runtime, workspaces: spaces, adapter: { ...generic, land: 'main', workspaces: 'clones' }, preferences: () => board.preferencesText() }));
    board.addPreference('Antworten auf Deutsch.');
    const c = manual();
    await workers.start(c.id);
    const s = runtime.last;
    expect(s.spec.system).toContain('- Antworten auf Deutsch.');
    expect(s.spec.system).toContain('Never wait with sleep or a polling loop in the foreground');
    // what its instructions hold is nothing new
    expect(s.toolStep()).toBeUndefined();
    const id = board.addPreference('Keine Commits ohne Tests.');
    expect(s.toolStep()).toContain('- Keine Commits ohne Tests.');
    expect(s.toolStep()).toBeUndefined();
    board.setPreference(id, null);
    expect(s.toolStep()).not.toContain('Keine Commits ohne Tests.');
    // silently: no message, no new turn
    expect(s.inbox).toHaveLength(1);
  });

  test('a worker that stopped and then works on by itself takes its question back', async () => {
    const c = manual();
    await workers.start(c.id);
    runtime.last.emit({ type: 'text', text: 'Ich komme nicht weiter.' });
    runtime.last.emit({ type: 'idle' });
    runtime.last.emit({ type: 'idle' });
    expect(state(c.id)).toBe('waiting:question');
    runtime.last.emit({ type: 'tool', name: 'Bash', input: { command: 'ls' } });
    expect(state(c.id)).toBe('working');
    // a question it asks itself stays with the owner
    runtime.last.call('ask', { question: 'CSV oder Excel?' });
    runtime.last.emit({ type: 'text', text: 'Ich warte auf die Antwort.' });
    expect(state(c.id)).toBe('waiting:question');
  });

  test('handing over ends the turn without a nudge', async () => {
    const c = manual();
    await workers.start(c.id);
    runtime.last.call('ask', { question: 'Q?' });
    const before = runtime.last.inbox.length;
    runtime.last.emit({ type: 'idle' });
    expect(runtime.last.inbox.length).toBe(before);
  });

  test('review, feedback, approval: the work lands on main and the clone is free again', async () => {
    const c = manual();
    await workers.start(c.id);
    const clone = board.row(c.id).workspace!;
    writeFileSync(join(clone, 'export.ts'), 'export {}\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '--quiet', '-m', 'Export');
    await runtime.last.call('ready_for_review', { summary: 'Export gebaut.', demo: artifact() });
    runtime.last.emit({ type: 'idle' });
    expect(state(c.id)).toBe('waiting:demo');
    expect(board.item(c.id)!.summary).toBe('Export gebaut.');

    // feedback: the work still waits for approval while the worker takes it in, and is at work meanwhile
    workers.message(c.id, 'Bitte mit Kopfzeile.');
    expect(state(c.id)).toBe('waiting:demo');
    expect(board.item(c.id)!.answering).toBe(true);
    expect(needsYou(board.item(c.id)!)).toBe(false);
    expect(runtime.last.inbox.at(-1)).toContain('The owner wrote on your handover');
    expect(runtime.last.inbox.at(-1)).toContain('still waits for their approval');
    expect(runtime.last.inbox.at(-1)).toContain('Bitte mit Kopfzeile.');

    await runtime.last.call('ready_for_review', { summary: 'Mit Kopfzeile.', demo: artifact() });
    expect(board.item(c.id)!.answering).toBeUndefined();
    runtime.last.emit({ type: 'idle' });
    await workers.approve(c.id);
    expect(state(c.id)).toBe('live');
    expect(git(main, 'log', '--format=%s', '-1')).toBe('Export');
    // the worker hears that its work is on main; its session ends with that turn
    expect(runtime.last.inbox.at(-1)).toContain('is on main now');
    expect(runtime.last.closed).toBe(false);
    runtime.last.emit({ type: 'idle' });
    expect(runtime.last.closed).toBe(true);
    const d = manual();
    await workers.start(d.id);
    expect(board.row(d.id).workspace).toBe(clone);
  });

  test("a handover after feedback says what changed; the card's report keeps the first one with the replies and handovers after it", async () => {
    const c = manual();
    await workers.start(c.id);
    const clone = board.row(c.id).workspace!;
    writeFileSync(join(clone, 'export.ts'), 'export {}\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '--quiet', '-m', 'Export');
    expect(runtime.last.spec.tools.find((x) => x.name === 'ready_for_review')!.description).toContain('on a later one, only what your last handover and your replies since have not said yet');
    await runtime.last.call('ready_for_review', { summary: 'CSV-Export gebaut.', demo: artifact() });
    runtime.last.emit({ type: 'idle' });
    workers.message(c.id, 'Bitte mit Kopfzeile.');
    runtime.last.call('reply', { text: 'Mache ich: die Spaltennamen kommen in die erste Zeile.' });
    await runtime.last.call('ready_for_review', { summary: 'Kopfzeile ergänzt, im Commit.' });
    runtime.last.emit({ type: 'idle' });
    // the conversation shows the change alone
    expect(board.events(c.id).findLast((e) => e.kind === 'review')!.text).toBe('Kopfzeile ergänzt, im Commit.');
    const report = 'CSV-Export gebaut.\n\nDanach im Gespräch:\n\nMache ich: die Spaltennamen kommen in die erste Zeile.\n\nKopfzeile ergänzt, im Commit.';
    expect(board.summary(c.id)).toBe(report);
    expect(board.item(c.id)!.summary).toBe(report);

    // started afresh, the worker hands over in full again
    await workers.stop(c.id);
    await workers.start(c.id);
    await runtime.last.call('ready_for_review', { summary: 'CSV- und Excel-Export gebaut.', demo: artifact() });
    expect(board.summary(c.id)).toBe('CSV- und Excel-Export gebaut.');
  });

  test('the diff: the branch so far, committed or not, with new files; once landed, what the landing put on main', async () => {
    const c = manual();
    expect(await workers.diff(c.id, false)).toBeNull();
    await workers.start(c.id);
    expect(await workers.diff(c.id, false)).toEqual({ source: 'branch', files: [] });
    const clone = board.row(c.id).workspace!;
    writeFileSync(join(clone, 'export.ts'), 'export {}\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '--quiet', '-m', 'Export');
    writeFileSync(join(clone, 'README.md'), 'hello\nworld\n');
    writeFileSync(join(clone, 'notes über.txt'), 'eins\nzwei\n');
    // main moving on is not the card's change
    writeFileSync(join(main, 'other.ts'), 'x\n');
    git(main, 'add', '.');
    git(main, 'commit', '--quiet', '-m', 'Other');
    git(clone, 'fetch', '--quiet', 'origin');
    expect((await workers.diff(c.id, false))!.files).toEqual([
      { file: 'README.md', status: 'modified', added: 1, removed: 0 },
      { file: 'export.ts', status: 'added', added: 1, removed: 0 },
      { file: 'notes über.txt', status: 'added', added: 2, removed: 0 },
    ]);
    const full = (await workers.diff(c.id, true))!;
    expect(full.patch).toContain('+world');
    expect(full.patch).toContain('+zwei');

    git(clone, 'add', '.');
    git(clone, 'commit', '--quiet', '-m', 'More');
    await runtime.last.call('ready_for_review', { summary: 'Export gebaut.', demo: artifact() });
    runtime.last.emit({ type: 'idle' });
    await workers.approve(c.id);
    expect(state(c.id)).toBe('live');
    // while the worker finishes and after: what landed, without what main had before
    const landed = (await workers.diff(c.id, false))!;
    expect(landed.source).toBe('landed');
    expect(landed.files.map((f) => f.file)).toEqual(['README.md', 'export.ts', 'notes über.txt']);
    runtime.last.emit({ type: 'idle' });
    expect(board.row(c.id).workspace).toBeNull();
    expect((await workers.diff(c.id, false))!.files).toHaveLength(3);
  });

  test('approval with uncommitted work sends the worker back', async () => {
    const c = manual();
    await workers.start(c.id);
    writeFileSync(join(board.row(c.id).workspace!, 'loose.ts'), '');
    await runtime.last.call('ready_for_review', { summary: 'Fertig.', demo: artifact() });
    await workers.approve(c.id);
    expect(state(c.id)).toBe('working');
    expect(runtime.last.inbox.at(-1)).toContain('uncommitted changes');
  });

  test('stop releases the clone and plans the card again', async () => {
    const c = manual();
    await workers.start(c.id);
    await workers.stop(c.id);
    expect(state(c.id)).toBe('planned');
    expect(runtime.last.closed).toBe(true);
    const d = manual();
    expect(() => workers.start(d.id)).not.toThrow();
  });

  test('stopping keeps committed work: the clone stays with the card, starting again goes on on the same branch', async () => {
    const c = manual();
    await workers.start(c.id);
    const { workspace, branch } = board.row(c.id);
    writeFileSync(join(workspace!, 'work.ts'), 'x');
    git(workspace!, 'add', '.');
    git(workspace!, 'commit', '--quiet', '-m', 'Work');
    await workers.stop(c.id);
    expect(board.row(c.id).workspace).toBe(workspace);
    board.patch(c.id, { title: 'Neuer Titel' });
    await workers.start(c.id);
    expect(board.row(c.id)).toMatchObject({ workspace, branch });
    expect(git(workspace!, 'log', '--format=%s', '-1')).toBe('Work');
    expect(runtime.last.inbox[0]).toContain('already holds earlier work');
  });

  test("a stopped session's tool call changes nothing", async () => {
    const w = board.snapshot().items.find((i) => i.label === 'W1')!;
    await workers.start(w.id);
    const old = runtime.last;
    await workers.stop(w.id);
    expect(state(w.id)).toBe('planned');
    expect(old.call('ask', { question: 'Q?' })).toContain('session has ended');
    expect(old.call('report', { status: 'noch da' })).toContain('session has ended');
    expect(board.item(w.id)!.statusLine).not.toBe('noch da');
    expect(board.item(w.id)!.question).toBeUndefined();
  });

  test('after a restart, a worker that never reported a session starts again with its card', async () => {
    const c = manual();
    await workers.start(c.id);
    workers.shutdown();
    const n = runtime.sessions.length;
    workers.resumeAll();
    expect(runtime.sessions.length).toBe(n + 1);
    expect(runtime.last.spec.resume).toBeUndefined();
    expect(runtime.last.inbox[0]).toContain('Zählerstände exportieren');
  });

  test('after a restart that cut off a landing, the card waits for the owner to approve again', async () => {
    const c = manual();
    await workers.start(c.id);
    await runtime.last.call('ready_for_review', { summary: 'S', demo: artifact() });
    board.work(c.id, { approved_at: new Date().toISOString() });
    expect(needsYou(board.item(c.id)!)).toBe(false);
    workers.shutdown();
    workers.resumeAll();
    expect(state(c.id)).toBe('waiting:demo');
    expect(needsYou(board.item(c.id)!)).toBe(true);
  });

  test('a proposal lands below its source card', async () => {
    const c = manual();
    await workers.start(c.id);
    runtime.last.call('propose_card', {
      title: 'Falsches Label',
      task: 'Der Knopf „Export“ heißt in src/ui/strings.ts noch „Exportieren“.',
      reason: 'Gesehen beim Testen.',
      questions: [{ question: 'Welches Wort?', options: ['Export', 'Exportieren'] }],
    });
    const p = board.snapshot().items.find((i) => i.state === 'proposal')!;
    // the text is for the agent that takes the card on; why stays with the proposal, for the owner
    expect(p).toMatchObject({
      title: 'Falsches Label',
      from: c.id,
      body: 'Der Knopf „Export“ heißt in src/ui/strings.ts noch „Exportieren“.',
      proposal: { reason: 'Gesehen beim Testen.', questions: [{ text: 'Welches Wort?', options: ['Export', 'Exportieren'] }] },
    });
    expect(p.y).toBeGreaterThan(c.y);
    board.accept(p.id);
    expect(state(p.id)).toBe('planned');
    expect(board.item(p.id)!.proposal).toBeUndefined();
    // its conversation names the proposal as where the task comes from
    expect(board.item(p.id)!.proposed).toBe(true);
    expect(board.item(p.id)!.body).toBe('Der Knopf „Export“ heißt in src/ui/strings.ts noch „Exportieren“.\n\nOffene Fragen:\n- Welches Wort? (Export / Exportieren)');
  });

  test('on a canvas with several repositories, a proposal goes to the one its agent names, else to its card’s', async () => {
    const c = manual();
    await workers.start(c.id);
    // with one repository there is nothing to choose
    expect(runtime.last.spec.tools.find((t) => t.name === 'propose_card')!.description).not.toContain('repo:');
    await workers.stop(c.id);
    board.canvas.repos.push({ id: 'site', name: 'Site', path: '/r/site', branch: 'main' });
    await workers.start(c.id);
    expect(runtime.last.spec.tools.find((t) => t.name === 'propose_card')!.description).toContain(`by its id: home (${main}, yours), site (/r/site); yours when left out.`);
    runtime.last.call('propose_card', { title: 'Hier', task: 'T', reason: 'R' });
    expect(runtime.last.call('propose_card', { title: 'Dort', task: 'T', reason: 'R', repo: 'site' })).toContain('Proposed');
    // the repository's name does as well as its id
    runtime.last.call('propose_card', { title: 'Auch dort', task: 'T', reason: 'R', repo: 'SITE' });
    const repoOf = (title: string) => board.snapshot().items.find((i) => i.title === title)!.repo;
    expect([repoOf('Hier'), repoOf('Dort'), repoOf('Auch dort')]).toEqual(['home', 'site', 'site']);
    expect(runtime.last.call('propose_card', { title: 'Nirgends', task: 'T', reason: 'R', repo: 'shop' })).toBe('Not proposed: Obeya has no repository shop; give one of home, site.');
    expect(board.snapshot().items.some((i) => i.title === 'Nirgends')).toBe(false);
  });

  test('a proposal goes to a repository of another canvas, waits for the owner there, and its agent can take it back', async () => {
    const tools = new Board(store, { id: 'tools', name: 'Tools', repos: [{ id: 'tool', name: 'Tool', path: '/r/tool', branch: 'main' }, { id: 'docs', name: 'Docs', path: '/r/docs', branch: 'main' }] }, () => ({ docs: [], dirs: [] }));
    const shop = new Board(store, { id: 'shop', name: 'Shop', repos: [{ id: 'docs', name: 'Docs', path: '/r/shop-docs', branch: 'main' }] }, () => ({ docs: [], dirs: [] }));
    setWorkers(new Workers({ board, runtime, workspaces: spaces, adapter: { ...generic, land: 'main', workspaces: 'clones' }, otherBoards: () => [board, tools, shop] }));
    const c = manual();
    await workers.start(c.id);
    // with one repository of its own the worker sees those of the other canvases, by canvas
    expect(runtime.last.spec.tools.find((t) => t.name === 'propose_card')!.description).toContain(
      `by its id: home (${main}, yours); on other canvases, where the proposal then waits for the owner: on „Tools“ tool (/r/tool), docs (/r/docs); on „Shop“ docs (/r/shop-docs); yours when left out.`,
    );
    expect(runtime.last.call('propose_card', { title: 'Ursache im Tool', task: 'T', reason: 'Die Ursache liegt im Tool.', repo: 'tool' })).toContain('Proposed');
    const p = tools.snapshot().items.find((i) => i.title === 'Ursache im Tool')!;
    expect(p).toMatchObject({ state: 'proposal', repo: 'tool', from: c.id, fromElsewhere: { canvas: 'c', canvasName: 'C', title: 'Zählerstände exportieren' } });
    expect(board.snapshot().items.some((i) => i.title === 'Ursache im Tool')).toBe(false);
    expect(board.events(c.id).at(-1)!.text).toBe('Aufgabe vorgeschlagen auf der Leinwand „Tools“: Ursache im Tool');
    // an id two other canvases have takes the path
    expect(runtime.last.call('propose_card', { title: 'Doku', task: 'T', reason: 'R', repo: 'docs' })).toBe('Not proposed: several canvases have a repository docs; give its path instead: /r/docs, /r/shop-docs.');
    runtime.last.call('propose_card', { title: 'Doku', task: 'T', reason: 'R', repo: '/r/shop-docs/' });
    expect(shop.snapshot().items.find((i) => i.title === 'Doku')!.repo).toBe('docs');
    // taken back there as here
    expect(runtime.last.call('withdraw_proposal', { title: 'Ursache im Tool', why: 'Doch hier.' })).toContain('gone from the canvas');
    expect(tools.item(p.id)).toBeUndefined();
    // the worker that takes on a card from another canvas hears where it comes from
    await workers.stop(c.id);
    board.work(c.id, { state: 'live', detail: JSON.stringify({ summary: 'Export gebaut.' }) });
    const q = shop.snapshot().items.find((i) => i.title === 'Doku')!;
    const there = new Workers({ board: shop, runtime, workspaces: spaces, adapter: { ...generic, land: 'main', workspaces: 'clones' }, otherBoards: () => [board, tools, shop] });
    shop.accept(q.id);
    await there.start(q.id);
    expect(runtime.last.inbox[0]).toContain('This card follows up on the card “Zählerstände exportieren” on the canvas “C”. Its worker handed it over with this summary:\n\nExport gebaut.');
    await there.stop(q.id);
  });

  test('a worker withdraws its open proposal: it goes at once, and not as a dismissal of the owner’s', async () => {
    const c = manual();
    await workers.start(c.id);
    const since = new Date(Date.now() - 1000).toISOString();
    runtime.last.call('propose_card', { title: 'Lange Schnitte', task: 'T', reason: 'R' });
    const p = board.snapshot().items.find((i) => i.state === 'proposal')!;
    const out = runtime.last.call('withdraw_proposal', { title: '„lange  Schnitte“', why: 'Die Diagnose war falsch.' }) as string;
    expect(out).toContain('gone from the canvas');
    expect(board.item(p.id)).toBeUndefined();
    expect(board.events(c.id).some((e) => e.text === 'Zieht den Vorschlag „Lange Schnitte“ zurück: Die Diagnose war falsch.')).toBe(true);
    // the Rückschau reads deleted proposals as the owner's dismissals: this one was not
    expect(board.removed(since)).toEqual([]);
    expect(runtime.last.call('withdraw_proposal', { title: 'Lange Schnitte', why: 'W' })).toContain('withdrawn already');
    // of two alike, the newer replaces the older
    runtime.last.call('propose_card', { title: 'Gleich', task: 'Alt', reason: 'R' });
    runtime.last.call('propose_card', { title: 'Gleich', task: 'Neu', reason: 'R' });
    runtime.last.call('withdraw_proposal', { title: 'Gleich', why: 'W', replaced_by: 'Gleich' });
    expect(board.snapshot().items.filter((i) => i.title === 'Gleich').map((i) => i.body)).toEqual(['Neu']);
  });

  test('a new proposal that replaces an accepted one marks it, and the owner removes or keeps it', async () => {
    const c = manual();
    await workers.start(c.id);
    runtime.last.call('propose_card', { title: 'Lange Schnitte', task: 'T', reason: 'R' });
    const old = board.snapshot().items.find((i) => i.state === 'proposal')!;
    board.accept(old.id);
    expect(needsYou(board.item(old.id)!)).toBe(false);
    const out = runtime.last.call('propose_card', { title: 'Display schläft', task: 'T2', reason: 'R2', replaces: 'Lange Schnitte' }) as string;
    const replacement = board.snapshot().items.find((i) => i.state === 'proposal')!;
    expect(out).toContain('marks it as replaced');
    expect(board.item(old.id)!.superseded).toEqual({ by: replacement.id, title: 'Display schläft' });
    expect(needsYou(board.item(old.id)!)).toBe(true);
    expect(board.events(old.id).at(-1)!.text).toBe('Der vorschlagende Agent hat diese Karte ersetzt durch „Display schläft“.');
    board.keep(old.id);
    expect(board.item(old.id)!.superseded).toBeUndefined();
    expect(() => board.keep(old.id)).toThrow(BadRequest);
  });

  test('withdrawing a proposal names the worker’s proposals when the title matches none, and leaves finished ones', async () => {
    const c = manual();
    await workers.start(c.id);
    runtime.last.call('propose_card', { title: 'Lange Schnitte', task: 'T', reason: 'R' });
    const p = board.snapshot().items.find((i) => i.state === 'proposal')!;
    expect(runtime.last.call('withdraw_proposal', { title: 'Kurze Schnitte', why: 'W' })).toBe('No proposal of yours is called so; nothing was withdrawn. Yours: „Lange Schnitte“ (proposal).');
    expect(runtime.last.call('withdraw_proposal', { title: 'Lange Schnitte', why: 'W', replaced_by: 'Gibt es nicht' })).toContain('Nothing was withdrawn');
    expect(board.item(p.id)).toBeDefined();
    board.accept(p.id);
    board.work(p.id, { state: 'done' });
    expect(runtime.last.call('withdraw_proposal', { title: 'Lange Schnitte', why: 'W' })).toContain('done already');
    expect(board.item(p.id)!.superseded).toBeUndefined();
  });

  test('a delivery to a worker that never reported a session starts one with the card', async () => {
    const c = manual();
    await workers.start(c.id);
    runtime.last.call('ask', { question: 'Q?' });
    workers.shutdown();
    workers.answer(c.id, 'A');
    expect(runtime.last.spec.resume).toBeUndefined();
    expect(runtime.last.inbox[0]).toContain('Zählerstände exportieren');
    expect(runtime.last.inbox[0]).toContain('Answer to your question');
  });

  test('after a restart a working card resumes its session; a delivery to an ended session resumes it', async () => {
    const c = manual();
    await workers.start(c.id);
    runtime.last.emit({ type: 'session', id: 'sess-1' });
    workers.shutdown();
    workers.resumeAll();
    expect(runtime.last.spec.resume).toBe('sess-1');
    runtime.last.call('ask', { question: 'Q?' });
    workers.shutdown();
    workers.answer(c.id, 'A');
    expect(runtime.last.spec.resume).toBe('sess-1');
    expect(runtime.last.inbox[0]).toContain('A');
  });
});

describe('tool calls the settings refuse or want confirmed', () => {
  test('a refused tool call stands in the conversation with who refused it and why', async () => {
    const c = manual();
    await workers.start(c.id);
    runtime.last.emit({ type: 'tool', name: 'Bash', input: { command: 'rm -rf build' } });
    runtime.last.emit({ type: 'denied', name: 'Bash', input: { command: 'rm -rf build' }, by: 'classifier', reason: 'Löscht Dateien außerhalb der Aufgabe' });
    runtime.last.emit({ type: 'denied', name: 'Bash', input: { command: 'psql -c "delete from t"' }, by: 'rule' });
    const denied = board.events(c.id).filter((e) => e.kind === 'denied');
    expect(denied.map((e) => e.text)).toEqual([
      'Nicht erlaubt (Prüfmodell des Auto-Modus): $ rm -rf build — Löscht Dateien außerhalb der Aufgabe',
      'Nicht erlaubt (Regel in den Einstellungen): $ psql -c "delete from t"',
    ]);
    expect(denied.every((e) => e.author === 'worker')).toBe(true);
  });

  test('a tool call that needs confirmation becomes the question the card waits on, and runs once the owner allows it', async () => {
    const c = manual();
    await workers.start(c.id);
    const answer = runtime.last.permission('Bash', { command: 'bun scripts/remote-psql.ts -c "update meters set …"' }, 'Schreibzugriff');
    await flush();
    expect(state(c.id)).toBe('waiting:question');
    const q = board.item(c.id)!.question!;
    expect(q.options).toEqual(['Erlauben', 'Ablehnen']);
    expect(q.text).toContain('`bun scripts/remote-psql.ts -c "update meters set …"`');
    expect(q.text).toContain('Grund der Rückfrage: Schreibzugriff');
    expect(board.events(c.id).at(-1)!.kind).toBe('question');
    // the worker waits for the owner, as after a question: a restart need not wait for it
    expect(workers.busyCards()).toEqual([]);
    workers.answer(c.id, 'Erlauben');
    expect(await answer).toEqual({ allow: true });
    expect(state(c.id)).toBe('working');
    expect(workers.busyCards().length).toBeGreaterThan(0);
    // one call, not a decision of the project's
    expect(board.decisionsOn(c.id)).toEqual([]);
  });

  test("refused, the call's result carries the owner's words; allowed with words, the next message does", async () => {
    const c = manual();
    await workers.start(c.id);
    const first = runtime.last.permission('Bash', { command: 'git push --force' });
    await flush();
    workers.answer(c.id, 'Ablehnen\n\nKein Force-Push, mach einen neuen Commit.');
    expect(await first).toEqual({ allow: false, message: 'Not run: the owner did not allow it:\n\nKein Force-Push, mach einen neuen Commit.' });
    const second = runtime.last.permission('Bash', { command: 'git push' });
    await flush();
    const before = runtime.last.inbox.length;
    workers.answer(c.id, 'Allow\n\nAber nur diesmal.');
    expect(await second).toEqual({ allow: true });
    expect(runtime.last.inbox.slice(before)).toEqual(['The owner allowed it:\n\nAber nur diesmal.']);
  });

  test('words without a pick refuse the call, with the words', async () => {
    const c = manual();
    await workers.start(c.id);
    const answer = runtime.last.permission('Write', { file_path: '/repo/.env' });
    await flush();
    expect(board.item(c.id)!.question!.text).toContain('Schreibt repo/.env');
    workers.answer(c.id, 'Schreib das lieber in .env.example');
    expect(await answer).toEqual({ allow: false, message: 'Not run: the owner did not allow it:\n\nSchreib das lieber in .env.example' });
  });

  test('a note instead of an answer refuses the call, and the worker reads the note with it', async () => {
    const c = manual();
    await workers.start(c.id);
    const answer = runtime.last.permission('Bash', { command: 'bun run migrate' });
    await flush();
    workers.message(c.id, 'Erst nach dem Backup.');
    const got = await answer;
    expect(got.allow).toBe(false);
    expect(!got.allow && got.message).toContain('Erst nach dem Backup.');
    expect(state(c.id)).toBe('working');
  });

  test('two calls that need confirmation at once are asked one after the other', async () => {
    const c = manual();
    await workers.start(c.id);
    const a = runtime.last.permission('Bash', { command: 'one' });
    const b = runtime.last.permission('Bash', { command: 'two' });
    await flush();
    expect(board.item(c.id)!.question!.text).toContain('one');
    workers.answer(c.id, 'Erlauben');
    expect(await a).toEqual({ allow: true });
    await flush();
    expect(board.item(c.id)!.question!.text).toContain('two');
    workers.answer(c.id, 'Ablehnen');
    expect((await b).allow).toBe(false);
  });

  test('allowed after a restart, the worker hears it when it goes on, and the call runs without asking again', async () => {
    const c = manual();
    await workers.start(c.id);
    runtime.last.emit({ type: 'session', id: 's1' });
    void runtime.last.permission('Bash', { command: 'bun run migrate' });
    await flush();
    workers.shutdown();
    workers.resumeAll();
    expect(state(c.id)).toBe('waiting:question');
    const n = runtime.sessions.length;
    workers.answer(c.id, 'Erlauben');
    expect(runtime.sessions.length).toBe(n + 1);
    expect(runtime.last.spec.resume).toBe('s1');
    expect(runtime.last.inbox.at(-1)).toContain('The owner allowed it');
    expect(runtime.last.inbox.at(-1)).toContain('$ bun run migrate');
    expect(await runtime.last.permission('Bash', { command: 'bun run migrate' })).toEqual({ allow: true });
    expect(state(c.id)).toBe('working');
    // once: the same call later is asked again
    void runtime.last.permission('Bash', { command: 'bun run migrate' });
    await flush();
    expect(state(c.id)).toBe('waiting:question');
  });
});

describe('pausing: the owner halts a worker and lets it go on', () => {
  /** A card at work, its session known as `sess-1`. */
  const atWork = async () => {
    const c = manual();
    await workers.start(c.id);
    runtime.last.emit({ type: 'session', id: 'sess-1' });
    runtime.last.emit({ type: 'tool', name: 'Bash', input: { command: 'bun test' } });
    return c;
  };

  test('pausing ends the session at once and keeps card, workspace and session; resuming goes on in that session', async () => {
    const c = await atWork();
    const { workspace, branch } = board.row(c.id);
    const session = runtime.last;
    workers.pause(c.id);
    expect(session.closed).toBe(true);
    expect(workers.busyCards()).toEqual([]);
    expect(board.item(c.id)).toMatchObject({ state: 'working', paused: true });
    expect(board.row(c.id)).toMatchObject({ workspace, branch, session_id: 'sess-1' });
    expect(board.events(c.id).at(-1)).toMatchObject({ kind: 'state', author: 'owner', text: 'Pausiert.' });
    expect(() => workers.pause(c.id)).toThrow(BadRequest);

    const n = runtime.sessions.length;
    workers.resume(c.id);
    expect(runtime.sessions.length).toBe(n + 1);
    expect(runtime.last.spec.resume).toBe('sess-1');
    expect(runtime.last.inbox[0]).toContain('The owner paused you and has now let you go on');
    expect(runtime.last.inbox[0]).toContain('exit code 137');
    expect(board.item(c.id)!.paused).toBeUndefined();
    expect(board.events(c.id).at(-1)).toMatchObject({ kind: 'state', author: 'owner', text: 'Weiter.' });
    expect(workers.busyCards().length).toBeGreaterThan(0);
    expect(() => workers.resume(c.id)).toThrow(BadRequest);
  });

  test("a note to a paused worker lets it go on with the note", async () => {
    const c = await atWork();
    workers.pause(c.id);
    workers.message(c.id, 'Nimm lieber CSV.');
    expect(runtime.last.spec.resume).toBe('sess-1');
    expect(runtime.last.inbox[0]).toContain('The owner paused you and has now let you go on');
    expect(runtime.last.inbox[0]).toContain('A note from the owner (with which they let you go on):\n\nNimm lieber CSV.');
    expect(board.item(c.id)!.paused).toBeUndefined();
  });

  test("what Obeya has for a paused worker waits until it goes on, and so does a message it had not taken in", async () => {
    const c = await atWork();
    workers.message(c.id, 'Und Excel?');
    workers.pause(c.id);
    const n = runtime.sessions.length;
    workers.prEvent(c.id, 'Check rot.', 'A check of your pull request failed: test.');
    expect(runtime.sessions.length).toBe(n);
    expect(board.item(c.id)!.paused).toBe(true);
    workers.resume(c.id);
    const first = runtime.last.inbox[0]!;
    expect(first).toContain('While you were paused, Obeya had this for you');
    expect(first).toContain('Und Excel?');
    expect(first).toContain('A check of your pull request failed: test.');
  });

  test('a paused worker stays paused across a restart of Obeya', async () => {
    const c = await atWork();
    workers.pause(c.id);
    workers.shutdown();
    const n = runtime.sessions.length;
    workers.resumeAll();
    expect(runtime.sessions.length).toBe(n);
    expect(board.item(c.id)!.paused).toBe(true);
    workers.resume(c.id);
    expect(runtime.last.spec.resume).toBe('sess-1');
  });

  test('stopping a paused worker plans the card again, and a new start is not paused', async () => {
    const c = await atWork();
    workers.pause(c.id);
    await workers.stop(c.id);
    expect(state(c.id)).toBe('planned');
    expect(board.item(c.id)!.paused).toBeUndefined();
    await workers.start(c.id);
    expect(board.item(c.id)!.paused).toBeUndefined();
    expect(workers.busyCards().length).toBeGreaterThan(0);
  });

  test('only a worker in a turn can be paused: one that asked and ended its turn has nothing running', async () => {
    const c = manual();
    expect(() => workers.pause(c.id)).toThrow(BadRequest);
    await workers.start(c.id);
    expect(board.item(c.id)!.inTurn).toBe(true);
    runtime.last.call('ask', { question: 'CSV oder Excel?' });
    runtime.last.emit({ type: 'idle' });
    expect(board.item(c.id)!.inTurn).toBeUndefined();
    expect(() => workers.pause(c.id)).toThrow(BadRequest);
  });

  test('a card in its pull request offers a pause only while its worker is in a turn', async () => {
    const c = await atWork();
    board.work(c.id, { state: 'inPr', pr: JSON.stringify({ url: 'https://github.com/acme/app/pull/7', number: 7, seen: [], reported: [] }) });
    runtime.last.emit({ type: 'idle' });
    // the pull request waits for review: nothing runs, nothing to pause
    expect(board.item(c.id)).toMatchObject({ state: 'inPr' });
    expect(board.item(c.id)!.inTurn).toBeUndefined();
    expect(() => workers.pause(c.id)).toThrow(BadRequest);
    // a review comment starts its next turn, which can be paused
    workers.prEvent(c.id, 'Kommentar.', 'A review comment on your pull request: use CSV.');
    expect(board.item(c.id)!.inTurn).toBe(true);
    workers.pause(c.id);
    expect(board.item(c.id)).toMatchObject({ state: 'inPr', paused: true });
    expect(board.item(c.id)!.inTurn).toBeUndefined();
    workers.resume(c.id);
    expect(runtime.last.inbox[0]).toContain('The owner paused you and has now let you go on');
    expect(board.item(c.id)!.inTurn).toBe(true);
  });

  test("a worker taking in the owner's words on its handover can be paused: the card still waits for approval, and it finishes taking them in once it goes on", async () => {
    const c = await atWork();
    const clone = board.row(c.id).workspace!;
    writeFileSync(join(clone, 'export.ts'), 'export {}\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '--quiet', '-m', 'Export');
    await runtime.last.call('ready_for_review', { summary: 'Export gebaut.', demo: artifact() });
    runtime.last.emit({ type: 'idle' });
    expect(() => workers.pause(c.id)).toThrow(BadRequest);
    workers.message(c.id, 'Bitte mit Kopfzeile.');
    expect(board.item(c.id)).toMatchObject({ state: 'waiting', need: 'demo', answering: true, inTurn: true });
    const session = runtime.last;
    workers.pause(c.id);
    expect(session.closed).toBe(true);
    expect(board.item(c.id)).toMatchObject({ state: 'waiting', need: 'demo', answering: true, paused: true, summary: 'Export gebaut.' });
    expect(board.item(c.id)!.inTurn).toBeUndefined();

    workers.resume(c.id);
    expect(runtime.last.spec.resume).toBe('sess-1');
    expect(runtime.last.inbox[0]).toContain('The owner paused you and has now let you go on');
    // the words it had not taken in yet go along
    expect(runtime.last.inbox[0]).toContain('Bitte mit Kopfzeile.');
    expect(board.item(c.id)).toMatchObject({ state: 'waiting', answering: true, inTurn: true });
    expect(board.item(c.id)!.paused).toBeUndefined();
    await runtime.last.call('ready_for_review', { summary: 'Mit Kopfzeile.', demo: artifact() });
    runtime.last.emit({ type: 'idle' });
    expect(board.item(c.id)).toMatchObject({ state: 'waiting', need: 'demo' });
    expect(board.item(c.id)!.summary).toEndWith('Mit Kopfzeile.');
    expect(board.item(c.id)!.answering).toBeUndefined();
  });

  test('a note to a worker paused on its handover lets it go on with the note', async () => {
    const c = await atWork();
    const clone = board.row(c.id).workspace!;
    writeFileSync(join(clone, 'export.ts'), 'export {}\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '--quiet', '-m', 'Export');
    await runtime.last.call('ready_for_review', { summary: 'Export gebaut.', demo: artifact() });
    runtime.last.emit({ type: 'idle' });
    workers.message(c.id, 'Bitte mit Kopfzeile.');
    workers.pause(c.id);
    workers.message(c.id, 'Und Fußzeile.');
    expect(runtime.last.inbox[0]).toContain('The owner paused you and has now let you go on');
    expect(runtime.last.inbox[0]).toContain('Und Fußzeile.');
    expect(board.item(c.id)).toMatchObject({ state: 'waiting', answering: true, inTurn: true });
    expect(board.item(c.id)!.paused).toBeUndefined();
  });

  test('pausing at a safe point tells the worker, which ends its turn once its step is done, and is paused then', async () => {
    const c = await atWork();
    const session = runtime.last;
    workers.pauseAtSafePoint(c.id);
    expect(session.closed).toBe(false);
    expect(session.inbox.at(-1)).toContain('The owner pauses you now');
    expect(session.inbox.at(-1)).toContain('after at most 15 minutes');
    expect(board.item(c.id)).toMatchObject({ state: 'working', pausing: true, inTurn: true });
    expect(board.item(c.id)!.paused).toBeUndefined();
    expect(pausable(board.item(c.id)!)).toBe(false);
    expect(board.events(c.id).at(-1)).toMatchObject({ kind: 'state', author: 'owner', text: 'Hält an, sobald die Arbeit an einem sicheren Punkt ist.' });
    expect(() => workers.pauseAtSafePoint(c.id)).toThrow('paused already');
    session.emit({ type: 'text', text: 'Tests grün, ich halte an.' });
    session.emit({ type: 'idle' });
    // no nudge and no question to the owner: it paused
    expect(session.closed).toBe(true);
    expect(board.item(c.id)).toMatchObject({ state: 'working', paused: true });
    expect(board.item(c.id)!.pausing).toBeUndefined();
    expect(board.item(c.id)!.question).toBeUndefined();
    expect(board.events(c.id).at(-1)).toMatchObject({ kind: 'state', author: 'owner', text: 'Pausiert.' });
    workers.resume(c.id);
    expect(runtime.last.spec.resume).toBe('sess-1');
    expect(board.item(c.id)!.paused).toBeUndefined();
  });

  test('a worker about to pause can still be paused at once', async () => {
    const c = await atWork();
    const session = runtime.last;
    workers.pauseAtSafePoint(c.id);
    workers.pause(c.id);
    expect(session.closed).toBe(true);
    expect(board.item(c.id)).toMatchObject({ paused: true });
    expect(board.item(c.id)!.pausing).toBeUndefined();
  });

  test('a worker about to pause with its render still running hears, when the render wakes it, that the owner still waits', async () => {
    const c = await atWork();
    const session = runtime.last;
    workers.pauseAtSafePoint(c.id);
    expect(session.toolStep()).toBeUndefined();
    session.emit({ type: 'idle', background: 1 });
    expect(board.item(c.id)).toMatchObject({ pausing: true });
    expect(session.closed).toBe(false);
    session.emit({ type: 'tool', name: 'Bash', input: { command: 'tail -2 render.log' } });
    expect(session.toolStep()).toContain('The owner still waits for you to pause');
    expect(session.toolStep()).toBeUndefined();
    session.emit({ type: 'idle' });
    expect(session.closed).toBe(true);
    expect(board.item(c.id)).toMatchObject({ paused: true });
  });

  test("resuming a worker about to pause, or the owner's words to it, let it work on", async () => {
    const c = await atWork();
    const session = runtime.last;
    workers.pauseAtSafePoint(c.id);
    workers.resume(c.id);
    expect(session.inbox.at(-1)).toBe('The owner no longer wants you to pause: go on with your work.');
    expect(board.item(c.id)!.pausing).toBeUndefined();
    expect(board.events(c.id).at(-1)).toMatchObject({ kind: 'state', author: 'owner', text: 'Weiter.' });
    workers.pauseAtSafePoint(c.id);
    // between its steps, so the words go in at once
    session.emit({ type: 'idle', background: 1 });
    workers.message(c.id, 'Nimm lieber CSV.');
    expect(session.inbox.at(-1)).toContain('The owner no longer wants you to pause');
    expect(session.inbox.at(-1)).toContain('Nimm lieber CSV.');
    expect(board.item(c.id)!.pausing).toBeUndefined();
    session.emit({ type: 'idle' });
    expect(board.item(c.id)!.paused).toBeUndefined();
  });

  test('a worker that does not come to a safe point in time is paused at once', async () => {
    setWorkers(new Workers({ board, runtime, workspaces: spaces, adapter: generic, pauseLimit: 20 }));
    const c = await atWork();
    const session = runtime.last;
    workers.pauseAtSafePoint(c.id);
    expect(session.inbox.at(-1)).toContain('after at most 1 minute.');
    await new Promise((r) => setTimeout(r, 40));
    expect(session.closed).toBe(true);
    expect(board.item(c.id)).toMatchObject({ paused: true });
  });

  test('a worker about to pause that hands over is paused on its handover, the card waiting for approval', async () => {
    const c = await atWork();
    const clone = board.row(c.id).workspace!;
    writeFileSync(join(clone, 'export.ts'), 'export {}\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '--quiet', '-m', 'Export');
    workers.pauseAtSafePoint(c.id);
    await runtime.last.call('ready_for_review', { summary: 'Export gebaut.', demo: artifact() });
    runtime.last.emit({ type: 'idle' });
    expect(board.item(c.id)).toMatchObject({ state: 'waiting', need: 'demo', paused: true });
  });

  test('a worker about to pause cannot snooze itself instead', async () => {
    const c = await atWork();
    workers.pauseAtSafePoint(c.id);
    const answer = await runtime.last.call('snooze', { until: new Date(Date.now() + 3_600_000).toISOString(), why: 'check the build' });
    expect(answer).toContain('Not snoozed: the owner pauses you');
    runtime.last.emit({ type: 'idle' });
    expect(board.item(c.id)).toMatchObject({ paused: true });
    expect(board.item(c.id)!.snoozed).toBeUndefined();
  });

  test('a worker about to pause when Obeya restarts stays paused after it', async () => {
    const c = await atWork();
    workers.pauseAtSafePoint(c.id);
    workers.shutdown();
    const n = runtime.sessions.length;
    workers.resumeAll();
    expect(runtime.sessions.length).toBe(n);
    expect(board.item(c.id)).toMatchObject({ paused: true });
    expect(board.item(c.id)!.pausing).toBeUndefined();
    workers.resume(c.id);
    expect(runtime.last.spec.resume).toBe('sess-1');
  });
});
