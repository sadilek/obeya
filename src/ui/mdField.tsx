import { type ClipboardEvent, type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { dictating, useSpaceToTalk } from './dictation';
import { useDraft, useDraftField } from './draft';
import { useFitHeight } from './fitHeight';
import { sourceAt } from './markdown';
import { Body } from './message';
import { t } from './strings';

/** Where in the markdown `md` the click at x, y on its formatted text in `box` went: the source's end where it can't tell. */
function clickedAt(md: string, box: Element, x: number, y: number): number {
  const pos = document.caretPositionFromPoint?.(x, y);
  const range = pos ? null : document.caretRangeFromPoint?.(x, y);
  const node = pos?.offsetNode ?? range?.startContainer;
  const offset = pos?.offset ?? range?.startOffset ?? 0;
  if (!node || node.nodeType !== Node.TEXT_NODE || !box.contains(node)) return md.length;
  // the same words may stand earlier in the text: the how-manieth they are here is the how-manieth there
  const text = node.textContent ?? '';
  const walk = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
  let nth = 0;
  for (let n = walk.nextNode(); n && n !== node; n = walk.nextNode()) if (n.textContent === text) nth++;
  return sourceAt(md, text, nth, offset);
}

/**
 * A markdown text the owner may edit: it shows formatted, as its reader will see it; a click into it
 * (or Enter on it) opens its markdown in a text field with the cursor where the click went, and
 * leaving the field shows it formatted again (`onLeave`), not when the window loses focus with it;
 * the field going from the page with the cursor in it (its card closing) is leaving it too.
 * An empty text is the field itself. `field`: the text field while it shows; `grow`: the field is
 * as tall as its text; `draft`: the draft whose field it is while it shows, which the text may be
 * kept in: with one, Space held in the field dictates into it, and the field stays until the words
 * are in (`DictationLine` under it says how far that is).
 */
export function MdField({
  text,
  onChange,
  onLeave,
  field,
  draft,
  grow,
  fieldClass,
  shownClass,
  title = t.editBody,
  placeholder,
  maxLength = 20000,
  onPaste,
}: {
  text: string;
  onChange: (text: string) => void;
  onLeave?: () => void;
  field?: RefObject<HTMLTextAreaElement | null>;
  draft?: string;
  grow?: boolean;
  fieldClass: string;
  shownClass: string;
  title?: string;
  placeholder?: string;
  maxLength?: number;
  onPaste?: (e: ClipboardEvent<HTMLTextAreaElement>) => void;
}) {
  const [editing, setEditing] = useState(false);
  const caret = useRef<number | null>(null);
  const own = useRef<HTMLTextAreaElement>(null);
  const ref = field ?? own;
  const spoken = dictating(useDraft(draft ?? ''));
  const shown = !editing && text.trim() !== '' && !spoken;
  const space = useSpaceToTalk(ref);
  // what the field going away has to know: a removed field gets no blur
  const leaving = useRef({ editing, onLeave });
  leaving.current = { editing, onLeave };
  useEffect(
    () => () => {
      if (leaving.current.editing) leaving.current.onLeave?.();
    },
    [],
  );
  useFitHeight(ref, text, !!grow && !shown);
  useDraftField(draft ?? '', () => (draft ? ref.current : null), false, !shown, false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!editing || caret.current === null || !el) return;
    el.focus();
    el.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  }, [editing]);
  const edit = (at: number) => {
    caret.current = at;
    setEditing(true);
  };
  if (shown)
    return (
      <div
        className={`${shownClass} md-shown`}
        tabIndex={0}
        title={title}
        // a link, a code block's copy button or text being selected keep their own click
        onClick={(e) => {
          if ((e.target as Element).closest('a, button') || !getSelection()?.isCollapsed) return;
          edit(clickedAt(text, e.currentTarget, e.clientX, e.clientY));
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || e.target !== e.currentTarget) return;
          e.preventDefault();
          edit(text.length);
        }}
      >
        <Body md={text} />
      </div>
    );
  return (
    <textarea
      ref={ref}
      className={spoken ? `${fieldClass} dictating` : fieldClass}
      value={text}
      placeholder={placeholder}
      maxLength={maxLength}
      onPaste={onPaste}
      onFocus={() => setEditing(true)}
      onKeyDown={(e) => draft && space.keyDown(e)}
      onKeyUp={space.keyUp}
      onBlur={() => {
        space.blur();
        if (!document.hasFocus()) return;
        leaving.current.editing = false;
        setEditing(false);
        onLeave?.();
      }}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
