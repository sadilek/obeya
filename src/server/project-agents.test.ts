import { beforeEach, describe, expect, test } from 'bun:test';
import type { PlanDoc } from '../core/plan-doc';
import { Board } from './board';
import { Store } from './db';
import { ProjectAgents } from './project-agents';
import { FakeRuntime } from './testing';

const doc: PlanDoc = {
  file: 'docs/plan/a.md',
  title: 'Export',
  goal: 'G',
  workstreams: [{ key: 'W1', label: 'W1', title: 'CSV', body: '', done: false, inReview: false }],
  markdown: '',
};

let board: Board;
let runtime: FakeRuntime;
let agents: ProjectAgents;
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  board = new Board(new Store(':memory:'), { id: 'c', name: 'C', repos: [{ id: 'home', name: 'Home', path: '/repo', branch: 'main' }] }, () => [doc]);
  runtime = new FakeRuntime();
  agents = new ProjectAgents(board, runtime, '/repo');
});

const project = () => board.snapshot().items.find((i) => i.kind === 'project')!;
const card = () => board.snapshot().items.find((i) => i.label === 'W1')!;

describe('project agents', () => {
  test('answers in a read-only session on the repository, with the decision log', async () => {
    board.decide({ project_id: project().id, card_id: card().id, question: 'Trennzeichen?', answer: 'Semikolon', by: 'owner' });
    const reply = agents.ask(project(), card(), { text: 'Kopfzeile?', options: ['Ja', 'Nein'] });
    await tick();
    const s = runtime.last;
    expect(s.spec).toMatchObject({ cwd: '/repo', readOnly: true });
    expect(s.inbox[0]).toContain('Kopfzeile?');
    expect(s.inbox[0]).toContain('Trennzeichen? → Semikolon (owner)');
    s.call('answer', { text: 'Ja, laut Plan.' });
    expect(await reply).toEqual({ answer: 'Ja, laut Plan.' });
    s.emit({ type: 'idle' });
    expect(s.closed).toBe(true);
  });

  test('escalates, and a turn without a reply escalates the original question', async () => {
    const r1 = agents.ask(project(), card(), { text: 'Budget?', options: [] });
    await tick();
    runtime.last.call('escalate', { question: 'Darf der Export Geld kosten?', options: ['Ja', 'Nein'] });
    expect(await r1).toEqual({ escalate: { text: 'Darf der Export Geld kosten?', options: ['Ja', 'Nein'] } });
    runtime.last.emit({ type: 'idle' });

    const r2 = agents.ask(project(), card(), { text: 'Farbe?', options: ['Blau'] });
    await tick();
    runtime.last.emit({ type: 'idle' });
    expect(await r2).toEqual({ escalate: { text: 'Farbe?', options: ['Blau'] } });
  });

  test('one session per project, resumed; questions wait for each other', async () => {
    const r1 = agents.ask(project(), card(), { text: 'Q1', options: [] });
    const r2 = agents.ask(project(), card(), { text: 'Q2', options: [] });
    await tick();
    expect(runtime.sessions).toHaveLength(1);
    runtime.last.emit({ type: 'session', id: 'p-1' });
    runtime.last.call('answer', { text: 'A1' });
    runtime.last.emit({ type: 'idle' });
    await r1;
    await tick();
    expect(runtime.sessions).toHaveLength(2);
    expect(runtime.last.spec.resume).toBe('p-1');
    runtime.last.call('answer', { text: 'A2' });
    expect(await r2).toEqual({ answer: 'A2' });
  });
});
