// A button that copies a text says so for a moment after.

import { useEffect, useRef, useState } from 'react';

/**
 * Whether the text was just copied, and `copy`, which copies it as `copyOrSelect` does and says so
 * for `ms`. The text need not be on the page (a path the button shows only as its title): it is
 * copied from an element of its own, out of sight, which goes again at once.
 */
export function useCopy(ms: number): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const copy = (text: string) =>
    void copyText(text).then((done) => {
      if (!done) return;
      setCopied(true);
      setTimeout(() => setCopied(false), ms);
    }, console.error);
  return [copied, copy];
}

/**
 * What copying a text that an element on the page shows did, for a moment (`copiedMs`, or
 * `selectedMs` where it could only select the text), and `copy`, which copies it as `copyOrSelect`.
 */
export function useCopied(copiedMs: number, selectedMs = copiedMs): ['copied' | 'selected' | null, (text: string, el: HTMLElement) => Promise<void>] {
  const [done, setDone] = useState<'copied' | 'selected' | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async (text: string, el: HTMLElement) => {
    const how = await copyOrSelect(text, el);
    setDone(how);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setDone(null), how === 'copied' ? copiedMs : selectedMs);
  };
  return [done, copy];
}

/** Puts `text` on the clipboard as `copyOrSelect` does, from an element out of sight; whether it did. */
export async function copyText(text: string): Promise<boolean> {
  const el = document.createElement('pre');
  el.textContent = text;
  Object.assign(el.style, { position: 'fixed', left: '-9999px', top: '0', margin: '0' });
  el.setAttribute('aria-hidden', 'true');
  document.body.append(el);
  try {
    return (await copyOrSelect(text, el)) === 'copied';
  } finally {
    el.remove();
  }
}

/**
 * Puts `text`, which `el` shows, on the clipboard: through the clipboard API, or where the page has
 * none (an insecure origin, such as an address over a VPN) by selecting `el`'s text and copying the
 * selection. 'selected' when even that fails: the text stays selected, for the system's own copy (a
 * long press on the phone). `el` may sit where no text can be selected (the canvas): it alone
 * becomes selectable while it holds the selection.
 */
export async function copyOrSelect(text: string, el: HTMLElement): Promise<'copied' | 'selected'> {
  if (navigator.clipboard && isSecureContext)
    try {
      await navigator.clipboard.writeText(text);
      return 'copied';
    } catch {}
  const sel = getSelection();
  if (!sel) return 'selected';
  const { userSelect, webkitUserSelect } = el.style;
  const restore = () => Object.assign(el.style, { userSelect, webkitUserSelect });
  Object.assign(el.style, { userSelect: 'text', webkitUserSelect: 'text' });
  const range = document.createRange();
  range.selectNodeContents(el);
  sel.removeAllRanges();
  sel.addRange(range);
  let copied = false;
  try {
    // a selection of nothing copies nothing, yet the command may still report success
    copied = sel.toString() !== '' && document.execCommand('copy');
  } catch {}
  if (copied) {
    sel.removeAllRanges();
    restore();
    return 'copied';
  }
  const leave = () => {
    if (sel.rangeCount && sel.containsNode(el, true)) return;
    document.removeEventListener('selectionchange', leave);
    restore();
  };
  document.addEventListener('selectionchange', leave);
  return 'selected';
}
