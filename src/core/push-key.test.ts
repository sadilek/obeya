import { expect, test } from 'bun:test';
import { defaultPushKey, parsePushKey, pushKeyFromEvent } from './push-key';

test('the push-to-talk key: one nobody types with alone, or modifiers and a key; right Option on a Mac, right Ctrl elsewhere', () => {
  expect(defaultPushKey('darwin')).toBe('AltRight');
  expect(defaultPushKey('win32')).toBe('ControlRight');
  expect(defaultPushKey('linux')).toBe('ControlRight');
  for (const k of ['AltRight', 'ControlLeft', 'MetaRight', 'F13', 'F24', 'Pause', 'ContextMenu']) expect(parsePushKey(k)).toBe(k);
  // typed with: they would be taken from every other app
  for (const k of ['KeyA', 'Space', 'Digit1', 'Enter', 'F25', '', 'Control', 'Shift+Control']) expect(parsePushKey(k)).toBeNull();
  // modifiers in a fixed order, each once
  expect(parsePushKey('Shift+Control+Space')).toBe('Control+Shift+Space');
  expect(parsePushKey('Meta+KeyK')).toBe('Meta+KeyK');
  for (const k of ['Control+AltRight', 'Hyper+Space', 'Control+Space+Shift', 42, null]) expect(parsePushKey(k)).toBeNull();
});

test('a key pressed in the settings: a modifier alone as itself, a key with modifiers as a combination', () => {
  const press = (code: string, mods: Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', boolean>> = {}) =>
    pushKeyFromEvent({ code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });
  expect(press('AltRight', { altKey: true })).toBe('AltRight');
  expect(press('F13')).toBe('F13');
  expect(press('Space', { ctrlKey: true, shiftKey: true })).toBe('Control+Shift+Space');
  expect(press('KeyA')).toBeNull();
});
