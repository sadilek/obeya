import { expect, test } from 'bun:test';
import { clampWidth, loadWidths, readingDefault, saveWidths, SHEET_W, widthsIn } from './sheetWidth';

const store = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

test('a sheet is as wide as dragged, but leaves the canvas room and keeps its minimum', () => {
  expect(clampWidth(900, 2560, 'sheet')).toBe(900);
  expect(clampWidth(2400, 2560, 'sheet')).toBe(2560 - 14 - 240);
  expect(clampWidth(100, 2560, 'sheet')).toBe(320);
  expect(clampWidth(100, 2560, 'read')).toBe(380);
  // a window too narrow for both: the sheet keeps its minimum
  expect(clampWidth(500, 500, 'sheet')).toBe(320);
});

test('without a choice the sheets have their own width and reading follows the window', () => {
  const s = store();
  expect(loadWidths(s)).toEqual({ sheet: SHEET_W, read: null });
  expect(widthsIn(loadWidths(s), 1440)).toEqual({ sheet: SHEET_W, read: readingDefault(1440) });
  // reading widens the sheet, also one dragged wider than reading would be
  expect(widthsIn({ sheet: 1000, read: null }, 2560)).toEqual({ sheet: 1000, read: 1000 });
});

test('the chosen widths are remembered, and held to the window they are shown in', () => {
  const s = store();
  saveWidths(s, { sheet: 720, read: 1100 });
  expect(loadWidths(s)).toEqual({ sheet: 720, read: 1100 });
  expect(widthsIn(loadWidths(s), 2560)).toEqual({ sheet: 720, read: 1100 });
  expect(widthsIn(loadWidths(s), 1000)).toEqual({ sheet: 720, read: 1000 - 14 - 240 });
});

test('a broken entry falls back to the defaults', () => {
  const s = store();
  s.setItem('obeya-sheet-width', '{nope');
  expect(loadWidths(s)).toEqual({ sheet: SHEET_W, read: null });
});
