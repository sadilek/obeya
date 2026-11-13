// The field the owner writes in under a conversation, the same on a card and in Obeya's sheet: one
// frame with the text, the screenshot button, the microphone and Send (an arrow, as in chat apps) in
// its bottom corner, as wide as the conversation above it. The text grows with what is written (or
// with its placeholder, which shows in full), up to a part of the window.
// The buttons stand side by side beside a short text and on top of each other beside a tall one,
// which then gets the width they free (`fitField`). A message replied to stands above the text as a
// quote. With the cursor in the field, speaking dictates into it: hold its microphone, the one at
// the bottom, or Space. Under a card's conversation, `/` at the start of a word opens the menu of the
// skills of the card's agent (`skills.ts`).

import { type MouseEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { api } from './api';
import { DictateButton, dictating, dictationLine, useSpaceToTalk } from './dictation';
import { dropDraft, typeInto, updateDraft, useDraft, useDraftField } from './draft';
import { setHeight, textHeight, useFitHeight } from './fitHeight';
import { Quote } from './message';
import { type Reply, replyOn, setReply, useReply } from './reply';
import { knowsSkills, matching, type Slash, skillWord, slashAt, useSkills, usedSkills } from './skills';
import { AttachButton, ShotStrip, useShotInput } from './shots';
import { t } from './strings';
import type { Skill } from '../core/types';
import { useLatest } from './latest';

/** Whether Enter sends what is written (Shift+Enter breaks the line), as at the desk. */
let enterSends = true;

/**
 * On a phone Enter breaks the line and only Send sends: the keyboard's Enter key is where a line
 * break is typed, and a message sent half written cannot be taken back.
 */
export function enterBreaksLines() {
  enterSends = false;
}

/**
 * Fits the field's text box to its text and lays out the buttons beside it (`tools`): on top of each
 * other once the text, at the width it has beside them stacked, is about as high as their stack (to
 * half a line: on the phone three lines are a few pixels short of it), else side by side. The text is measured at that one width whichever way the buttons stand, so a
 * text near the threshold does not switch back and forth as the width it gets changes with them.
 * An empty field measures its placeholder. The text box keeps its cursor and, around the
 * measuring, its scroll position.
 */
function fitField(el: HTMLTextAreaElement, tools: HTMLElement | null) {
  const buttons = tools ? ([...tools.children] as HTMLElement[]) : [];
  if (!tools || !buttons.length) return setHeight(el, textHeight(el));
  const gap = parseFloat(getComputedStyle(tools).rowGap) || 0;
  const stackWidth = Math.max(...buttons.map((b) => b.offsetWidth));
  const stackHeight = buttons.reduce((h, b) => h + b.offsetHeight, 0) + gap * (buttons.length - 1);
  // the width the text has beside the stacked buttons, from the width it has now beside them
  const narrow = el.offsetWidth + tools.offsetWidth - stackWidth;
  const { scrollTop } = el;
  const { width, flex } = el.style;
  el.style.flex = 'none';
  el.style.width = `${narrow}px`;
  const stacked = textHeight(el) >= stackHeight - parseFloat(getComputedStyle(el).lineHeight) / 2;
  el.style.flex = flex;
  el.style.width = width;
  tools.classList.toggle('stacked', stacked);
  // beside the stack the text starts at its top, not at its bottom
  setHeight(el, Math.max(textHeight(el), stacked ? stackHeight : 0));
  el.scrollTop = scrollTop;
}

/**
 * What the owner writes to an agent or to Obeya; screenshots are pasted, dropped or picked, unless
 * `noImages`. `draft`: the draft it shows and keeps (`draft.ts`), which the microphone reads; without
 * one the field keeps its own. `label` names what Send does (its tooltip); `action` puts words on the button instead
 * of the arrow, for a button that starts something rather than sends. The message the words reply
 * to stands in the draft (`reply.ts`): quoted above the text, with × to take it out (Escape takes it
 * out too, before it closes the card or the sidebar), and `onSend` gets it. `skills`: the card whose
 * agent reads the words, whose skills `/` offers.
 */
export function Composer({
  placeholder,
  onSend,
  label = t.send,
  action,
  allowEmpty = false,
  noImages = false,
  obeya,
  onText,
  className,
  draft,
  chip,
  skills,
}: {
  draft?: string;
  placeholder: string;
  onSend: (text: string, images?: string[], replyTo?: Reply['to']) => Promise<void> | void;
  label?: string;
  action?: string;
  allowEmpty?: boolean;
  noImages?: boolean;
  /** Obeya reads what is typed: it gets ready while the owner types; a text here says so under the field. */
  obeya?: true | string;
  /** Hears the text as it is typed. */
  onText?: (text: string) => void;
  className?: string;
  /** What else the words go out with, above them beside the quote (a place in the demo video). */
  chip?: ReactNode;
  skills?: string;
}) {
  const own = useId();
  const key = draft ?? `field:${own}`;
  useEffect(() => (draft ? undefined : () => dropDraft(key)), [key]);
  const d = useDraft(key);
  const { text } = d;
  const setText = (text: string) => updateDraft(key, { text });
  const [busy, setBusy] = useState(false);
  const shots = useShotInput({ draft: key, off: noImages });
  const images = shots.images;
  const field = useRef<HTMLTextAreaElement>(null);
  useDraftField(key, () => field.current, !noImages);
  const tools = useRef<HTMLDivElement>(null);
  // as high as the text; the stylesheet caps it, and beyond that it scrolls
  useFitHeight(field, text, true, (el) => fitField(el, tools.current));
  const listen = useLatest(onText);
  useEffect(() => listen.current?.(text), [text]);
  const reply = useReply(key);
  const [focused, setFocused] = useState(false);
  const skillList = useSkills(skills, focused);
  // the `/` word at the cursor, the skill marked in the menu, and where Escape closed the menu
  const [slash, setSlash] = useState<Slash | null>(null);
  const [marked, setMarked] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const atCursor = () => {
    const el = field.current;
    const at = el && el.selectionStart === el.selectionEnd ? slashAt(el.value, el.selectionStart) : null;
    setSlash((s) => (s?.start === at?.start && s?.query === at?.query ? s : at));
    if (!at) setDismissed(null);
  };
  useEffect(atCursor, [text]);
  useEffect(() => setMarked(0), [slash?.query]);
  // the menu: undefined while the skills are asked, else those that fit (none: no menu)
  const menu = skills && focused && slash && dismissed !== slash.start ? (skillList ? matching(skillList, slash.query) : undefined) : [];
  const menuOn = menu === undefined || menu.length > 0;
  // typed into the field, as if by hand: the cursor stays after it, and undo takes it back
  const pick = (name: string) => {
    const el = field.current;
    if (!el || !slash) return;
    const { from, to, word, skip } = skillWord(el.value, slash, el.selectionStart, name);
    el.focus();
    el.setSelectionRange(from, to);
    typeInto(el, word);
    if (skip) el.setSelectionRange(el.selectionStart + skip, el.selectionStart + skip);
    usedSkills();
  };
  // replying to a message is writing to it: the field takes the focus (not for a reply kept from before)
  const quoted = useRef(reply?.quote.ev);
  useEffect(() => {
    if (reply && reply.quote.ev !== quoted.current) field.current?.focus();
    quoted.current = reply?.quote.ev;
  }, [reply?.quote.ev]);
  const space = useSpaceToTalk(field);
  const ready = (!!text.trim() || images.length > 0 || allowEmpty) && !busy && !shots.uploading && !shots.marking.length;
  const send = async () => {
    if (!ready) return;
    setBusy(true);
    await onSend(text.trim(), images.length ? images : undefined, reply?.to);
    setBusy(false);
    setText('');
    shots.clear();
    // a reply chosen meanwhile stays for the next words
    if (reply && replyOn(key) === reply) setReply(key, null);
  };
  /**
   * The cursor stays in the field when Send is pressed. On a phone the field's blur took the keyboard
   * down and moved the layout before the click landed, so the first tap only closed the keyboard.
   */
  const keepFocus = (e: MouseEvent) => e.preventDefault();
  return (
    <div className={['composer', className, shots.dropping && 'dropping', dictating(d) && 'dictating'].filter(Boolean).join(' ')} {...shots.drop}>
      <ShotStrip shots={shots} />
      {menuOn && <SkillMenu skills={menu} marked={marked} onPick={pick} />}
      <div className="c-field">
        {reply && <Quote q={reply.quote} onClear={() => setReply(key, null)} />}
        {chip}
        <textarea
          ref={field}
          value={text}
          placeholder={placeholder}
          rows={1}
          // while the menu is open, Escape closes it, not the card
          data-esc={menuOn || undefined}
          onFocus={() => {
            setFocused(true);
            if (obeya) api.warmVoice(true);
          }}
          onChange={(e) => setText(e.target.value)}
          onSelect={atCursor}
          onPaste={shots.onPaste}
          onBlur={() => {
            setFocused(false);
            space.blur();
          }}
          onKeyUp={space.keyUp}
          onKeyDown={(e) => {
            if (space.keyDown(e)) return;
            if (menuOn && slash && !e.nativeEvent.isComposing) {
              const n = menu?.length ?? 0;
              if (e.key === 'Escape') {
                e.preventDefault();
                return setDismissed(slash.start);
              }
              if (n && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                e.preventDefault();
                usedSkills();
                return setMarked((m) => (m + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
              }
              if (n && (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey))) {
                e.preventDefault();
                return pick(menu![Math.min(marked, n - 1)]!.name);
              }
            }
            if (enterSends && e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="c-tools" ref={tools}>
          <AttachButton shots={shots} />
          <DictateButton draft={key} field={field} />
          {action ? (
            <button className="btn primary c-send" disabled={!ready} onMouseDown={keepFocus} onClick={send}>
              {action}
            </button>
          ) : (
            <button className="btn primary c-send c-arrow" title={label} aria-label={label} disabled={!ready} onMouseDown={keepFocus} onClick={send}>
              <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
                <path d="M10 16V4M4.5 9.5 10 4l5.5 5.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
        </div>
      </div>
      {shots.error && <p className="p-error c-error">{shots.error}</p>}
      {dictationLine(d, key) ??
        (typeof obeya === 'string' ? (
          <div className="c-listener">→ {obeya}</div>
        ) : (
          focused && !!skillList?.length && !knowsSkills() && <div className="c-listener c-skills-hint">{t.skills.hint}</div>
        ))}
    </div>
  );
}

/**
 * The skills that fit the `/` word at the cursor, above the field: the marked one is picked with
 * Enter or Tab, another with the arrow keys or a click. `skills` undefined: they are still asked.
 */
function SkillMenu({ skills, marked, onPick }: { skills: Skill[] | undefined; marked: number; onPick: (name: string) => void }) {
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    list.current?.children[marked]?.scrollIntoView({ block: 'nearest' });
  }, [marked, skills]);
  return (
    <div className="skill-menu" role="listbox" aria-label={t.skills.menu}>
      {skills ? (
        <ul ref={list}>
          {skills.map((s, i) => (
            <li key={s.name} role="option" aria-selected={i === marked} className={i === marked ? 'on' : undefined} onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(s.name)}>
              <span className="sk-name">
                /{s.name}
                {s.hint && <span className="sk-hint"> {s.hint}</span>}
              </span>
              <span className="sk-desc">{s.description}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="sk-loading">{t.skills.loading}</p>
      )}
    </div>
  );
}
