import { afterAll, beforeEach, expect, test } from 'bun:test';
import { copyOrSelect } from './copy';

// a page's clipboard, selection and copy command, as the browser offers them: the copy command puts
// what is selected on the clipboard and reports success even when that is nothing, and an element
// on the canvas, where no text is selectable, has no text in a selection unless it is made selectable
type El = { text: string; onCanvas: boolean; style: { userSelect: string; webkitUserSelect: string } };
let clipboard: { writeText: (s: string) => Promise<void> } | undefined;
let secure = true;
let copies = false;
let written: string[] = [];
let selected: El[] = [];
let onSelectionChange: (() => void)[] = [];
const g = globalThis as Record<string, unknown>;
const selectable = (el: El) => !el.onCanvas || el.style.userSelect === 'text';
const selection = {
  get rangeCount() {
    return selected.length;
  },
  removeAllRanges: () => (selected = []),
  addRange: (r: { el: El }) => selected.push(r.el),
  containsNode: (el: El) => selected.includes(el),
  toString: () => selected.filter(selectable).map((el) => el.text).join(''),
};
Object.defineProperty(navigator, 'clipboard', { configurable: true, get: () => clipboard });
Object.defineProperty(globalThis, 'isSecureContext', { configurable: true, get: () => secure });
g.getSelection = () => selection;
g.document = {
  createRange: () => ({ el: null as unknown, selectNodeContents(el: unknown) { this.el = el; } }),
  execCommand: (c: string) => c === 'copy' && copies && (written.push(selection.toString()), true),
  addEventListener: (type: string, f: () => void) => type === 'selectionchange' && onSelectionChange.push(f),
  removeEventListener: (type: string, f: () => void) => type === 'selectionchange' && (onSelectionChange = onSelectionChange.filter((x) => x !== f)),
};
const element = (text: string, onCanvas = false): El => ({ text, onCanvas, style: { userSelect: '', webkitUserSelect: '' } });
const changeSelection = () => onSelectionChange.slice().forEach((f) => f());
// the other test files of a process that runs them one after the other see no page
afterAll(() => {
  delete g.document;
  delete g.getSelection;
  delete (navigator as unknown as Record<string, unknown>).clipboard;
  delete g.isSecureContext;
});

beforeEach(() => {
  clipboard = { writeText: async (s) => void written.push(s) };
  secure = true;
  copies = false;
  written = [];
  selected = [];
  onSelectionChange = [];
});

test('the clipboard API gets the text as it is, and nothing is selected', async () => {
  expect(await copyOrSelect('ls -la\n  cd x', element('ls -la\n  cd x') as unknown as HTMLElement)).toBe('copied');
  expect(written).toEqual(['ls -la\n  cd x']);
  expect(selected).toEqual([]);
});

test('on an insecure origin the block is selected and copied with the copy command, which leaves no selection behind', async () => {
  clipboard = undefined;
  secure = false;
  copies = true;
  expect(await copyOrSelect('x', element('x') as unknown as HTMLElement)).toBe('copied');
  expect(written).toEqual(['x']);
  expect(selected).toEqual([]);
});

test('on an insecure origin a number on the canvas, where no text is selectable, still goes on the clipboard, and the canvas stays as it was', async () => {
  clipboard = undefined;
  secure = false;
  copies = true;
  const no = element('K1', true);
  expect(await copyOrSelect('K1', no as unknown as HTMLElement)).toBe('copied');
  expect(written).toEqual(['K1']);
  expect(selected).toEqual([]);
  expect(no.style).toEqual({ userSelect: '', webkitUserSelect: '' });
});

test('where neither copies, the block stays selected for the system to copy', async () => {
  clipboard = { writeText: () => Promise.reject(new Error('denied')) };
  const el = element('x');
  expect(await copyOrSelect('x', el as unknown as HTMLElement)).toBe('selected');
  expect(selected).toEqual([el]);
});

test('where neither copies, a number on the canvas shows selected until the selection moves elsewhere', async () => {
  clipboard = undefined;
  secure = false;
  const no = element('K1', true);
  expect(await copyOrSelect('K1', no as unknown as HTMLElement)).toBe('selected');
  expect(selection.toString()).toBe('K1');
  changeSelection();
  expect(no.style.userSelect).toBe('text');
  selected = [];
  changeSelection();
  expect(no.style).toEqual({ userSelect: '', webkitUserSelect: '' });
  expect(onSelectionChange).toEqual([]);
});
