// The hint that screenshots may be pasted from the clipboard: shown once the owner has picked one
// with the file dialog, in that field, until they confirm it; never again after that, and never
// once they have pasted one. And the one under the microphone that text may be pasted outside a
// text field too, until the owner has done so once.

import { useEffect, useSyncExternalStore } from 'react';
import { know, known } from './known';

/** Set once the owner pasted a screenshot or confirmed the hint: it never shows again. */
export const PASTE_KNOWN = 'obeya-paste-known';
/** The field (its draft key) the hint is due in, kept across reloads until it is confirmed. */
const PASTE_DUE = 'obeya-paste-hint';

let due: string | null = (() => {
  try {
    return known(PASTE_KNOWN) ? null : localStorage.getItem(PASTE_DUE);
  } catch {
    return null;
  }
})();
/** The fields that take screenshots now, in the order they appeared. */
let fields: string[] = [];
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

function setDue(key: string | null) {
  due = key;
  try {
    if (key) localStorage.setItem(PASTE_DUE, key);
    else localStorage.removeItem(PASTE_DUE);
  } catch {}
  changed();
}

/**
 * The field the hint shows in: the one it is due in, or, while that is gone (the card it was on
 * closed, say), the field that appeared last.
 */
export function hintField(due: string | null, fields: string[]): string | null {
  if (!due || !fields.length) return null;
  return fields.includes(due) ? due : fields[fields.length - 1]!;
}

/** Only where there is a keyboard to paste with: a phone has none to hint at. */
const hasKeyboard = () => typeof matchMedia === 'function' && matchMedia('(any-pointer: fine)').matches;

/** Screenshots picked from disk into field `key` arrived: the hint is due there, unless the owner knows. */
export function pickedShots(key: string) {
  if (known(PASTE_KNOWN) || !hasKeyboard()) return;
  setDue(key);
}

/** The owner pasted a screenshot: they know, and the hint goes. */
export function pastedShots() {
  know(PASTE_KNOWN);
  if (due) setDue(null);
}

/** The owner confirmed the hint: it goes for good. */
export const confirmPasteHint = pastedShots;

/** Set once the owner pasted text outside a text field: the line under the microphone no longer names the key. */
export const PASTE_TEXT_KNOWN = 'obeya-paste-text-known';
let textKnown = known(PASTE_TEXT_KNOWN);

/** The owner pasted text outside a text field: they know, and the hint goes. */
export function pastedText() {
  know(PASTE_TEXT_KNOWN);
  if (textKnown) return;
  textKnown = true;
  changed();
}

/** Whether the line under the microphone says that text may be pasted outside a text field. */
export const usePasteTextHint = () => useSyncExternalStore(subscribe, () => !textKnown && hasKeyboard());

/** Whether the hint shows in field `key`, which takes screenshots while `on`. */
export function usePasteHint(key: string, on: boolean) {
  useEffect(() => {
    if (!on) return;
    fields = [...fields, key];
    changed();
    return () => {
      const i = fields.lastIndexOf(key);
      if (i >= 0) fields = fields.toSpliced(i, 1);
      changed();
    };
  }, [key, on]);
  return useSyncExternalStore(subscribe, () => on && hintField(due, fields) === key);
}
