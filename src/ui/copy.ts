// A button that copies a text says so for a moment after.

import { useState } from 'react';

/** Whether the text was just copied, and `copy`, which copies it and says so for `ms`. */
export function useCopy(ms: number): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const copy = (text: string) =>
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), ms);
    }, console.error);
  return [copied, copy];
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
