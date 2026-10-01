import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanvasSnapshot } from '../src/core/types';

const script = join(import.meta.dir, 'scratch-obeya.ts');
const tmp = mkdtempSync(join(tmpdir(), 'obeya-stage-'));
const free = Bun.serve({ port: 0, fetch: () => new Response() });
const port = free.port!;
free.stop(true);
const dir = join(tmp, 'scratch');

afterAll(() => {
  Bun.spawnSync([process.execPath, script, '--stop', String(port), '--dir', dir]);
  rmSync(tmp, { recursive: true, force: true });
});

test('stages a scratch Obeya with its cards in the states the stage file gives', async () => {
  const stage = join(tmp, 'stage.json');
  writeFileSync(
    stage,
    JSON.stringify({
      port,
      dir,
      plans: { 'docs/plan/werkzeug.md': '# Werkzeug\n\nG.\n\n## Workstreams\n\n- [ ] **W1:** Konfiguration.\n' },
      cards: [
        { key: 'P', project: 'docs/plan/werkzeug.md', x: 0, y: 0 },
        { key: 'W1', workstream: 'W1', state: 'working', statusLine: 'Liest ein' },
        { key: 'A', title: 'Einlesen', x: 500, y: 40, state: 'working', statusLine: 'Tests laufen', createdAgo: '2h' },
        { key: 'B', title: 'Optionen', queue: { behind: ['A'], reason: 'Beide ändern src/config.ts.' }, events: [{ kind: 'state', author: 'obeya', text: 'wartet', ago: '10m' }] },
        { key: 'C', title: 'Frage', state: 'waiting', need: 'question', question: { text: 'Lang oder kurz?', options: ['Lang', 'Kurz'] } },
        { key: 'D', title: 'Folge', from: 'C' },
      ],
    }),
  );
  const r = Bun.spawnSync([process.execPath, script, stage]);
  expect(r.stderr.toString()).toBe('');
  const staged = JSON.parse(r.stdout.toString()) as { url: string; canvas: string; cards: Record<string, string> };
  expect(staged.url).toBe(`http://127.0.0.1:${port}/?c=obeya`);
  const { items } = (await (await fetch(`http://127.0.0.1:${port}/api/c/${staged.canvas}/canvas`)).json()) as CanvasSnapshot;
  const card = (key: string) => items.find((i) => i.id === staged.cards[key])!;
  expect(card('P')).toMatchObject({ kind: 'project', x: 0, y: 0 });
  expect(card('W1')).toMatchObject({ label: 'W1', state: 'working', statusLine: 'Liest ein' });
  expect(card('A')).toMatchObject({ title: 'Einlesen', state: 'working', statusLine: 'Tests laufen' });
  expect(card('B').queue).toMatchObject({ behind: [staged.cards.A], reason: 'Beide ändern src/config.ts.' });
  expect(card('C')).toMatchObject({ state: 'waiting', need: 'question', question: { text: 'Lang oder kurz?', options: ['Lang', 'Kurz'] } });
  expect(card('D').from).toBe(staged.cards.C!);
  const created = Bun.spawnSync(['sqlite3', join(dir, 'home/obeya.db'), `SELECT created_at FROM cards WHERE id = '${staged.cards.A}'`]).stdout.toString();
  expect(Date.now() - Date.parse(created.trim())).toBeGreaterThan(7000_000);
  const events = (await (await fetch(`http://127.0.0.1:${port}/api/c/obeya/cards/${staged.cards.B}/events`)).json()) as { text: string }[];
  expect(events.map((e) => e.text)).toContain('wartet');
}, 20_000);
