import type { Database } from 'bun:sqlite';
import { type AnswerFile, type Talk, type TalkAfter, type TalkMoved, type TalkQuote, type TalkRef, type TalkWait } from '../core/types';
import type { Place } from '../core/layout';
import type { Wish } from '../core/wish';

/** The question the Coordinator looks up for an exchange, and the project it is about (null: none). */
export type TalkLookUp = { question: string; about: string | null };

/**
 * What an exchange with the Coordinator holds beside its words and reply (`Talk`): the card the
 * words were said on, the question looked up for them, their screenshots, the message they reply
 * to, the wait (`after`) or the answer (`answered`) the Coordinator took them up after, the project
 * sheet they were asked in.
 */
export type NewTalk = { card?: string | null; lookUp?: TalkLookUp; images?: string[]; replyTo?: TalkRef; after?: TalkAfter; askedIn?: string; answered?: number };

/**
 * How the Coordinator replies (`Sheet.reply`): the question it looks up, what a draft for Obeya's
 * makers starts from; `waits`: unread in the sheet until the owner sees it; `answers`: it answers
 * the words (not that it could not read them).
 */
export type TalkReply = { lookUp?: TalkLookUp; wish?: Wish; waits?: boolean; answers?: boolean };

/** Words the usage limit keeps the Coordinator from reading (`talk.held`): until when, and how it reads them then (`Commander`'s). */
export interface HeldTalk {
  until: string;
  reading: unknown;
}

/** A card the Coordinator waits on (`talk.waits`), and the step it said it takes once the card gets there. */
export interface TalkWaitRow extends TalkWait {
  then: string;
}

export const isTalkRef = (r: unknown): r is TalkRef =>
  !!r && typeof r === 'object' && Number.isInteger((r as TalkRef).talk) && ['said', 'reply', 'answer'].includes((r as TalkRef).part);

const now = () => new Date().toISOString();

/**
 * The Coordinator's memory of one canvas: its exchanges with the owner (the sheet, and the words said
 * on a card), the questions it looks up and their threads, and the commands that wait for "Undo".
 * `changed` runs after each write the owner sees.
 */
export class Sheet {
  constructor(
    private db: Database,
    private canvasId: string,
    private changed: () => void,
  ) {}

  /**
   * Records an exchange with the Coordinator, without its reply (`''`) while it reads the words;
   * returns its id.
   */
  add(said: string, reply: string, { card = null, lookUp, images = [], replyTo, after, askedIn, answered }: NewTalk = {}): number {
    const { id } = this.db
      .query(
        'INSERT INTO talk (canvas_id, at, said, reply, card_id, question, about, images, reply_to, after_wait, asked_in, after_answer) VALUES ($c, $at, $said, $reply, $cardId, $question, $about, $images, $replyTo, $after, $askedIn, $answered) RETURNING id',
      )
      .get({
        c: this.canvasId,
        at: now(),
        said,
        reply,
        cardId: card,
        question: lookUp?.question ?? null,
        about: lookUp?.about ?? null,
        images: images.length ? JSON.stringify(images) : null,
        replyTo: replyTo ? JSON.stringify({ talk: replyTo.talk, part: replyTo.part }) : null,
        after: after ? JSON.stringify(after) : null,
        askedIn: askedIn ?? null,
        answered: answered ?? null,
      }) as { id: number };
    this.changed();
    return id;
  }

  /** An exchange of no one's in the sheet, `reply` saying the card moved to another canvas. */
  addMoved(moved: TalkMoved, reply: string) {
    this.db.query("INSERT INTO talk (canvas_id, at, said, reply, moved) VALUES ($c, $at, '', $reply, $moved)").run({ c: this.canvasId, at: now(), reply, moved: JSON.stringify(moved) });
    this.changed();
  }

  /**
   * The Coordinator's reply to words it has read, the question it looks up for them, and what a draft
   * for Obeya's makers would start from; with `waits`, one for the sheet waits there unread, as an
   * answer that was looked up does.
   */
  reply(id: number, reply: string, { lookUp, wish, waits = false, answers = waits }: TalkReply = {}) {
    this.db
      .query('UPDATE talk SET reply = $reply, question = $question, about = $about, wish = $wish, unread = $waits AND card_id IS NULL AND card IS NULL, reply_only = $only WHERE id = $id')
      .run({ id, reply, question: lookUp?.question ?? null, about: lookUp?.about ?? null, wish: wish ? JSON.stringify(wish) : null, waits: waits ? 1 : 0, only: answers && !lookUp && !wish ? 1 : null });
    this.changed();
  }

  /**
   * Words the Coordinator was reading when Obeya stopped: they get `reply`; returns them. Words the
   * usage limit holds wait on; words asked in a project's sheet the Coordinator never reads.
   */
  interrupt(reply: string): Talk[] {
    const rows = this.db.query("SELECT * FROM talk WHERE canvas_id = $c AND reply = '' AND held IS NULL AND asked_in IS NULL ORDER BY id").all({ c: this.canvasId }) as TalkRow[];
    this.db.query("UPDATE talk SET reply = $reply WHERE canvas_id = $c AND reply = '' AND held IS NULL AND asked_in IS NULL").run({ c: this.canvasId, reply });
    if (rows.length) this.changed();
    return rows.map(toTalk);
  }

  /** Words the usage limit keeps the Coordinator from reading until `held.until`; `null` once it reads them. */
  hold(id: number, held: HeldTalk | null) {
    this.db.query('UPDATE talk SET held = $held WHERE id = $id').run({ id, held: held ? JSON.stringify(held) : null });
    this.changed();
  }

  /** The words the usage limit holds, oldest first: after a restart, the Coordinator reads them once it lifts. */
  held(): (Talk & { held: HeldTalk })[] {
    return (this.db.query('SELECT * FROM talk WHERE canvas_id = $c AND held IS NOT NULL ORDER BY id').all({ c: this.canvasId }) as TalkRow[]).map((r) => ({
      ...toTalk(r),
      held: JSON.parse(r.held!) as HeldTalk,
    }));
  }

  /** The cards the Coordinator waits on after the exchange's reply, to take a step once each gets there; none once it no longer waits on any. */
  wait(id: number, waits: TalkWaitRow[]) {
    this.db.query('UPDATE talk SET waits = $waits WHERE id = $id').run({ id, waits: waits.length ? JSON.stringify(waits) : null });
    this.changed();
  }

  /** The exchanges whose reply said the Coordinator waits on a card, oldest first. */
  waiting(): (Talk & { waiting: TalkWaitRow[] })[] {
    return (this.db.query('SELECT * FROM talk WHERE canvas_id = $c AND waits IS NOT NULL ORDER BY id').all({ c: this.canvasId }) as TalkRow[]).map((r) => ({
      ...toTalk(r),
      waiting: JSON.parse(r.waits!) as TalkWaitRow[],
    }));
  }

  /**
   * The step the Coordinator takes once the exchange's looked-up answer is in, and where the owner
   * was on the canvas when they asked for it; `null` once it has decided it.
   */
  step(id: number, then: string | null, place?: Place) {
    this.db.query('UPDATE talk SET then_step = $then, then_place = $place WHERE id = $id').run({ id, then, place: then !== null && place ? JSON.stringify(place) : null });
  }

  /** Looked-up answers that are in, oldest first, whose step the Coordinator has not decided yet: after a restart, it takes them up. */
  answeredSteps(): Talk[] {
    return (this.db.query('SELECT * FROM talk WHERE canvas_id = $c AND then_step IS NOT NULL AND answer IS NOT NULL ORDER BY id').all({ c: this.canvasId }) as TalkRow[]).map(toTalk);
  }

  undo(id: number) {
    this.db.query('UPDATE talk SET undone = 1 WHERE id = $id').run({ id });
    this.changed();
  }

  /** A command that waits for "Undo" until `due`, kept across a restart (`Commander`); `body` is what runs then. */
  holdCommand(token: string, due: number, body: unknown) {
    this.db
      .query('INSERT OR REPLACE INTO commands (token, canvas_id, due, body) VALUES ($token, $c, $due, $body)')
      .run({ token, c: this.canvasId, due: new Date(due).toISOString(), body: JSON.stringify(body) });
  }

  dropCommand(token: string) {
    this.db.query('DELETE FROM commands WHERE token = $token').run({ token });
  }

  /** The commands still waiting, oldest first: after a restart, those the stopped server held. */
  heldCommands(): { token: string; due: number; body: unknown }[] {
    return (this.db.query('SELECT token, due, body FROM commands WHERE canvas_id = $c ORDER BY due').all({ c: this.canvasId }) as { token: string; due: string; body: string }[]).map((r) => ({
      token: r.token,
      due: Date.parse(r.due),
      body: JSON.parse(r.body) as unknown,
    }));
  }

  /**
   * The answer to a looked-up question, with its files; one for the sheet (no card was open, and its
   * thread is on no Question card) waits there unread.
   */
  answer(id: number, answer: string, by: 'coordinator' | 'project', files: AnswerFile[] = []) {
    this.db
      .query('UPDATE talk SET answer = $answer, answer_by = $by, files = $files, unread = card_id IS NULL AND card IS NULL WHERE id = $id')
      .run({ id, answer, by, files: files.length ? JSON.stringify(files) : null });
    this.changed();
  }

  /** The files an exchange shows while its answer is still being looked up: the walkthrough it plays as it is told. */
  showFiles(id: number, files: AnswerFile[]) {
    this.db.query('UPDATE talk SET files = $files WHERE id = $id').run({ id, files: files.length ? JSON.stringify(files) : null });
    this.changed();
  }

  /** A follow-up continues the answer `follows`, in the thread `thread`. */
  follow(id: number, thread: number, follows: number) {
    this.db.query('UPDATE talk SET thread = $thread, follows = $follows WHERE id = $id').run({ id, thread, follows });
    this.changed();
  }

  /**
   * The owner's words of `into` went into the look-up of `ids`, still running: its answer stands
   * under `into` and answers them all. With `session`, the look-up's, which a follow-up on that
   * answer resumes.
   */
  join(ids: number[], into: number, session?: string) {
    this.db.query('UPDATE talk SET joined = $into, files = NULL WHERE id IN (SELECT value FROM json_each($ids))').run({ ids: JSON.stringify(ids), into });
    if (session) this.lookedUpIn(into, session);
    this.changed();
  }

  /** The session of the agent that looks the exchange's question up. */
  lookedUpIn(id: number, session: string) {
    this.db.query('UPDATE talk SET session_id = $session WHERE id = $id').run({ id, session });
  }

  /** The exchanges of a thread, oldest first, with the session each was looked up in. */
  thread(thread: number): (Talk & { about?: string; session?: string })[] {
    return (this.db.query('SELECT * FROM talk WHERE canvas_id = $c AND (id = $t OR thread = $t) ORDER BY id').all({ c: this.canvasId, t: thread }) as TalkRow[]).map((r) => ({
      ...withContinues(this.db, r),
      ...(r.about ? { about: r.about } : {}),
      ...(r.session_id ? { session: r.session_id } : {}),
    }));
  }

  /** The thread moved onto a Question card: its exchanges, and every follow-up asked later, are answered there. */
  moveThread(thread: number, card: string) {
    this.db.query('UPDATE talk SET card = $card, unread = 0 WHERE canvas_id = $c AND (id = $t OR thread = $t)').run({ c: this.canvasId, t: thread, card });
    this.changed();
  }

  /** The owner has the sheet in view, or (`ids`) those exchanges in a project's sheet. */
  read(ids?: number[]) {
    const read = ids
      ? this.db.query('UPDATE talk SET unread = 0 WHERE canvas_id = $c AND unread = 1 AND id IN (SELECT value FROM json_each($ids))').run({ c: this.canvasId, ids: JSON.stringify(ids) })
      : this.db.query('UPDATE talk SET unread = 0 WHERE canvas_id = $c AND unread = 1').run({ c: this.canvasId });
    if (read.changes > 0) this.changed();
  }

  /**
   * The latest exchanges of the threads about any of `about` (a project and its workstreams), oldest
   * first: those its project agent answers.
   */
  about(about: string[], limit = 100): Talk[] {
    return (
      this.db
        .query(
          `SELECT t.* FROM talk t JOIN talk r ON r.id = COALESCE(t.thread, t.id)
           WHERE t.canvas_id = $c AND r.about IN (SELECT value FROM json_each($about)) ORDER BY t.id DESC LIMIT $limit`,
        )
        .all({ c: this.canvasId, about: JSON.stringify(about), limit }) as TalkRow[]
    )
      .reverse()
      .map((r) => withContinues(this.db, r));
  }

  /** The latest exchanges, oldest first; with `withoutCard`, only those without an open card. */
  latest(limit = 20, withoutCard = false): Talk[] {
    return (
      this.db.query(`SELECT * FROM talk WHERE canvas_id = $c${withoutCard ? ' AND card_id IS NULL' : ''} ORDER BY id DESC LIMIT $limit`).all({ c: this.canvasId, limit }) as TalkRow[]
    )
      .reverse()
      .map((r) => withContinues(this.db, r));
  }

  /** The message of the sheet `ref` names (an exchange with no card open), if it is one the owner can reply to there. */
  quote(ref: unknown): TalkQuote | undefined {
    if (!isTalkRef(ref)) return;
    const sheet = this.db.query('SELECT 1 FROM talk WHERE id = $id AND canvas_id = $c AND card_id IS NULL').get({ id: ref.talk, c: this.canvasId });
    return sheet ? quotedTalk(this.db, ref) : undefined;
  }

  /** The latest exchange on the card whose reply is `reply`: the one a reply in the card's log stands for. */
  cardReply(cardId: string, reply: string): number | undefined {
    return (this.db.query('SELECT id FROM talk WHERE card_id = $c AND reply = $reply ORDER BY id DESC LIMIT 1').get({ c: cardId, reply }) as { id: number } | null)?.id;
  }

  /** One exchange, with the card its question is about. */
  exchange(id: number): (Talk & { about?: string; thenPlace?: Place }) | null {
    const r = this.db.query('SELECT * FROM talk WHERE id = $id').get({ id }) as TalkRow | null;
    return r ? { ...withContinues(this.db, r), ...(r.about ? { about: r.about } : {}), ...(r.then_place ? { thenPlace: JSON.parse(r.then_place) as Place } : {}) } : null;
  }

  /** Questions the Coordinator is still looking up, oldest first. */
  lookingUp(): number[] {
    return (this.db.query('SELECT id FROM talk WHERE canvas_id = $c AND question IS NOT NULL AND answer IS NULL AND joined IS NULL ORDER BY id').all({ c: this.canvasId }) as { id: number }[]).map((r) => r.id);
  }
}

interface TalkRow {
  id: number;
  at: string;
  said: string;
  reply: string;
  card_id: string | null;
  undone: number;
  question: string | null;
  about: string | null;
  answer: string | null;
  answer_by: 'coordinator' | 'project' | null;
  images: string | null;
  unread: number;
  session_id: string | null;
  thread: number | null;
  follows: number | null;
  joined: number | null;
  files: string | null;
  card: string | null;
  reply_to: string | null;
  wish: string | null;
  held: string | null;
  waits: string | null;
  after_wait: string | null;
  asked_in: string | null;
  moved: string | null;
  then_step: string | null;
  after_answer: number | null;
  then_place: string | null;
  reply_only: number | null;
}

const toTalk = (r: TalkRow): Talk => ({
  id: r.id,
  at: r.at,
  said: r.said,
  // empty while the Coordinator reads the words
  ...(r.reply ? { reply: r.reply } : {}),
  ...(r.card_id ? { cardId: r.card_id } : {}),
  ...(r.undone ? { undone: true } : {}),
  ...(r.question ? { question: r.question } : {}),
  ...(r.answer !== null ? { answer: r.answer } : {}),
  ...(r.answer_by ? { answerBy: r.answer_by } : {}),
  ...(r.unread ? { unread: true } : {}),
  ...(r.images ? { images: JSON.parse(r.images) as string[] } : {}),
  // a looked-up question is a thread of its own until it follows up on one
  ...(r.question ? { thread: r.thread ?? r.id } : {}),
  ...(r.follows ? { follows: r.follows } : {}),
  ...(r.joined ? { joinedInto: r.joined } : {}),
  ...(r.files ? { files: JSON.parse(r.files) as AnswerFile[] } : {}),
  ...(r.card ? { movedTo: r.card } : {}),
  ...(r.wish ? { wish: JSON.parse(r.wish) as Wish } : {}),
  ...(r.held ? { heldUntil: (JSON.parse(r.held) as HeldTalk).until } : {}),
  ...(r.waits ? { waits: (JSON.parse(r.waits) as TalkWaitRow[]).map(({ card, title, state }) => ({ card, title, state })) } : {}),
  ...(r.after_wait ? { after: JSON.parse(r.after_wait) as TalkAfter } : {}),
  ...(r.asked_in ? { askedIn: r.asked_in } : {}),
  ...(r.moved ? { moved: JSON.parse(r.moved) as TalkMoved } : {}),
  ...(r.then_step ? { then: r.then_step } : {}),
  ...(r.after_answer ? { answered: r.after_answer } : {}),
  ...(r.reply_only ? { replyOnly: true } : {}),
});

/**
 * An exchange with the question of the answer it continues, when it follows up on one (whether its
 * words went into that look-up while it ran), and the
 * message of the sheet it replies to, when it does.
 */
function withContinues(db: Database, r: TalkRow): Talk {
  const followed = r.follows ? (db.query('SELECT question, joined FROM talk WHERE id = $id').get({ id: r.follows }) as { question: string | null; joined: number | null } | null) : null;
  const replyTo = r.reply_to ? quotedTalk(db, JSON.parse(r.reply_to) as TalkRef) : undefined;
  return { ...toTalk(r), ...(followed?.question ? { continues: followed.question, ...(followed.joined ? { addsTo: true as const } : {}) } : {}), ...(replyTo ? { replyTo } : {}) };
}

/** A message of the sheet as a reply quotes it; none where the exchange or its part is gone. */
function quotedTalk(db: Database, ref: TalkRef): TalkQuote | undefined {
  const r = db.query('SELECT said, reply, answer, answer_by FROM talk WHERE id = $id').get({ id: ref.talk }) as Pick<TalkRow, 'said' | 'reply' | 'answer' | 'answer_by'> | null;
  const text = r?.[ref.part];
  if (!r || !text) return;
  return { talk: ref.talk, part: ref.part, by: ref.part === 'said' ? 'owner' : ref.part === 'answer' ? (r.answer_by ?? 'coordinator') : 'coordinator', text };
}
