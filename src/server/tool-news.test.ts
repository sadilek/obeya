import { expect, test } from 'bun:test';
import { board, eachTest, restart, runtime, store, workers } from './canvas-fixture';
import { toolPrints } from './runtime';
import { RESTARTED } from './worker-texts';

eachTest();

test("a worker resumed after Obeya restarted with a changed tool hears that tool's definition as it is now, before what it is told of the restart", async () => {
  const c = board().create({ title: 'Export the readings', x: 0, y: 0 });
  await workers().start(c.id);
  const s = runtime.last;
  s.emit({ type: 'session', id: 'sess-1' });
  expect(store.toolsHeard('sess-1')).toEqual(toolPrints(s.spec.tools));
  // mid-turn as Obeya stops; the session began on an `ask` that was different then
  s.emit({ type: 'tool', name: 'Bash', input: { command: 'bun test' } });
  store.heardTools('sess-1', { ...toolPrints(s.spec.tools), ask: 'ask-before' });
  await restart();
  const resumed = runtime.last;
  expect(resumed.spec.resume).toBe('sess-1');
  const told = resumed.inbox[0]!;
  expect(told).toStartWith("Obeya's tools changed since this session last heard of them");
  expect(told).toContain(`mcp__obeya__ask: ${resumed.spec.tools.find((t) => t.name === 'ask')!.description}\nInput schema: {`);
  expect(told).not.toContain('mcp__obeya__report:');
  expect(told).toEndWith(RESTARTED);
  resumed.emit({ type: 'session', id: 'sess-1' });
  expect(store.toolsHeard('sess-1')).toEqual(toolPrints(resumed.spec.tools));
});
