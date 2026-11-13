// What the owner said or typed, on its way from a request to the open card's agent or the
// Coordinator: the recording heard (voice.ts), the card or place in view, and where the words go.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePlace } from '../core/layout';
import { holdsNotes } from '../core/queue';
import type { Item } from '../core/types';
import { agentListens } from '../core/card';
import type { CanvasRuntime } from './canvas';
import type { Focus, Heard, Input } from './commands';
import { hear, type Transcriber } from './voice';

/** Nothing the owner said came through: the recognition understood nothing (`null`), or heard nothing. */
export const unheard = (c: CanvasRuntime, text: string | null) => ({ confirm: text === null ? c.board.t.voice.notUnderstood : c.board.t.voice.nothingHeard, unheard: true });

/**
 * The recordings that arrived whole (`?sent=<id>`, the page's name for one): a page whose
 * connection broke before the answer asks here whether Obeya has the command, and gives the field
 * its words and screenshots back only when it has not. The newest few hundred; a restart forgets them.
 */
export class Arrived {
  private ids = new Set<string>();

  add(id: string | null) {
    if (!id) return;
    this.ids.add(id);
    for (const old of this.ids) if (this.ids.size > ARRIVED_KEPT) this.ids.delete(old);
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }
}

const ARRIVED_KEPT = 500;

/** The card or project in view, and where on the canvas the owner was: as the page says, else what it last had in view. */
export function focusOf(req: Request, c?: CanvasRuntime): Focus {
  const q = new URL(req.url).searchParams;
  const place = parsePlace(q.get('place')) ?? c?.inView;
  return { ...(q.get('card') ? { card: q.get('card')! } : {}), ...(q.get('project') ? { project: q.get('project')! } : {}), ...(place ? { place } : {}) };
}

/** What the owner said in a recording on canvas `c` (`hear`), with the canvas's card titles to recognise. */
export async function transcribe(transcriber: Transcriber, c: CanvasRuntime, audio: Blob): Promise<string | null> {
  const dir = mkdtempSync(join(tmpdir(), 'obeya-voice-'));
  // by what the browser recorded: a cloud service tells the format by the file's name
  const file = join(dir, `speech.${/mp4|m4a|aac/.test(audio.type) ? 'mp4' : /wav/.test(audio.type) ? 'wav' : /ogg/.test(audio.type) ? 'ogg' : 'webm'}`);
  try {
    await Bun.write(file, audio);
    return await hear(transcriber, file, c.commander.vocabulary(), c.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// a planned card takes what is typed into its field for the agent that will take it on; spoken
// words go to the Coordinator, which starts it, snoozes it or takes it out of the queue
export const listens = (card: Item, input: Input) => agentListens(card) || (input.field === 'note' && holdsNotes(card));

/**
 * What the owner said or typed: with an agent on the open card, straight to that agent (which
 * passes on what asks Obeya for something); else the Coordinator reads it. `null`: the recognition
 * heard nothing it could write down, which nobody should guess from.
 */
export async function heard(c: CanvasRuntime, text: string | null, focus: Focus, images: string[] = [], input: Input = {}) {
  // the owner sees only the confirmation; the transcript is for whoever reads the server's log
  console.log(`heard on ${c.id}: ${text === null ? '(not understood)' : text || '(nothing)'}`);
  // nothing heard or understood: screenshots shown with it stay in the browser for the next try
  if (text === null || (!text && !(input.typed && images.length))) return unheard(c, text);
  const card = focus.card ? c.board.item(focus.card) : undefined;
  if (card && listens(card, input)) {
    c.tell(card.id, text, images, !input.typed, typeof input.replyTo === 'number' ? input.replyTo : undefined, input.spot);
    // the card's conversation shows the words
    return { confirm: '', quiet: true } satisfies Heard;
  }
  const h = await c.commander.hear(text, focus, images, input);
  // the written confirmation goes out now, so the undo window starts now
  if (h.token) c.commander.arm(h.token);
  return { ...h, ...(h.token ? { undoMs: c.commander.delayMs } : {}) };
}
