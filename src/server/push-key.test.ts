import { expect, test } from 'bun:test';
import { INPUT_MONITORING, ShellReports } from './push-key';

test("the app's shell reports what it hears; one that stopped reporting has gone, and the setup assistant shows what is in the way", () => {
  let now = 0;
  const shells = new ShellReports(() => now);
  expect(shells.current()).toBeNull();
  expect(shells.item('AltRight')).toBeNull();
  expect(() => shells.report({ state: 'on' })).toThrow();
  shells.report({ state: 'on', platform: 'macos', detail: '' });
  expect(shells.current()).toEqual({ state: 'on', platform: 'macos' });
  expect(shells.item('AltRight')).toEqual({ id: 'globalKey', state: 'ok', found: 'AltRight' });
  shells.report({ state: 'permission', platform: 'macos' });
  expect(shells.item('AltRight')).toEqual({ id: 'globalKey', state: 'missing', found: 'permission', install: { commands: [], url: INPUT_MONITORING } });
  shells.report({ state: 'permission', platform: 'macos', detail: 'restart' });
  expect(shells.item('AltRight')?.found).toBe('restart');
  shells.report({ state: 'none', platform: 'linux', session: 'wayland' });
  expect(shells.item('ControlRight')).toEqual({ id: 'globalKey', state: 'off', found: 'none' });
  now += 10_000;
  expect(shells.current()).toBeNull();
});
