// A walkthrough as its agent hands it over slide by slide: what Obeya shows of each slide, what it
// refuses back to the agent, and the order the one voice speaks the sentences of all walkthroughs in.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Walkthrough } from '../core/walkthrough';
import { fakeVoicing, removeDir, silentWav, until } from './testing';
import { AnswerWalkthrough, readWalkthrough, Voicing, writtenIn } from './walkthrough';
import { estimatedStarts } from '../core/walkthrough';

let dir: string;
let repo: string;
let voice: ReturnType<typeof fakeVoicing>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'obeya-walkthrough-'));
  repo = join(dir, 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'land.ts'), Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
  writeFileSync(join(dir, 'secret.txt'), 'not of the repository\n');
  mkdirSync(join(dir, 'answers'));
  voice = fakeVoicing();
});
afterEach(() => removeDir(dir));

const told = (shown: string[][] = []) =>
  new AnswerWalkthrough({ dir: join(dir, 'answers'), checkout: repo, voicing: voice.voicing, onShown: (files) => shown.push(files.map((f) => f.name)) });
const hand = (w: AnswerWalkthrough, slide: unknown) => w.tool().run({ slide }) as string;
const read = (name: string): Walkthrough => JSON.parse(readFileSync(join(dir, 'answers', name), 'utf8'));
const TITLE = { type: 'title', title: 'How a card lands', subtitle: 'From approval to main', language: 'en', narration: 'Approving a card starts the landing. It takes three steps.' };

describe('a walkthrough handed over slide by slide', () => {
  test('shows from its title slide on, which says its title first, and comes with the answer once the turn is over', async () => {
    const shown: string[][] = [];
    const w = told(shown);
    expect(hand(w, TITLE)).toBe('Slide 1 is shown and being voiced. Hand over the next slide, or, once the walkthrough is complete, call answer_owner with a sentence or two on what it shows: the walkthrough is the answer.');
    expect(shown).toEqual([['how-a-card-lands.walkthrough.json']]);
    expect(w.files()).toEqual([{ name: 'how-a-card-lands.walkthrough.json', caption: 'How a card lands' }]);
    let file = read('how-a-card-lands.walkthrough.json');
    expect(file.slides[0]!.parts).toEqual(['How a card lands.', 'Approving a card starts the landing.', 'It takes three steps.']);
    expect(file.done).toBe(false);
    hand(w, { type: 'points', title: 'Three steps', points: ['Rebase', 'Checks', 'Merge'], narration: ['First it rebases.', 'Then the checks run. They must pass.', 'Then it merges.'] });
    await until(() => read('how-a-card-lands.walkthrough.json').clips.flat().every(Boolean));
    file = read('how-a-card-lands.walkthrough.json');
    // a sentence each, each with the item it shows with
    expect(file.slides[1]!.parts).toEqual(['First it rebases.', 'Then the checks run.', 'They must pass.', 'Then it merges.']);
    expect(file.slides[1]!.items).toEqual([0, 1, 1, 2]);
    expect(file.clips[1]!.map((c) => c && { file: c.file, seconds: c.seconds })).toEqual([1, 2, 3, 4].map((n) => ({ file: `2-${n}.wav`, seconds: 1 })));
    expect(existsSync(join(dir, 'answers', file.clipsDir, '2-4.wav'))).toBe(true);
    expect(voice.said).toEqual(['How a card lands.', 'Approving a card starts the landing.', 'It takes three steps.', 'First it rebases.', 'Then the checks run.', 'They must pass.', 'Then it merges.'].map((s) => `en:${s}`));
    // the first slide shows once only
    expect(shown).toHaveLength(1);
    w.finish();
    expect(read('how-a-card-lands.walkthrough.json').done).toBe(true);
  });

  test('a code slide shows the lines as the repository has them; a file outside it, lines it lacks or too many are refused', () => {
    const w = told();
    hand(w, TITLE);
    const code = { type: 'code', title: 'The merge', file: 'src/land.ts', lines: [3, 6], focus: [[4, 5]], narration: 'Here it merges.' };
    expect(hand(w, code)).toStartWith('Slide 2 is shown');
    expect(read('how-a-card-lands.walkthrough.json').slides[1]).toMatchObject({ type: 'code', code: ['line 3', 'line 4', 'line 5', 'line 6'], focus: [[4, 5]] });
    expect(hand(w, { ...code, file: '../secret.txt' })).toBe('Not shown: ../secret.txt is no file of the repository.');
    expect(hand(w, { ...code, file: join(dir, 'secret.txt') })).toBe(`Not shown: ${join(dir, 'secret.txt')} is no file of the repository.`);
    expect(hand(w, { ...code, lines: [38, 41] })).toBe('Not shown: src/land.ts has lines 1 to 40; lines 38 to 41 are not among them.');
    expect(hand(w, { ...code, lines: [1, 31], focus: [] })).toBe('Not shown: a code slide shows at most 30 lines, not 31.');
    expect(hand(w, { ...code, focus: [[2, 4]] })).toBe('Not shown: the focus 2–4 is not within lines 3–6.');
    expect(read('how-a-card-lands.walkthrough.json').slides).toHaveLength(2);
  });

  test('what is wrong with a slide goes back to the agent, and the slide is not shown', () => {
    const w = told();
    expect(hand(w, { type: 'points', title: 'x', points: ['a'], narration: 'a.' })).toBe('Not shown: a walkthrough begins with its title slide.');
    expect(w.files()).toEqual([]);
    hand(w, TITLE);
    expect(hand(w, TITLE)).toBe('Not shown: an answer has one walkthrough, and it has its title slide already.');
    expect(hand(w, { type: 'points', title: 'x', points: ['a', 'b'], narration: ['a.', 'b.', 'c.'] })).toBe('Not shown: its narration has 3 parts for 2 points: give one part per item, or one text.');
    expect(hand(w, { type: 'points', title: 'x', points: ['a'], narration: ' ' })).toBe('Not shown: its narration is missing.');
    expect(hand(w, { type: 'flow', title: 'x', steps: ['a', 'b'], narration: 'a.' })).toStartWith('Not shown: steps: ');
    for (let n = 2; n <= 8; n++) expect(hand(w, { type: 'points', title: `${n}`, points: ['a'], narration: 'a.' })).toStartWith(`Slide ${n} is shown`);
    expect(hand(w, { type: 'points', title: '9', points: ['a'], narration: 'a.' })).toBe('Not shown: a walkthrough has at most 8 slides. Call answer_owner now.');
  });

  test('a slide too full for the player, or whose narration only reads it out, goes back to the agent with what to change', () => {
    const w = told();
    hand(w, TITLE);
    const long = 'The approved card is rebased onto main and its checks run before the merge lands';
    expect(hand(w, { type: 'points', title: 'Three steps', points: [long, long, long, long, 'Then it lands'], narration: 'Each step waits for the one before it, so a failing check stops the landing.' })).toBe(
      'Not shown: the slide is too full: it runs about 3 lines past its bottom. Shorten its points (the narration can say the rest), or spread them over two slides.',
    );
    const steps = ['Freigabe', 'Zusammenführung', 'Prüfung', 'Fertig'];
    expect(hand(w, { type: 'flow', title: 'Der Weg', steps, narration: 'Nichts davon braucht dich, bis die Karte auf main ist.' })).toBe(
      'Not shown: "Zusammenführung" in step 2 is wider than its box: a flow of 4 steps gives each box room for about 11 characters: use shorter words or fewer steps, and let the narration say the rest.',
    );
    const points = ['Rebase onto main', 'The checks run', 'Merge into main'];
    expect(hand(w, { type: 'points', title: 'Three steps', points, narration: ['First, it rebases onto main.', 'Next, the checks run.', 'Finally it merges into main.'] })).toBe(
      'Not shown: its narration only reads the slide out (7 of its 10 words are on the slide). The owner sees the slide already: say what it does not show (why it is so, what follows from it, an example).',
    );
    expect(read('how-a-card-lands.walkthrough.json').slides).toHaveLength(1);
    // revised: the same points, told with what the slide does not show
    expect(hand(w, { type: 'points', title: 'Three steps', points, narration: ["Obeya replays the card's commits on the newest main, so nothing that landed meanwhile is lost.", "The repository's own tests and types decide.", 'Only then does main move forward.'] })).toStartWith('Slide 2 is shown');
  });

  test("a file or a clips directory of that name the agent put there (a link elsewhere, say) is passed by", () => {
    symlinkSync(dir, join(dir, 'answers', 'how-a-card-lands.clips'));
    const w = told();
    hand(w, TITLE);
    expect(w.files()).toEqual([{ name: 'how-a-card-lands-2.walkthrough.json', caption: 'How a card lands' }]);
  });

  test('a code slide is not read from a file too large for one, and its long lines are cut', () => {
    writeFileSync(join(repo, 'big.txt'), 'x'.repeat(2_100_000));
    writeFileSync(join(repo, 'wide.txt'), `${'y'.repeat(1000)}\n`);
    const w = told();
    hand(w, TITLE);
    expect(hand(w, { type: 'code', title: 'Big', file: 'big.txt', lines: [1, 1], narration: 'Big.' })).toBe('Not shown: big.txt is too large for a code slide.');
    hand(w, { type: 'code', title: 'Wide', file: 'wide.txt', lines: [1, 1], narration: 'One line, cut where it gets too long.' });
    expect(read('how-a-card-lands.walkthrough.json').slides[1]).toMatchObject({ type: 'code' });
    expect((read('how-a-card-lands.walkthrough.json').slides[1] as { code: string[] }).code[0]!.length).toBeLessThanOrEqual(400);
  });

  test('a later answer gets a file of its own, the earlier one keeps its', () => {
    hand(told(), TITLE);
    const again = told();
    hand(again, TITLE);
    expect(again.files()).toEqual([{ name: 'how-a-card-lands-2.walkthrough.json', caption: 'How a card lands' }]);
    expect(read('how-a-card-lands.walkthrough.json').slides).toHaveLength(1);
  });

  test('is voiced in the language its title slide names, and German narration splits as German captions do', async () => {
    const w = told();
    hand(w, { type: 'title', title: 'Wie eine Karte landet', language: 'de', narration: 'Am 1. November kam das. Es geht so.' });
    hand(w, { type: 'points', title: 'Drei Schritte', points: ['Rebase'], narration: 'Erst rebasen.' });
    expect(read('wie-eine-karte-landet.walkthrough.json').slides[0]!.parts).toEqual(['Wie eine Karte landet.', 'Am 1. November kam das.', 'Es geht so.']);
    await until(() => voice.said.length === 4);
    expect(voice.said).toEqual(['Wie eine Karte landet.', 'Am 1. November kam das.', 'Es geht so.', 'Erst rebasen.'].map((x) => `de:${x}`));
  });

  test('a title slide without the language of its narration is refused', () => {
    const { language: _, ...bare } = TITLE;
    expect(hand(told(), bare)).toStartWith('Not shown: language: ');
  });

  test('the language of an answer it is to tell shows in its common words', () => {
    expect(writtenIn('Eine Präferenz wirkt nur, während ein Agent ohnehin arbeitet. Review-Karten entstehen nur auf dein Wort hin.')).toBe('de');
    expect(writtenIn('A preference only applies while an agent is working anyway. Review cards for pull requests come only when you say so.')).toBe('en');
    expect(writtenIn('Review-Karten, PRs.')).toBeUndefined();
  });
});

describe('the voice of walkthroughs', () => {
  test('speaks first what a playing player needs from its slide on, else the newest walkthrough', async () => {
    voice.hold();
    const a = told();
    hand(a, { type: 'title', title: 'A', language: 'en', narration: 'A one.' });
    for (const n of [2, 3]) hand(a, { type: 'points', title: `A${n}`, points: ['x'], narration: `A${n}.` });
    await Bun.sleep(2);
    const b = told();
    hand(b, { type: 'title', title: 'B', language: 'en', narration: 'B one.' });
    // its player plays the second slide of A
    readWalkthrough(join(dir, 'answers'), 'a.walkthrough.json', voice.voicing, 1);
    voice.go();
    await until(() => voice.said.length === 6);
    // the sentence it was speaking first, then what A's player needs, then the newest walkthrough, then the rest
    expect(voice.said).toEqual(['A.', 'A2.', 'A3.', 'B.', 'B one.', 'A one.'].map((x) => `en:${x}`));
  });

  test('a sentence the voice cannot speak fails the walkthrough, which the player says; the others go on', async () => {
    const w = told();
    hand(w, { type: 'title', title: 'Mute', language: 'en', narration: 'One.' });
    await until(() => !!read('mute.walkthrough.json').error);
    expect(read('mute.walkthrough.json').error).toBe('no model');
    // its further slides are shown, not voiced
    hand(w, { type: 'points', title: 'Two', points: ['x'], narration: 'Next.' });
    expect(read('mute.walkthrough.json').slides).toHaveLength(2);
    const other = told();
    hand(other, { type: 'title', title: 'Loud', language: 'en', narration: 'Two.' });
    await until(() => voice.said.includes('en:Two.'));
    expect(voice.said).not.toContain('en:Next.');
  });

  test("hears each sentence back for the times of its words; one it cannot hear gets them by its words' length", async () => {
    const w = told();
    hand(w, { type: 'title', title: 'Heard', language: 'en', narration: 'It hears this one. Not this deaf one.' });
    await until(() => read('heard.walkthrough.json').clips[0]!.every((c) => c?.words));
    const [title, heard, deaf] = read('heard.walkthrough.json').clips[0]!;
    expect(title!.words).toEqual([0]);
    expect(heard!.words).toEqual([0, 0.1, 0.2, 0.3]);
    expect(deaf!.words).toHaveLength(4);
    expect(deaf!.words).not.toEqual([0, 0.1, 0.2, 0.3]);
    // a player reads it as voiced and heard
    expect(readWalkthrough(join(dir, 'answers'), 'heard.walkthrough.json', voice.voicing)?.error).toBeUndefined();
  });

  test('a sentence being voiced while the one before is heard back is not taken for interrupted', async () => {
    let last = () => {};
    const voicing = new Voicing({
      speak: async (text, out) => {
        if (text === 'Second.') await new Promise<void>((r) => (last = r));
        writeFileSync(out, silentWav(1));
      },
      hear: async () => [[' First', 0]],
    });
    const w = new AnswerWalkthrough({ dir: join(dir, 'answers'), checkout: repo, voicing });
    w.tool().run({ slide: { type: 'title', title: 'First', language: 'en', narration: 'Second.' } });
    w.finish();
    await until(() => !!read('first.walkthrough.json').clips[0]![0]?.words);
    expect(readWalkthrough(join(dir, 'answers'), 'first.walkthrough.json', voicing)?.error).toBeUndefined();
    last();
    await until(() => !!read('first.walkthrough.json').clips[0]![1]?.words);
  });

  test('loads when asked, before the first slide', () => {
    voice.voicing.warm('de');
    expect(voice.warmed).toEqual(['de']);
  });

  test('demo settings without a voice leave it unvoiced, to be read as captions', async () => {
    const spoken: string[] = [];
    const warmed: string[] = [];
    const voicing = new Voicing({ speak: async (text) => void spoken.push(text), warm: (l) => void warmed.push(l), silent: (l) => l === 'en' });
    voicing.warm('en');
    const w = new AnswerWalkthrough({ dir: join(dir, 'answers'), checkout: repo, voicing });
    w.tool().run({ slide: TITLE });
    w.tool().run({ slide: { type: 'points', title: 'Two steps', points: ['Rebase', 'Merge'], narration: 'First the branch moves onto the newest main, then both are combined.' } });
    w.finish();
    await Bun.sleep(5);
    expect(spoken).toEqual([]);
    expect(warmed).toEqual([]);
    const file = read('how-a-card-lands.walkthrough.json');
    expect(file).toMatchObject({ silent: true, language: 'en', done: true });
    expect(file.error).toBeUndefined();
    // its player reads it as it is, with nothing to wait for
    expect(readWalkthrough(join(dir, 'answers'), 'how-a-card-lands.walkthrough.json', voicing)).toMatchObject({ silent: true });
    expect(spoken).toEqual([]);
  });
});

describe('a walkthrough read by its player', () => {
  test('by its name in the thread directory only', async () => {
    const w = told();
    hand(w, TITLE);
    await until(() => read('how-a-card-lands.walkthrough.json').clips.flat().every(Boolean));
    const answers = join(dir, 'answers');
    expect(readWalkthrough(answers, 'how-a-card-lands.walkthrough.json', voice.voicing)?.title).toBe('How a card lands');
    for (const name of ['../secret.txt', 'how-a-card-lands.clips/1-1.wav', '.walkthrough.json', 'x/../how-a-card-lands.walkthrough.json']) expect(readWalkthrough(answers, name, voice.voicing)).toBeUndefined();
    // nor one that is no walkthrough as Obeya writes them
    writeFileSync(join(answers, 'odd.walkthrough.json'), JSON.stringify({ title: { x: 1 }, slides: [], done: true, clips: [], clipsDir: 'x' }));
    expect(readWalkthrough(answers, 'odd.walkthrough.json', voice.voicing)).toBeUndefined();
    // nor through a link to a file outside it
    symlinkSync(join(dir, 'secret.txt'), join(answers, 'linked.walkthrough.json'));
    expect(readWalkthrough(answers, 'linked.walkthrough.json', voice.voicing)).toBeUndefined();
    // a sentence voiced but not heard back by a server that stopped gets the times of its words by their length
    const file = join(answers, 'how-a-card-lands.walkthrough.json');
    const left = read('how-a-card-lands.walkthrough.json');
    writeFileSync(file, JSON.stringify({ ...left, clips: [[{ file: '1-1.wav', seconds: 1 }, left.clips[0]![1], left.clips[0]![2]]] }));
    expect(readWalkthrough(answers, 'how-a-card-lands.walkthrough.json', fakeVoicing().voicing)?.clips[0]![0]!.words).toEqual(estimatedStarts('How a card lands.', 1));
  });

  test('what a server left unvoiced when it stopped, the next one voices once a player reads it', async () => {
    voice.hold();
    const w = told();
    hand(w, TITLE);
    expect(hand(w, { type: 'points', title: 'Two steps', points: ['Rebase', 'Merge'], narration: 'First the branch moves onto the newest main, then both are combined.' })).toStartWith('Slide 2 is shown');
    // the server stops with the title slide voiced but not heard back and the second slide unvoiced,
    // its agent in the middle of the turn (a file from before files named their language)
    const answers = join(dir, 'answers');
    const { language: _, ...left } = read('how-a-card-lands.walkthrough.json');
    const voiced = left.clips[0]!.map((_, k) => ({ file: `1-${k + 1}.wav`, seconds: 1 }));
    writeFileSync(join(answers, 'how-a-card-lands.walkthrough.json'), JSON.stringify({ ...left, clips: [voiced, [null]] }));
    const next = fakeVoicing();
    const shown = readWalkthrough(answers, 'how-a-card-lands.walkthrough.json', next.voicing, 0);
    // no agent tells it on: it has every slide it gets
    expect(shown).toMatchObject({ done: true, language: 'en' });
    expect(shown?.error).toBeUndefined();
    expect(shown?.clips[0]![0]!.words).toEqual(estimatedStarts('How a card lands.', 1));
    await until(() => !!read('how-a-card-lands.walkthrough.json').clips[1]![0]?.words);
    expect(next.said).toEqual(['en:First the branch moves onto the newest main, then both are combined.']);
    // read again, nothing is voiced twice
    readWalkthrough(answers, 'how-a-card-lands.walkthrough.json', next.voicing, 0);
    await Bun.sleep(5);
    expect(next.said).toHaveLength(1);
  });

  test('a file that names clips elsewhere is not voiced on', () => {
    const answers = join(dir, 'answers');
    mkdirSync(join(dir, 'elsewhere'));
    const slide = { type: 'title', title: 'X', parts: ['X.'] };
    writeFileSync(join(answers, 'x.walkthrough.json'), JSON.stringify({ title: 'X', slides: [slide], done: true, clips: [[null]], clipsDir: '../elsewhere', language: 'en' }));
    const next = fakeVoicing();
    expect(readWalkthrough(answers, 'x.walkthrough.json', next.voicing)?.done).toBe(true);
    expect(next.voicing.voicing(join(answers, 'x.walkthrough.json'))).toBe(false);
  });
});
