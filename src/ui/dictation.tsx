// Dictating into a text field, the same in every field that takes it: Space held in the field (or
// the field's microphone) records, and the words go in at the cursor; the field is framed while it
// is spoken into, and a line under it says what happens. The field is a draft's (`useDraftField`),
// so the recording knows where its words go.

import { type KeyboardEvent, type RefObject, useContext, useEffect, useId, useRef } from 'react';
import { type Draft, dropDraft, sendsWithEnter, typeInto, useDraft, useDraftField } from './draft';
import { t } from './strings';
import { HoldToTalk, MicIcon, TAP_MS, useHeldByTouch } from './voice';

/**
 * How long Space stays down before it is held to speak rather than typed. Typing presses it for
 * well under this, and a key pressed meanwhile (fast typing overlaps keys) makes it a typed space at once.
 */
const HOLD_MS = 250;

/**
 * Space pressed in `field`: typed, or held to speak once it stays down. The field's handlers for
 * keys and blur; `keyDown` says whether it took the key, which then does nothing else. Where nobody
 * listens (no `HoldToTalk`), Space is typed as always.
 */
export function useSpaceToTalk(field: RefObject<HTMLTextAreaElement | null>) {
  const talk = useContext(HoldToTalk);
  // Space down: typed when let go soon, or held to speak once it stays down (`held`)
  const space = useRef<number | 'held' | null>(null);
  const spaceDown = useRef(0);
  // While Space is down the field is read-only: the browser on the Mac hides the pointer at every key
  // pressed into a text field, so the key repeating while held made it flicker as the mouse moved.
  const spaceUp = () => {
    space.current = null;
    if (field.current) field.current.readOnly = false;
  };
  const typeSpace = () => {
    const s = space.current;
    if (s === null || s === 'held') return;
    clearTimeout(s);
    spaceUp();
    if (field.current) typeInto(field.current, ' ');
  };
  return {
    keyDown(e: KeyboardEvent<HTMLTextAreaElement>): boolean {
      if (talk && e.code === 'Space' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.nativeEvent.isComposing) {
        // the key repeating while held types nothing
        if (space.current !== null) {
          e.preventDefault();
          return true;
        }
        if (!e.repeat) {
          e.preventDefault();
          e.currentTarget.readOnly = true;
          spaceDown.current = e.timeStamp;
          space.current = window.setTimeout(() => {
            space.current = 'held';
            talk();
          }, HOLD_MS);
        }
        return true;
      }
      // another key while Space is down: Space was typed, before it
      typeSpace();
      return false;
    },
    keyUp(e: KeyboardEvent<HTMLTextAreaElement>) {
      if (e.code !== 'Space') return;
      // a held Space ends the recording wherever it is let go (App); too short for one, it was typed
      if (space.current !== 'held') return typeSpace();
      spaceUp();
      if (e.timeStamp - spaceDown.current < HOLD_MS + TAP_MS && field.current) typeInto(field.current, ' ');
    },
    blur() {
      if (typeof space.current === 'number') clearTimeout(space.current);
      spaceUp();
    },
  };
}

/** Whether the draft's field is being spoken into, or what was said is being written down: the field is framed meanwhile. */
export const dictating = (d: Draft) => d.dictation !== '';

/** The line under the field of draft `key` about its dictation, or null when there is none to show. */
export function dictationLine({ dictation, note }: Draft, key: string) {
  if (dictation === 'listening') {
    const enter = sendsWithEnter(key) && t.voice.sendWithEnter;
    return (
      <div className="c-listener c-dictation">
        → <b>{t.voice.intoField}</b>
        {enter && ` · ${enter}`}
      </div>
    );
  }
  if (dictation === 'writing') return <div className="c-listener c-dictation">{t.voice.writing}</div>;
  if (note) return <div className="c-listener c-note">{note}</div>;
  return null;
}

/** The line under the field of draft `draft` about its dictation. */
export function DictationLine({ draft }: { draft: string }) {
  return dictationLine(useDraft(draft), draft);
}

/** The microphone in a field: held, what is said goes into the field at its cursor. */
export function DictateButton({ draft, field }: { draft: string; field: RefObject<HTMLTextAreaElement | null> }) {
  const talk = useContext(HoldToTalk);
  const mic = useHeldByTouch<HTMLButtonElement>();
  const { dictation } = useDraft(draft);
  if (!talk) return null;
  return (
    <button
      ref={mic}
      className={dictation === 'listening' ? 'c-mic on' : 'c-mic'}
      title={t.voice.dictate}
      aria-label={t.voice.dictate}
      onPointerDown={(e) => {
        // the cursor stays in the field, or goes there: what is said is written into it
        e.preventDefault();
        field.current?.focus();
        talk();
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <MicIcon size={18} />
    </button>
  );
}

/**
 * Dictation for a text field whose text is its own (a rule's, say) rather than a draft's: the field
 * gets a draft of its own for the dictation while it is on the page. `sends`: whether Enter takes
 * what is written. Its handlers go on the field, its `key` to `DictationLine`.
 */
export function useDictatedField(field: RefObject<HTMLTextAreaElement | null>, sends: boolean) {
  const key = `field:${useId()}`;
  useDraftField(key, () => field.current, false, true, sends);
  useEffect(() => () => dropDraft(key), [key]);
  const space = useSpaceToTalk(field);
  return { key, dictating: dictating(useDraft(key)), ...space };
}
