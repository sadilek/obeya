import { afterEach, expect, test } from 'bun:test';
import { clock, setLanguage, snoozeWhen, stateLabel, t } from './strings';

afterEach(() => setLanguage('de', []));

test('the strings follow the language set, dates and numbers too', () => {
  const d = new Date(2026, 9, 6, 15, 4);
  setLanguage('de', []);
  expect(t.newCard).toBe('Neue Aufgabe');
  expect(clock(d)).toBe('15:04');
  expect(t.archive.when(d)).toContain('15:04');
  expect(t.share.tooLarge(12.34 * 1024 * 1024)).toContain('12,3 MB');

  setLanguage('en', []);
  expect(t.newCard).toBe('New task');
  expect(clock(d)).toMatch(/03:04\sPM/);
  expect(t.archive.day(d, new Date(2026, 9, 6))).toBe('Today');
  expect(t.archive.day(d, new Date(2026, 9, 9))).toBe('Tuesday, October 6');
  expect(t.share.tooLarge(12.34 * 1024 * 1024)).toContain('12.3 MB');
});

test('the browser\'s variant of the language writes dates its way', () => {
  setLanguage('en', ['de-DE', 'en-GB']);
  expect(t.archive.day(new Date(2026, 9, 6), new Date(2026, 9, 9))).toBe('Tuesday 6 October');
  expect(clock(new Date(2026, 9, 6, 15, 4))).toBe('15:04');
});

test('a language tag Intl refuses falls back to the usual variant', () => {
  setLanguage('en', ['en-US@posix']);
  expect(clock(new Date(2026, 9, 6, 15, 4))).toMatch(/03:04\sPM/);
});

test("a proposal of the work retrospective is labelled as Obeya's, a worker's proposal as an agent's", () => {
  setLanguage('en', []);
  expect(stateLabel({ state: 'proposal', retro: 'Two cards hit the same wall.' })).toBe('Proposed by Obeya');
  expect(stateLabel({ state: 'proposal' })).toBe('Proposed by an agent');
  setLanguage('de', []);
  expect(stateLabel({ state: 'proposal', retro: 'Zwei Karten scheiterten gleich.' })).toBe('Vorschlag von Obeya');
  expect(stateLabel({ state: 'planned', retro: 'Zwei Karten scheiterten gleich.' })).toBe('Geplant');
});

test('a card whose agent answered the owner without a new demo says so instead of "Demo ready"', () => {
  setLanguage('en', []);
  expect(stateLabel({ state: 'waiting', need: 'demo' })).toBe('Demo ready');
  expect(stateLabel({ state: 'waiting', need: 'demo', answered: true })).toBe('Agent answered, waiting for you');
  expect(stateLabel({ state: 'waiting', need: 'review', answered: true })).toBe('Agent answered, waiting for you');
});

test('a card\'s state label: each state, and what goes before it, in order of precedence', () => {
  setLanguage('en', []);
  type Label = Parameters<typeof stateLabel>[0];
  const until = '2030-01-01T08:00:00Z';
  const labels: [string, Label, string][] = [
    ['snoozed on a card', { state: 'working', snoozed: { by: 'agent', on: { card: 'c', title: 'Cart', state: 'done' } } as never }, 'Snoozed until “Cart” is done'],
    ['snoozed on a contributor', { state: 'waiting', need: 'review', snoozed: { by: 'agent', contributor: { author: 'ana' } } as never }, t.snooze.contributor('ana', undefined)],
    ['snoozed until', { state: 'working', pausing: true, snoozed: { by: 'owner', until } }, t.snooze.until(snoozeWhen(until))],
    ['pausing', { state: 'working', pausing: true, kind: 'question' }, 'Agent pausing …'],
    ['question paused', { state: 'live', kind: 'question', paused: true }, 'Agent paused'],
    ['question reading', { state: 'live', kind: 'question', thread: { thinking: true } }, 'agent reading …'],
    ['question ready', { state: 'live', kind: 'question' }, 'agent ready'],
    ['prototype discarded', { state: 'done', prototypeEnd: 'discarded', paused: true }, 'Prototype · discarded'],
    ['prototype built', { state: 'done', prototypeEnd: 'built' }, 'Prototype · built'],
    ['paused idea', { state: 'working', paused: true, idea: { status: 'open' } as never }, 'Idea · agent paused'],
    ['paused waiting', { state: 'waiting', need: 'demo', paused: true }, 'Demo ready · agent paused'],
    ['paused finishing done', { state: 'done', paused: true, finishing: true }, 'Done · agent paused'],
    ['paused finishing live', { state: 'live', paused: true, finishing: true }, 'Live · agent paused'],
    ['paused inPr', { state: 'inPr', paused: true }, 'In PR · agent paused'],
    ['paused working', { state: 'working', paused: true }, 'Agent paused'],
    ['restart paused waiting', { state: 'waiting', need: 'question', restartPaused: true }, 'Question for you · agent waits for restart'],
    ['restart paused live', { state: 'live', restartPaused: true }, 'Live · agent waits for restart'],
    ['restart paused done', { state: 'done', restartPaused: true }, 'Done · agent waits for restart'],
    ['restart paused inPr', { state: 'inPr', restartPaused: true }, 'In PR · agent waits for restart'],
    ['restart paused working', { state: 'working', restartPaused: true }, 'Agent waits for restart'],
    ['following up done', { state: 'done', finishing: true, followUp: true }, 'Done · agent answering'],
    ['following up live', { state: 'live', finishing: true, followUp: true }, 'Live · agent answering'],
    ['finishing done', { state: 'done', finishing: true }, 'Done · agent working'],
    ['finishing live', { state: 'live', finishing: true }, 'Live · agent working'],
    ['finishing working', { state: 'working', finishing: true }, 'Agent at work'],
    ['idea your turn', { state: 'working', idea: { status: 'open', yourTurn: true, thinking: false } as never }, 'Idea · your turn'],
    ['idea thinking', { state: 'working', idea: { status: 'open', yourTurn: true, thinking: true } as never }, 'Idea'],
    ['idea parked', { state: 'working', idea: { status: 'parked' } as never }, 'Idea · parked'],
    ['idea dropped', { state: 'working', idea: { status: 'dropped' } as never }, 'Idea · dropped'],
    ['queue checking', { state: 'planned', queue: { checking: true, since: until } }, 'Obeya checking'],
    ['queue paused', { state: 'planned', queue: { paused: true, since: until } }, 'Waiting: canvas paused'],
    ['queue slots', { state: 'planned', queue: { workspace: 'slots', since: until } }, 'Waiting for a free slot'],
    ['queue workspace', { state: 'planned', queue: { workspace: 'none', since: until } as never }, 'Waiting for a workspace'],
    ['queue behind', { state: 'planned', queue: { behind: ['x'], reason: 'r', since: until } }, 'In the queue'],
    ['landing', { state: 'waiting', need: 'demo', landing: true }, 'being approved …'],
    ['landing review', { state: 'waiting', need: 'demo', landing: true, contribution: { held: true } }, 'pushing …'],
    ['answering', { state: 'waiting', need: 'demo', answering: true }, 'Agent works on your message'],
    ['demo with question', { state: 'waiting', need: 'demo', question: {} }, 'Demo ready, with a question'],
    ['answered', { state: 'waiting', need: 'review', answered: true }, 'Agent answered, waiting for you'],
    ['need', { state: 'waiting', need: 'question' }, 'Question for you'],
    ['waiting without need', { state: 'waiting' }, 'Waiting for you'],
    ['review waits', { state: 'inPr', contribution: {} }, 'Waiting for the contributor'],
    ['opening PR', { state: 'inPr' }, 'Approved · agent opening the PR'],
    ['in PR', { state: 'inPr', pr: {} }, 'In PR'],
    ['proposal retro', { state: 'proposal', retro: 'x' }, 'Proposed by Obeya'],
    ['proposal setup', { state: 'proposal', proposal: { setup: true } }, 'Proposed by Obeya'],
    ['proposal', { state: 'proposal' }, 'Proposed by an agent'],
    ['stopped', { state: 'planned', branch: 'b' }, 'Stopped'],
    ['planned', { state: 'planned' }, 'Planned'],
    ['working', { state: 'working' }, 'Agent at work'],
    ['live', { state: 'live' }, 'Live'],
  ];
  for (const [name, card, label] of labels) expect([name, stateLabel(card)]).toEqual([name, label]);
});
