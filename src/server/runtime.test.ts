import { expect, test } from 'bun:test';
import { backgroundWork, foregroundSleep } from './runtime';

test('background work counts renders, test runs and watchers, not housekeeping', () => {
  expect(
    backgroundWork([
      { task_type: 'local_bash' },
      { task_type: 'local_agent' },
      // a watcher the SDK marks as no activity still wakes the agent when it fires
      { task_type: 'monitor_ws', ambient: true },
      { task_type: 'dream', ambient: true },
    ]),
  ).toBe(3);
  expect(backgroundWork([])).toBe(0);
});

test('foreground sleep: sleep durations, loops, bounds and background', () => {
  const cases: [string, number][] = [
    ['sleep 290', 290],
    ['sleep 5m', 300],
    ['sleep 1m 30s', 90],
    ['sleep 0.5', 0.5],
    ['sleep 290 && curl -s https://example.com/health', 290],
    ['cd app; sleep 20; sleep 20', 40],
    ['sleep 60 2>&1', 60],
    // behind & it runs on while the command returns
    ['sleep 300 &', 0],
    ['(sleep 300; touch done) & echo started', 0],
    // loops: the body times the iterations, unbounded for while and until
    ['for i in $(seq 1 60); do curl -s x && break; sleep 5; done', 300],
    ['for i in {1..10}; do sleep 2; done', 20],
    ['for host in a b c; do ping -c1 $host; sleep 1; done', 3],
    ['until curl -s localhost:4000 >/dev/null; do sleep 0.5; done', Infinity],
    ['while true; do\n  gh run view 123 | grep -q completed && break\n  sleep 10\ndone', Infinity],
    ['for i in $(seq 1 5); do echo $i; done', 0],
    // a leading timeout bounds it
    ["timeout 30 bash -c 'until curl -s localhost:4000; do sleep 1; done'", 30],
    ['sleep infinity', Infinity],
    ['bun test', 0],
    ['git log --oneline | head', 0],
  ];
  for (const [command, s] of cases) expect([command, foregroundSleep(command)]).toEqual([command, s]);
});
