// What the owner says or types reaches its target, and what they are told back, the same on the
// canvas and in the phone view: the confirmation with „Rückgängig“ above the microphone, words
// handed on to the agent of the open card or to the Koordinator, and what the microphone says it
// speaks to.

import { useRef, useState } from 'react';
import type { Place } from '../core/layout';
import { agentListens, type Item, type TalkRef } from '../core/types';
import { Aside } from './aside';
import { api, ApiError, type Field, type Heard, type Where } from './api';
import { clip } from '../core/text';
import { excerpt, plain } from './markdown';
import { sent, take, videoOf } from './spot';
import { failText, t } from './strings';
import type { useTold } from './voice';

/** How long a confirmation stays, and its „Rückgängig“ unless the action waits longer. */
export const ACK_MS = 7000;

/**
 * The confirmation above the microphone: `showAck` with „Rückgängig“ while the action still waits,
 * `showWait` for what the server is still at, `fail` for what went wrong; `line` shows it. With
 * `aside` (the phone) the owner swipes it away.
 */
export function useAck(aside = false) {
  const [ack, setAck] = useState<{ text: string; undo?: () => unknown; wait?: boolean } | null>(null);
  const [ackOn, setAckOn] = useState(false);
  const ackTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const undoTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  /** A confirmation; with `undo`, "Rückgängig" shows for `undoMs` (while the server still waits). */
  function showAck(text: string, undo?: () => unknown, undoMs = ACK_MS) {
    setAck({ text, undo });
    setAckOn(true);
    clearTimeout(ackTimer.current);
    clearTimeout(undoTimer.current);
    if (undo) undoTimer.current = setTimeout(() => setAck((a) => (a && a.text === text ? { text } : a)), Math.max(0, undoMs - 400));
    ackTimer.current = setTimeout(() => setAckOn(false), ACK_MS);
  }
  /** What went wrong, in place of the confirmation; what the server did not refuse also goes to the console. */
  function fail(e: unknown) {
    if (!(e instanceof ApiError)) console.error(e);
    showAck(failText(e));
  }
  /** What the server is still at: stays, turning, until a confirmation takes its place. */
  function showWait(text: string) {
    setAck({ text, wait: true });
    setAckOn(true);
    clearTimeout(ackTimer.current);
    clearTimeout(undoTimer.current);
  }
  function gone() {
    setAckOn(false);
    clearTimeout(ackTimer.current);
    clearTimeout(undoTimer.current);
  }
  const line = (
    <Aside id="ack" on={aside} onGone={gone} className={`ack${ackOn ? ' on' : ''}${ack?.wait ? ' wait' : ''}`}>
      <span>{ack?.text}</span>
      {ack?.undo && (
        <button
          onClick={() => {
            ack.undo?.();
            setAckOn(false);
          }}
        >
          {t.undo}
        </button>
      )}
    </Aside>
  );
  return { showAck, showWait, fail, line };
}

/**
 * A notice as the line above the microphone shows it: an answer looked up comes in Markdown, the
 * line shows it plain, on one line and cut short; the sheet or the card has it in full.
 */
export const noticeLine = (text: string) => clip(excerpt(text), 300);

/**
 * Hands words on: `byId` finds the cards they may be about, `told` keeps each command's line above
 * the microphone, `fail` says what went wrong, `place` is where a card a command makes goes.
 */
export function tellers(byId: (id: string) => Item | undefined, told: ReturnType<typeof useTold>, fail: (e: unknown) => void, place: () => Place | undefined) {
  /** The card `target` names, if any. */
  const cardIn = (target: Where) => (target && 'card' in target ? byId(target.card) : undefined);
  /** The card in `target` when an agent listens on it: what the owner says there goes straight to that agent. */
  const listening = (target: Where) => {
    const i = cardIn(target);
    return i && agentListens(i) ? i : undefined;
  };
  /** The card a command for `target` is about, named in its confirmation when another card is open by then. */
  const toldCard = (target: Where) => {
    const i = cardIn(target);
    return i ? { id: i.id, title: plain(i.title) } : undefined;
  };
  /**
   * Hands a spoken command for `target` on, with its line above the microphone: while Whisper writes
   * it down for the open card's agent, or while the Koordinator reads it.
   */
  const tellAbout = (target: Where, request: () => Promise<Heard>) => {
    const i = target ? byId('card' in target ? target.card : target.project) : undefined;
    const what = i ? `„${plain(i.title)}“` : t.voice.koordinator;
    return told.tell(listening(target) ? t.voice.transcribing(what) : t.voice.reading(what), toldCard(target), request);
  };
  /**
   * Words typed on a card, in its idea or in the Koordinator's conversation: on a card an agent listens on
   * they go straight to it, else the Koordinator reads them like spoken ones. The conversation shows
   * them at once either way; above the mic only the Koordinator's confirmation shows, with „Rückgängig“.
   */
  const tellTyped = async (text: string, images: string[] | undefined, target: Where, field?: Field, replyTo?: number | TalkRef) => {
    if (listening(target))
      try {
        // typed while the card's demo video stands at a place: about that place, and the video plays on
        const taken = target && 'card' in target ? take(target.card) : null;
        if (taken) videoOf((target as { card: string }).card)?.play().catch(() => {});
        await api.command(text, target, { images, field, replyTo, spot: await sent(taken) });
      } catch (e) {
        fail(e);
      }
    else {
      const at = place();
      void told.tell(null, toldCard(target), () => api.command(text, target, { images, field, replyTo, ...(at ? { place: at } : {}) }));
    }
  };
  return { listening, tellAbout, tellTyped };
}

/** Whom the microphone speaks to: the open card (its agent, where one listens), the open project, or the Koordinator. */
export function voiceTarget(open: { type: 'card' | 'project'; item?: Item } | null): string {
  const i = open?.item;
  const title = plain(i?.title ?? '');
  if (open?.type === 'project') return t.voice.project(title);
  if (open?.type !== 'card') return t.voice.koordinator;
  if (!i || !agentListens(i)) return t.voice.card(title);
  return (i.kind === 'question' ? t.voice.question : i.state === 'idea' ? t.voice.idea : i.state === 'proposal' ? t.voice.proposal : t.voice.agent)(title);
}
