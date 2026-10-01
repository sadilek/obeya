import { expect, test } from 'bun:test';
import { backgroundWork } from './runtime';

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
