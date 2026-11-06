// A walkthrough as its agent hands it over slide by slide: what Obeya shows of each slide, what it
// refuses back to the agent, and the order the one voice speaks the sentences of all walkthroughs in.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Walkthrough } from '../core/walkthrough';
import { fakeVoicing, until } from './testing';
import { AnswerWalkthrough, readWalkthrough } from './walkthrough';

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
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const told = (shown: string[][] = [], language: 'de' | 'en' = 'en') =>
  new AnswerWalkthrough({ dir: join(dir, 'answers'), checkout: repo, language, voicing: voice.voicing, onShown: (files) => shown.push(files.map((f) => f.name)) });
const hand = (w: AnswerWalkthrough, slide: unknown) => w.tool().run({ slide }) as string;
const read = (name: string): Walkthrough => JSON.parse(readFileSync(join(dir, 'answers', name), 'utf8'));
const TITLE = { type: 'title', title: 'How a card lands', subtitle: 'From approval to main', narration: 'Approving a card starts the landing. It takes three steps.' };

describe('a walkthrough handed over slide by slide', () => {
  test('shows from its title slide on, which says its title first, and comes with the answer once the turn is over', async () => {
    const shown: string[][] = [];
    const w = told(shown);
    expect(hand(w, TITLE)).toBe('Slide 1 is shown and being voiced. Hand over the next slide, or call answer_owner once the walkthrough is complete.');
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
    expect(file.clips[1]).toEqual([1, 2, 3, 4].map((n) => ({ file: `2-${n}.wav`, seconds: 1 })));
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
    hand(w, { type: 'code', title: 'Wide', file: 'wide.txt', lines: [1, 1], narration: 'Wide.' });
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

  test('German narration splits as German captions do', () => {
    const w = told([], 'de');
    hand(w, { type: 'title', title: 'Wie eine Karte landet', narration: 'Am 1. November kam das. Es geht so.' });
    expect(read('wie-eine-karte-landet.walkthrough.json').slides[0]!.parts).toEqual(['Wie eine Karte landet.', 'Am 1. November kam das.', 'Es geht so.']);
  });
});

describe('the voice of walkthroughs', () => {
  test('speaks first what a playing player needs from its slide on, else the newest walkthrough', async () => {
    voice.hold();
    const a = told();
    hand(a, { type: 'title', title: 'A', narration: 'A one.' });
    for (const n of [2, 3]) hand(a, { type: 'points', title: `A${n}`, points: ['x'], narration: `A${n}.` });
    await Bun.sleep(2);
    const b = told();
    hand(b, { type: 'title', title: 'B', narration: 'B one.' });
    // its player plays the second slide of A
    readWalkthrough(join(dir, 'answers'), 'a.walkthrough.json', voice.voicing, 1);
    voice.go();
    await until(() => voice.said.length === 6);
    // the sentence it was speaking first, then what A's player needs, then the newest walkthrough, then the rest
    expect(voice.said).toEqual(['A.', 'A2.', 'A3.', 'B.', 'B one.', 'A one.'].map((x) => `en:${x}`));
  });

  test('a sentence the voice cannot speak fails the walkthrough, which the player says; the others go on', async () => {
    const w = told();
    hand(w, { type: 'title', title: 'Stumm', narration: 'Eins.' });
    await until(() => !!read('stumm.walkthrough.json').error);
    expect(read('stumm.walkthrough.json').error).toBe('no model');
    // its further slides are shown, not voiced
    hand(w, { type: 'points', title: 'Zwei', points: ['x'], narration: 'Weiter.' });
    expect(read('stumm.walkthrough.json').slides).toHaveLength(2);
    const other = told();
    hand(other, { type: 'title', title: 'Laut', narration: 'Zwei.' });
    await until(() => voice.said.includes('en:Zwei.'));
    expect(voice.said).not.toContain('en:Weiter.');
  });

  test('loads when asked, before the first slide', () => {
    voice.voicing.warm('de');
    expect(voice.warmed).toEqual(['de']);
  });
});

describe('a walkthrough read by its player', () => {
  test('by its name in the thread directory only; one whose voice stopped with the server says so', async () => {
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
    // a server that starts anew voices nothing of what the last one left unvoiced
    const file = join(answers, 'how-a-card-lands.walkthrough.json');
    const left = read('how-a-card-lands.walkthrough.json');
    writeFileSync(file, JSON.stringify({ ...left, clips: [[left.clips[0]![0], null, null]] }));
    expect(readWalkthrough(answers, 'how-a-card-lands.walkthrough.json', fakeVoicing().voicing)?.error).toBe('interrupted');
  });
});
