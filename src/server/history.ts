import type { Database } from 'bun:sqlite';
import type { CardEvent, CardState } from '../core/types';

/**
 * Where the cards' history stood when it was read: the time, and the latest event and card then.
 * What is written later has a larger id, even within the same millisecond or once the clock went back.
 */
export interface Mark {
  at: string;
  event: number;
  card: number;
}

/** A step in a card's history, as the Coordinator reads it; `created` marks a card of the owner's or a proposal. */
export interface Moment {
  at: string;
  cardId: string;
  kind: CardEvent['kind'] | 'created';
  author: CardEvent['author'];
  text: string;
}

/** Something the owner said: to an agent (`hint` a note or feedback, `answer`), in an idea (`talk`), to the Coordinator (`say`). */
export interface Utterance {
  at: string;
  kind: 'hint' | 'answer' | 'talk' | 'say';
  text: string;
  cardId?: string;
  title?: string;
}

/** The kinds of a card's log lines that are milestones of its history (`timeline`), as its index lists them. */
const MILESTONES = "('state', 'question', 'answer', 'review', 'hint', 'error')";

/** What happened on one canvas, as the Coordinator and the learner read it back: the cards' history and what the owner said and decided. */
export class History {
  constructor(
    private db: Database,
    private canvasId: string,
  ) {}

  /**
   * How the cards got where they are, after `since` (ISO time), oldest first: their milestones
   * (state changes, questions, answers, hand-overs, the owner's notes, errors) and the creation of
   * cards that come from no plan doc. Deleted cards are left out. After a mark, also what was written
   * since it, whatever its time; its time still counts, for an event that takes up the id of one the
   * owner deleted.
   */
  timeline(since: string | Mark, limit: number): Moment[] {
    const m = typeof since === 'string' ? { at: since, event: Number.MAX_SAFE_INTEGER, card: Number.MAX_SAFE_INTEGER } : since;
    return (
      this.db
        .query(
          // within one millisecond, cards are created before anything happens to them, each in the order
          // it was written; each part reads its newest `limit` through an index, so what the history
          // holds before them is not read
          `SELECT at, cardId, kind, author, text FROM (
             SELECT * FROM (SELECT e.at, e.card_id AS cardId, e.kind, e.author, e.text, 1 AS phase, e.id AS seq FROM events e CROSS JOIN cards c ON c.id = e.card_id
               WHERE e.kind IN ${MILESTONES} AND e.at > $since AND c.canvas_id = $c AND c.deleted_at IS NULL ORDER BY e.at DESC, e.id DESC LIMIT $limit)
             UNION ALL
             -- written after the mark with an earlier time
             SELECT * FROM (SELECT e.at, e.card_id AS cardId, e.kind, e.author, e.text, 1 AS phase, e.id AS seq FROM events e CROSS JOIN cards c ON c.id = e.card_id
               WHERE e.id > $event AND +e.at <= $since AND +e.kind IN ${MILESTONES} AND c.canvas_id = $c AND c.deleted_at IS NULL ORDER BY e.at DESC, e.id DESC LIMIT $limit)
             UNION ALL
             SELECT * FROM (SELECT created_at AS at, id AS cardId, 'created' AS kind, CASE WHEN from_id IS NULL THEN 'owner' ELSE 'worker' END AS author, '' AS text, 0 AS phase, rowid AS seq FROM cards
               WHERE canvas_id = $c AND created_at > $since AND deleted_at IS NULL AND plan_ref IS NULL ORDER BY created_at DESC, rowid DESC LIMIT $limit)
             UNION ALL
             SELECT * FROM (SELECT created_at AS at, id AS cardId, 'created' AS kind, CASE WHEN from_id IS NULL THEN 'owner' ELSE 'worker' END AS author, '' AS text, 0 AS phase, rowid AS seq FROM cards
               WHERE rowid > $card AND +created_at <= $since AND +canvas_id = $c AND deleted_at IS NULL AND +plan_ref IS NULL ORDER BY created_at DESC, rowid DESC LIMIT $limit)
           ) ORDER BY at DESC, phase DESC, seq DESC LIMIT $limit`,
        )
        .all({ c: this.canvasId, since: m.at, event: m.event, card: m.card, limit }) as Moment[]
    ).reverse();
  }

  /** Where the cards' history stands now, for `timeline` to go on from. */
  mark(): Mark {
    const { event, card } = this.db
      .query('SELECT (SELECT COALESCE(MAX(id), 0) FROM events) AS event, (SELECT COALESCE(MAX(rowid), 0) FROM cards) AS card')
      .get() as { event: number; card: number };
    return { at: new Date().toISOString(), event, card };
  }

  /**
   * What the owner said after `since` (ISO time), oldest first, at most the latest `limit`: notes,
   * feedback and answers to agents, an idea's discussion, and what they said to the Coordinator
   * (unless taken back).
   */
  utterances(since: string, limit: number): Utterance[] {
    return (
      this.db
        .query(
          `SELECT at, cardId, title, kind, text FROM (
             SELECT * FROM (SELECT e.at, e.card_id AS cardId, c.title, e.kind, e.text, e.id AS seq FROM events e CROSS JOIN cards c ON c.id = e.card_id
               WHERE e.author = 'owner' AND e.kind IN ('hint', 'answer', 'talk') AND e.at > $since AND c.canvas_id = $c ORDER BY e.at DESC, e.id DESC LIMIT $limit)
             UNION ALL
             SELECT * FROM (SELECT t.at, t.card_id AS cardId, c.title, 'say' AS kind, t.said AS text, t.id AS seq FROM talk t LEFT JOIN cards c ON c.id = t.card_id
               WHERE t.canvas_id = $c AND t.undone = 0 AND t.after_wait IS NULL AND t.after_answer IS NULL AND t.moved IS NULL AND t.at > $since ORDER BY t.at DESC, t.id DESC LIMIT $limit)
           ) ORDER BY at DESC, seq DESC LIMIT $limit`,
        )
        .all({ c: this.canvasId, since, limit }) as { at: string; cardId: string | null; title: string | null; kind: Utterance['kind']; text: string }[]
    )
      .reverse()
      .map((r) => ({ at: r.at, kind: r.kind, text: r.text, ...(r.cardId ? { cardId: r.cardId } : {}), ...(r.title ? { title: r.title } : {}) }));
  }

  /** Proposals the owner accepted or rejected after `since` (ISO time), oldest first. */
  decidedProposals(since: string): { at: string; text: string; state: 'active' | 'rejected' | 'filed'; quote?: string; target?: string }[] {
    return (
      this.db
        .query(`SELECT decided_at AS at, text, state, quote, target FROM preferences WHERE canvas_id = $c AND decided_at > $since ORDER BY decided_at`)
        .all({ c: this.canvasId, since }) as { at: string; text: string; state: 'active' | 'rejected' | 'filed'; quote: string | null; target: string | null }[]
    ).map(({ quote, target, ...r }) => ({ ...r, ...(quote ? { quote } : {}), ...(target ? { target } : {}) }));
  }

  /**
   * Cards of the owner's deleted after `since` (ISO time), oldest first, with the state they had: a
   * worker's proposal the owner dismissed, say. Plan cards go with their plan doc, not by a click.
   */
  removed(since: string): { at: string; title: string; state: CardState }[] {
    // a proposal its agent withdrew went without the owner
    return this.db
      .query(
        `SELECT deleted_at AS at, title, COALESCE(state, 'planned') AS state FROM cards WHERE canvas_id = $c AND plan_ref IS NULL AND deleted_at > $since
         AND NOT (state = 'proposal' AND json_extract(proposal, '$.superseded') IS NOT NULL) ORDER BY deleted_at`,
      )
      .all({ c: this.canvasId, since }) as { at: string; title: string; state: CardState }[];
  }
}
