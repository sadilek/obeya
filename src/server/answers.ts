// Questions the Coordinator looks up: what it cannot answer in its quick reading of a command (what
// an agent would do on a card, what the plan says, what a release holds) goes to an agent with a
// worker's tools that takes the time to read and check.
// A workstream's question goes to its project agent, any other to a thorough Coordinator turn. The
// answer comes later: in full in the log of the card that was open (else in the Coordinator's
// sheet), and summed up aloud.
// A look-up starts a thread: a follow-up on its answer resumes the same agent, which still has all
// it read and computed, and the thread's output directory holds the files its answers come with.
// The owner can move a thread onto a Question card of its own, where their words go straight to
// that agent.

import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import { oneAtATime } from '../core/one-at-a-time';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { type AnswerFile, type AnswerRef, type CardEvent, type Item, pausable, pausableNow, type Talk, type TalkRef } from '../core/types';
import { type Briefing, INFORM_RULES, inform, Interrupted, type OwnerAnswer } from './advisor';
import { BadRequest, type Board, notPaused, pauseRefused, replyNote } from './board';
import { imageNote } from './images';
import type { ProjectAgents } from './project-agents';
import type { AgentRuntime } from './runtime';
import { TO_OBEYA, toObeyaTool } from './to-obeya';
import { describeTool, SPOKEN } from './agent-lines';
import { clip, messageOf } from '../core/text';
import { AnswerWalkthrough, prepareWalkthrough, readWalkthrough, type Told, type Voicing, WALKTHROUGH_RULES, writtenIn } from './walkthrough';
import { isWalkthrough, type Walkthrough } from '../core/walkthrough';

export interface AnswerOptions {
  board: Board;
  runtime: AgentRuntime;
  /** The checkout the answer is read from: the card's repository, or the canvas's home. */
  pathFor: (card: Item | undefined) => string;
  /** The task the card's worker gets at its start. */
  startBrief: (card: Item) => string | undefined;
  /** The project agent of a project answers what is asked about it and its workstreams. */
  projectAgent: (project: Item) => Pick<ProjectAgents, 'inform'>;
  /** A thread's output directory, outside every repository. */
  dirOf: (thread: number) => string;
  /** The files of the owner's screenshots, by id; unknown ones are left out. */
  imageFiles?: (ids?: string[]) => string[];
  preferences?: () => string;
  /** The workers' permission mode, which the answering Coordinator turn runs in too. */
  permissionMode?: PermissionMode;
  /** The answer to an exchange is in: the Coordinator hears it with the owner's next command. */
  onAnswer?: (talk: number, question: string, answer: string) => void;
  /** Passes on what the owner's words on a Question card ask of Obeya (`to_obeya`). */
  toObeya?: (cardId: string, request: string) => Promise<string>;
  /** The voice of walkthroughs: without it, answers come as text only. */
  voicing?: Voicing;
}

/** Log lines of a card the answering agent reads. */
const LOG_LINES = 25;

type Exchange = Talk & { about?: string; session?: string };
type By = 'coordinator' | 'project';

/** What "Show as walkthrough" asked for: the walkthrough's thread and file, which the page that clicked plays once it can. */
export interface Asked {
  thread: number;
  file: string;
}

export class Answers {
  /** "Show as walkthrough": the walkthrough each exchange asked for, shown before its first slide. */
  private prepared = new Map<number, Told>();
  /** The same on a Question card: by the owner's words that asked for it. */
  private preparedOn = new Map<number, Told>();
  /** Exchanges being looked up, so a resume does not ask twice. */
  private busy = new Set<number>();
  /** The turns of each thread, one after the other: two never run in one session at once. */
  private turns = new Map<number, Promise<unknown>>();
  /** Question cards whose agent is in a turn: what the owner asks meanwhile waits for the next, unread until then. */
  private reading = new Set<string>();
  /**
   * Question cards whose agent waits for its background work in a turn, each with what passes the
   * owner's words still pending into its session at once: the turn's answer answers them too.
   */
  private waiting = new Map<string, () => void>();
  /** Ends the running turn of a Question card's agent, for the owner's pause. */
  private turnEnds = new Map<string, AbortController>();
  /** Question cards whose agent the owner let go on after a pause: its next turn hears so. */
  private resumed = new Set<string>();

  constructor(private o: AnswerOptions) {}

  /** Looks up the question of an exchange with the Coordinator; a follow-up goes on in its thread. */
  lookUp(talkId: number) {
    if (this.busy.has(talkId)) return;
    const t = this.o.board.sheet.exchange(talkId);
    if (!t?.question || t.answer !== undefined) return;
    const thread = t.thread ?? t.id;
    const root = thread === t.id ? t : (this.o.board.sheet.exchange(thread) ?? t);
    // a thread on a Question card goes on there, with the card's agent
    const card = root.movedTo ? this.o.board.item(root.movedTo) : undefined;
    if (card?.kind === 'question') {
      if (!t.movedTo) this.o.board.sheet.moveThread(thread, card.id);
      if (!(this.o.board.thread(card.id).pending ?? []).some((p) => p.talk === talkId)) this.ask(card.id, t.said, { images: this.o.imageFiles?.(t.images), spoken: true, talk: talkId });
      return;
    }
    this.busy.add(talkId);
    // a walkthrough the look-up began before a restart: the one it tells now takes its place
    const prepared = this.prepared.get(talkId);
    if (t.files?.length && !prepared) this.o.board.sheet.showFiles(talkId, []);
    const { by, about, project } = this.agentFor(root);
    const reading = t.cardId && this.o.board.item(t.cardId) ? t.cardId : undefined;
    // what it reads shows on the open card, as an exploration agent's reading does
    const onTool = (name: string, input: Record<string, unknown>) => {
      if (reading && !name.startsWith('mcp__')) this.o.board.log(reading, 'activity', by, describeTool(name, input, this.o.board.t));
    };
    const follow = t.id !== thread;
    // the session of the answer it continues, else the thread's latest; a thread moved onto a card that is gone has the card's
    const resume = follow ? (this.o.board.sheet.thread(thread).findLast((x) => x.session && x.id <= (t.follows ?? t.id))?.session ?? this.cardSession(root)) : undefined;
    // looked up for an action: Obeya takes it with the answer, which brings what it needs
    const step = t.then ? `\n\nObeya takes this step itself once your answer is in: ${t.then}\nYour answer gives what the step needs.` : '';
    const fresh = `${this.message(root.said, root.question!, about, project, root.askedIn)}${follow ? '' : step}`;
    // written in the project's sheet: Obeya did not read the words, so the agent passes on what asks Obeya
    const asked = t.askedIn ? { images: this.o.imageFiles?.(t.images) ?? [], from: t.askedIn } : undefined;
    this.queue(thread, () =>
      this.consult({
        thread,
        by,
        about,
        project,
        ...(asked ? { asked } : {}),
        onTool,
        onSession: (id) => this.o.board.sheet.lookedUpIn(talkId, id),
        // under the question while the agent tells on, and in the log of the card it was asked on
        onShown: (files) => {
          this.o.board.sheet.showFiles(talkId, files);
          if (reading) this.showLive(reading, 'say', by, thread, files);
        },
        ...(prepared ? { prepared } : {}),
        // under the question in the sheet, and in the conversation of the card it was asked on
        onLimit: (until) => {
          this.o.board.waitsForLimit({ talk: talkId }, until);
          if (reading && until !== undefined) this.o.board.log(reading, 'state', 'obeya', this.o.board.t.answer.limited(this.o.board.t.when(until)));
        },
        ...(follow
          ? {
              resume,
              message: `${followUp(t.said, t.askedIn ? undefined : t.question, false)}${step}`,
              fallback: () => ({ message: `${fresh}\n\n${this.history(thread)}\n\n${followUp(t.said, t.askedIn ? undefined : t.question, false)}${step}` }),
            }
          : { message: fresh }),
      })
        .then((a) => this.deliver(talkId, thread, by, t.question!, a, reading, project))
        .catch((e) => this.deliver(talkId, thread, by, t.question!, { text: this.o.board.t.answer.failed(messageOf(e)) }, reading, project)),
    ).finally(() => {
      this.busy.delete(talkId);
      this.prepared.delete(talkId);
    });
  }

  /**
   * The owner's words in a project's sheet: a question straight to its project agent, which Obeya
   * does not read first. In reply to a message there, it follows up on that message's thread, as a
   * follow-up in Obeya's sheet does. `images`: the screenshots' ids.
   */
  askProject(projectId: string, text: string, images: string[], replyTo?: TalkRef): number {
    const project = this.o.board.item(projectId);
    if (project?.kind !== 'project' || !project.plan) throw new BadRequest('invalid', 'not a project with a plan doc');
    const quoted = this.o.board.sheet.quote(replyTo);
    const talk = this.o.board.sheet.add(text, '', { lookUp: { question: text, about: projectId }, images, replyTo: quoted, askedIn: projectId });
    if (quoted && this.o.board.sheet.exchange(quoted.talk)?.thread) this.o.board.followTalk(talk, quoted.talk);
    this.lookUp(talk);
    return talk;
  }

  /**
   * The owner's words to the agent of a Question card, maybe with screenshots and in reply to a
   * message of its conversation; `talk`: asked in Obeya's sheet as a follow-up of its thread, whose
   * exchange gets the answer too. Words that come while it reads go in with the next turn; while it
   * waits for its background work, they go in at once. `walkthrough`: the words are "Show as
   * walkthrough" on one of its answers: what the agent hears instead, and the walkthrough prepared.
   */
  ask(cardId: string, text: string, { images = [], spoken = false, replyTo, talk, walkthrough }: { images?: string[]; spoken?: boolean; replyTo?: number; talk?: number; walkthrough?: { heard: string; prepared: Told; files: AnswerFile[] } }) {
    const card = this.questionCard(cardId);
    const e = this.o.board.log(cardId, 'talk', 'owner', text, { images, replyTo, unread: this.reading.has(cardId) && !this.waiting.has(cardId) && !talk });
    const quoted = replyTo ? this.o.board.quoted(cardId, replyTo) : undefined;
    // "Show as walkthrough": the agent hears what the button asks, and the walkthrough's player shows
    // at once, unless its agent is in a turn, which may be telling a walkthrough of its own
    const said = walkthrough?.heard ?? `${replyNote(quoted, 'coordinator')}${text}${imageNote(images)}`;
    const thread = this.o.board.thread(cardId);
    if (walkthrough) {
      this.preparedOn.set(e.id, walkthrough.prepared);
      if (!this.reading.has(cardId)) this.showLive(cardId, 'talk', this.agentFor(this.o.board.sheet.exchange(thread.talk)!).by, thread.talk, walkthrough.files);
    }
    const pending = [...(thread.pending ?? []), { text: spoken ? `(${SPOKEN}:) ${said}` : said, images, said: [e.id], ...(talk ? { talk } : {}) }];
    // the owner's words let a paused agent go on, with what it had not answered yet, and one about to pause read on
    if (card.paused) this.goOn(cardId);
    else if (card.pausing) this.o.board.pauseTakenBack(cardId);
    this.o.board.setThread(cardId, { thinking: true, pending });
    this.waiting.get(cardId)?.();
    this.queue(thread.talk, () => this.cardTurn(card.id));
  }

  /**
   * The owner pauses the Question card's agent while it reads: its session ends at once, in the
   * middle of a step if need be. What it was asked stays pending, for when the owner resumes it or
   * asks more.
   */
  pause(cardId: string) {
    const card = this.questionCard(cardId);
    if (!pausableNow(card)) throw pauseRefused(card, true);
    this.halt(cardId);
    this.turnEnds.get(cardId)?.abort();
  }

  /**
   * The owner pauses the Question card's agent at a safe point (the card's pause, the canvas's): it
   * finishes the answer it reads for, and is paused then, before it reads for what was asked
   * meanwhile. One whose turn has not begun yet is paused at once.
   */
  pauseAtSafePoint(cardId: string) {
    const card = this.questionCard(cardId);
    if (!pausable(card)) throw pauseRefused(card, false);
    if (!this.reading.has(cardId)) return this.halt(cardId);
    this.o.board.pausing(cardId);
  }

  /** Pauses the agent: what it was asked and has not answered stays pending. */
  private halt(cardId: string) {
    this.o.board.paused(cardId);
    this.o.board.setThread(cardId, { thinking: false });
  }

  /** The owner lets the paused agent go on: it answers what it was asked. One about to pause after its answer reads on instead. */
  resume(cardId: string) {
    const card = this.questionCard(cardId);
    if (card.pausing) return this.o.board.pauseTakenBack(cardId);
    if (!card.paused) throw notPaused();
    this.goOn(cardId);
    const thread = this.o.board.thread(cardId);
    // the owner may have taken back all it was asked meanwhile
    if (!thread.pending?.length) return;
    this.o.board.setThread(cardId, { thinking: true });
    this.queue(thread.talk, () => this.cardTurn(cardId));
  }

  private goOn(cardId: string) {
    this.o.board.resumed(cardId);
    this.resumed.add(cardId);
  }

  /**
   * The owner takes back words the card's agent has not read, which wait for its next turn: they
   * leave the conversation, and the agent never hears them. A follow-up asked in Obeya's sheet
   * waits for its answer there, so it stays.
   */
  unsay(cardId: string, id: number) {
    this.questionCard(cardId);
    const pending = this.o.board.thread(cardId).pending ?? [];
    const words = pending.find((p) => p.said.includes(id));
    if (!words || words.talk || !this.o.board.unread(cardId, id)) throw new BadRequest('notHeld', 'the agent has read these words already');
    this.o.board.setThread(cardId, { pending: pending.filter((p) => p !== words) });
    this.o.board.withdraw(cardId, id);
  }

  /** After a restart: questions still being looked up are looked up again, and Question cards answer what waited (not while paused). */
  resumeAll() {
    for (const i of this.o.board.items()) {
      if (i.kind !== 'question' || !i.thread?.thinking) continue;
      // about to pause after its answer, which the restart cut off: it stays paused, what it was asked pending
      if (i.pausing) {
        this.halt(i.id);
        continue;
      }
      if (this.o.board.thread(i.id).pending?.length) this.queue(i.thread.talk, () => this.cardTurn(i.id));
      else this.o.board.setThread(i.id, { thinking: false });
    }
    for (const id of this.o.board.sheet.lookingUp()) this.lookUp(id);
  }

  /**
   * "Show as walkthrough" on an answer of the sheet, or of a card's log (`on`: its card and message):
   * a looked-up answer's thread is asked to tell it as a walkthrough, as a follow-up; a direct
   * answer of the Coordinator's has no thread, so a look-up thread starts for it. Either comes as
   * the next answer, its player there at once. The voice loads meanwhile, so the walkthrough sounds
   * soon after its first slide.
   */
  showAsWalkthrough(talkId: number, on?: { card: string; ev: number }): Asked {
    const t = this.o.board.sheet.exchange(talkId);
    const follow = !!t?.thread && t.answer !== undefined;
    const direct = !!t && !t.question && !!t.replyOnly && !!t.reply && !t.undone;
    if (!t || !(follow || direct) || !this.o.voicing) throw new BadRequest('invalid', 'no text answer to tell as a walkthrough');
    // a thread on a Question card goes on there: its answers are asked for there
    if (follow && this.o.board.sheet.exchange(t.thread!)?.movedTo) throw new BadRequest('invalid', 'the thread goes on on its Question card');
    const words = this.o.board.t.answer;
    const told = follow ? t.answer! : t.reply!;
    const question = follow ? asWalkthrough(t.question ?? t.said, told) : asWalkthroughOf(t.said, told);
    const about = follow ? (t.about ?? null) : (t.about ?? t.cardId ?? null);
    // in the sheet, quoting the direct answer it tells; a follow-up shows the answer it continues
    const quote = !on && direct ? { talk: talkId, part: 'reply' as const } : undefined;
    const talk = this.o.board.sheet.add(words.walkthroughAsked, words.walkthroughReply, { card: on?.card, lookUp: { question, about }, replyTo: quote });
    if (follow) this.o.board.followTalk(talk, talkId);
    if (on) {
      this.o.board.log(on.card, 'say', 'owner', words.walkthroughAsked, { replyTo: on.ev });
      this.o.board.log(on.card, 'say', 'coordinator', words.walkthroughReply);
    }
    const thread = follow ? t.thread! : talk;
    const { by } = this.agentFor(this.o.board.sheet.exchange(thread)!);
    // its player stands there at once, at full size, until the first slide comes
    const { prepared, files } = this.prepare(thread, follow ? (t.question ?? t.said) : t.said || told, told);
    this.prepared.set(talk, prepared);
    this.o.board.sheet.showFiles(talk, files);
    if (on) this.showLive(on.card, 'say', by, thread, files);
    this.lookUp(talk);
    return { thread, file: files[0]!.name };
  }

  /**
   * "Show as walkthrough" on a message of a card's conversation: a Question card's answer is asked
   * of the card's agent, any other answer as in the sheet (`showAsWalkthrough`), the exchange found
   * by the answer's words.
   */
  showEventAsWalkthrough(cardId: string, ev: number): Asked {
    const card = this.o.board.item(cardId);
    const e = card ? this.o.board.event(cardId, ev) : undefined;
    if (!card || !e || e.author === 'owner' || !e.text || e.answer?.live) throw new BadRequest('invalid', 'no text answer to tell as a walkthrough');
    if (card.kind === 'question' && e.answer && e.answer.thread === card.thread?.talk) return this.showOnQuestionCard(card, e);
    const talk = e.answer
      ? this.o.board.sheet.thread(e.answer.thread).findLast((r) => r.answer === e.text)?.id
      : e.author === 'coordinator' && e.reply
        ? this.o.board.sheet.cardReply(cardId, e.text)
        : undefined;
    if (talk === undefined) throw new BadRequest('invalid', 'no text answer to tell as a walkthrough');
    return this.showAsWalkthrough(talk, { card: cardId, ev });
  }

  /** "Show as walkthrough" on an answer of a Question card: the owner's words to its agent, its player there at once. */
  private showOnQuestionCard(card: Item, e: CardEvent): Asked {
    if (!this.o.voicing) throw new BadRequest('invalid', 'no voice to tell a walkthrough');
    const thread = this.o.board.thread(card.id);
    // the words it answered: the owner's last before it, else the thread's question
    const question = this.o.board.events(card.id).findLast((x) => x.id < e.id && x.author === 'owner' && x.kind === 'talk')?.text ?? this.o.board.sheet.exchange(thread.talk)?.question ?? card.title;
    const { prepared, files } = this.prepare(thread.talk, question, e.text);
    this.ask(card.id, this.o.board.t.answer.walkthroughAsked, { replyTo: e.id, walkthrough: { heard: asWalkthrough(question, e.text), prepared, files } });
    return { thread: thread.talk, file: files[0]!.name };
  }

  /** The walkthrough "Show as walkthrough" asked for in the thread, named after `question`; the voice loads for the language `told` is written in. */
  private prepare(thread: number, question: string, told: string): { prepared: Told; files: AnswerFile[] } {
    // most likely the language of the answer it tells, which the title slide then names
    const language = writtenIn(told) ?? this.o.board.conversation();
    this.o.voicing!.warm(language);
    const dir = this.o.dirOf(thread);
    mkdirSync(dir, { recursive: true });
    const prepared = prepareWalkthrough(dir, question, language);
    return { prepared, files: [{ name: prepared.file.slice(dir.length + 1), caption: '' }] };
  }

  /**
   * A walkthrough of the thread as its player reads it, `playing` the slide it plays (`-1`: none),
   * which the voice speaks first what it needs of; `undefined` for none.
   */
  walkthrough(thread: number, name: string, playing?: number): Walkthrough | undefined {
    return readWalkthrough(this.o.dirOf(thread), name, this.o.voicing, playing);
  }

  /**
   * A walkthrough's first slide is there while its agent tells on: its answer shows in the card's
   * conversation with the player and no words yet, until the answer takes its place.
   */
  private showLive(cardId: string, kind: 'say' | 'talk', by: By, thread: number, files: AnswerFile[]) {
    this.dropLive(cardId, thread);
    this.o.board.log(cardId, kind, by, '', { answer: { thread, files, live: true } });
  }

  /** The answer of the thread that showed in the card's conversation before its words came, if one did. */
  private dropLive(cardId: string, thread: number) {
    for (const e of this.o.board.events(cardId)) if (e.answer?.live && e.answer.thread === thread) this.o.board.unlog(cardId, e.id);
  }

  /**
   * "Make it a card": the thread moves onto a Question card, near the card whose log holds it: the
   * question as its title, its exchanges as its conversation, the same agent going on. A thread that
   * moved before has its card, put back from the archive if need be.
   */
  toCard(thread: number): Item {
    const rows = this.o.board.sheet.thread(thread);
    const root = rows[0];
    if (!root?.question || root.id !== thread) throw new BadRequest('invalid', 'no looked-up thread');
    if (root.movedTo && this.o.board.card(root.movedTo)) {
      const moved = this.o.board.row(root.movedTo);
      if (moved.archived_at) this.o.board.unarchive(root.movedTo);
      return this.o.board.card(root.movedTo)!;
    }
    const { by, about } = this.agentFor(root);
    const answered = rows.filter((r) => r.answer !== undefined);
    const files = answered.reduce((n, r) => n + (r.files?.length ?? 0), 0);
    const session = rows.findLast((r) => r.session)?.session;
    const card = this.o.board.addQuestion(root.question, { talk: thread, answers: answered.length, files }, session, about?.repo, root.cardId ?? root.askedIn);
    for (const r of rows) {
      this.o.board.log(card.id, 'talk', 'owner', r.said, { images: r.images, at: r.at });
      if (r.answer !== undefined) this.o.board.log(card.id, 'talk', r.answerBy ?? by, r.answer, { answer: answerRef(thread, r.files, r.continues), at: r.at });
    }
    this.o.board.sheet.moveThread(thread, card.id);
    return this.o.board.item(card.id)!;
  }

  /**
   * How an idea that was a Question card opens its discussion: with the thread, its files, and the
   * directory they are in.
   */
  opening(cardId: string): string {
    const { talk } = this.o.board.thread(cardId);
    return [
      'The owner looked a question up with Obeya and asked on, then chose to discuss it as an idea. The conversation so far, oldest first, is where this discussion starts:',
      this.o.board
        .events(cardId)
        .filter(inConversation)
        .map((e) => (e.author === 'owner' ? `The owner: "${e.text}"` : `Obeya: ${e.text}${fileList(e.answer?.files)}`))
        .join('\n\n'),
      `The files of its answers are in ${this.o.dirOf(talk)}. They have not said more yet. Look into it and open the discussion.`,
    ].join('\n\n');
  }

  /** One turn of a Question card's agent: what the owner asked since its last answer, answered on the card. */
  private async cardTurn(cardId: string) {
    const card = this.o.board.item(cardId);
    const stored = card?.kind === 'question' ? this.o.board.thread(cardId) : undefined;
    const taken = [...(stored?.pending ?? [])];
    // paused while it waited for its turn: it goes on once the owner lets it
    if (!card || !stored || !taken.length || card.paused) return;
    const root = this.o.board.sheet.exchange(stored.talk);
    if (!root?.question) return;
    const { by, about, project } = this.agentFor(root);
    const words = taken.map((p) => p.text).join('\n\n');
    const heard = (p: { said: number[] }) => p.said.some((id) => taken.some((t) => t.said.includes(id)));
    const intro = this.message(root.said, root.question, about, project);
    const resumed = this.resumed.delete(cardId) ? `${RESUMED}\n\n` : '';
    // "Show as walkthrough" among the words: its player shows already
    const asked = taken.flatMap((p) => p.said).filter((id) => this.preparedOn.has(id));
    const prepared = asked.length ? this.preparedOn.get(asked.at(-1)!) : undefined;
    this.o.board.readNow(cardId, taken.flatMap((p) => p.said));
    this.reading.add(cardId);
    const end = new AbortController();
    this.turnEnds.set(cardId, end);
    let a: OwnerAnswer;
    try {
      a = await this.consult({
        thread: stored.talk,
        by,
        about,
        project,
        card: cardId,
        images: taken.flatMap((p) => p.images),
        onTool: (name, input) => {
          if (!name.startsWith('mcp__')) this.o.board.log(cardId, 'activity', by, describeTool(name, input, this.o.board.t));
        },
        onSession: (id, model) => this.o.board.work(cardId, { session_id: id, model: model ?? null }),
        onLimit: (until) => this.o.board.waitsForLimit({ card: cardId }, until),
        onShown: (files) => this.showLive(cardId, 'talk', by, stored.talk, files),
        ...(prepared ? { prepared } : {}),
        resume: this.o.board.row(cardId).session_id ?? undefined,
        message: `${resumed}${followUp(words, undefined, true)}`,
        // with the words passed in meanwhile, which the session that failed had heard
        fallback: () => ({
          message: `${intro}\n\n${this.history(stored.talk, cardId)}\n\n${followUp(taken.map((p) => p.text).join('\n\n'), undefined, true)}`,
          images: taken.flatMap((p) => p.images),
        }),
        signal: end.signal,
        onWaiting: (pass) => {
          if (!pass) return void this.waiting.delete(cardId);
          // what the owner said since the turn began goes in now, and the turn answers it too
          const passOn = () => {
            const more = (this.o.board.thread(cardId).pending ?? []).filter((p) => !heard(p));
            if (!more.length) return;
            taken.push(...more);
            this.o.board.readNow(cardId, more.flatMap((p) => p.said));
            pass(meanwhile(more.map((p) => p.text).join('\n\n')), more.flatMap((p) => p.images));
          };
          this.waiting.set(cardId, passOn);
          passOn();
        },
      });
    } catch (e) {
      // paused: what it was asked stays pending, and a walkthrough it began goes with the turn
      if (e instanceof Interrupted) return this.dropLive(cardId, stored.talk);
      a = { text: this.o.board.t.answer.failed(messageOf(e)) };
    } finally {
      for (const id of asked) this.preparedOn.delete(id);
      this.reading.delete(cardId);
      this.waiting.delete(cardId);
      if (this.turnEnds.get(cardId) === end) this.turnEnds.delete(cardId);
    }
    const text = clip(a.text, 12000);
    // the card may have become an idea meanwhile; the answer stands in its conversation all the same
    this.dropLive(cardId, stored.talk);
    this.o.board.log(cardId, 'talk', by, text, { answer: answerRef(stored.talk, a.files) });
    const now = this.o.board.row(cardId).thread ? this.o.board.thread(cardId) : undefined;
    if (now) {
      const left = (now.pending ?? []).filter((p) => !heard(p));
      this.o.board.setThread(cardId, { answers: now.answers + 1, files: now.files + (a.files?.length ?? 0), thinking: left.length > 0, pending: left });
    }
    // the owner asked it to pause once its answer was given: what was asked meanwhile waits for them to let it go on
    if (this.o.board.row(cardId).pausing) this.halt(cardId);
    this.o.board.notify({ cardId, text, inTalk: true });
    for (const p of taken) if (p.talk) this.answer(p.talk, root.question, text, by, a.files);
  }

  /**
   * Asks the thread's agent: a project's agent in its own session, else the look-up's session,
   * resumed when there is one. A session that cannot be resumed (its transcript is gone) is
   * replaced by a fresh agent that gets the thread so far (`fallback`).
   */
  private consult(c: {
    thread: number;
    by: By;
    about: Item | undefined;
    project: Item | undefined;
    message: string;
    resume?: string | undefined;
    fallback?: () => { message: string; images?: string[] };
    card?: string;
    images?: string[];
    /** Written in a project's sheet (`from`), straight to its project agent, with these screenshot files. */
    asked?: { images: string[]; from: string };
    signal?: AbortSignal;
    /** The turn waits for the agent's background work, or no longer (`Briefing.onWaiting`). */
    onWaiting?: Briefing['onWaiting'];
    onTool: (name: string, input: Record<string, unknown>) => void;
    onSession: (id: string, model?: string) => void;
    /** Where it shows that it waits for the usage limit. */
    onLimit: (until: number | undefined) => void;
    /** The walkthrough of the answer has its first slide: its player shows before the answer's words. */
    onShown: (files: AnswerFile[]) => void;
    /** The walkthrough the owner asked for, showing already. */
    prepared?: Told;
  }): Promise<OwnerAnswer> {
    const dir = this.o.dirOf(c.thread);
    mkdirSync(dir, { recursive: true });
    const voicing = this.o.voicing;
    const told = voicing && new AnswerWalkthrough({ dir, checkout: this.o.pathFor(c.about), voicing, onShown: c.onShown, ...(c.prepared ? { prepared: c.prepared } : {}) });
    if (!told) return this.consulted(c, dir);
    // the walkthrough comes with the answer, first among its files
    return this.consulted(c, dir, told)
      .then((a) => {
        const shown = told.files();
        // a walkthrough is the one the agent told, never a file of that name it passes on
        const files = [...shown, ...(a.files ?? []).filter((f) => !isWalkthrough(f.name))];
        return { ...a, ...(files.length ? { files } : {}) };
      })
      .finally(() => told.finish());
  }

  private consulted(c: Parameters<Answers['consult']>[0], dir: string, told?: AnswerWalkthrough): Promise<OwnerAnswer> {
    const rules = told ? `\n\n${WALKTHROUGH_RULES}` : '';
    if (c.by === 'project') {
      const from = c.asked?.from;
      return this.o.projectAgent(c.project!).inform(c.project!, `${c.message}\n\n${filesNote(dir)}`, c.onLimit, {
        onTool: c.onTool,
        dir,
        ...(c.signal ? { signal: c.signal } : {}),
        ...(c.onWaiting ? { onWaiting: c.onWaiting } : {}),
        ...(c.asked ? { images: c.asked.images } : {}),
        ...(from && this.o.toObeya ? { toObeya: toObeyaTool((request) => this.o.toObeya!(from, request)) } : {}),
        ...(told ? { tools: [told.tool()], rules } : {}),
      });
    }
    const toObeya = c.card && this.o.toObeya ? this.o.toObeya : undefined;
    const ask = (message: string, images: string[] | undefined, resume?: string) =>
      inform({
        runtime: this.o.runtime,
        cwd: this.o.pathFor(c.about),
        system: `You are the Coordinator of Obeya, a canvas on which the owner directs coding agents; the owner knows you simply as Obeya.\n\n${INFORM_RULES}${rules}${toObeya ? `\n\n${TO_OBEYA}` : ''}`,
        message: [message, filesNote(dir), this.o.preferences?.() ?? ''].filter(Boolean).join('\n\n'),
        dir,
        onTool: c.onTool,
        onSession: c.onSession,
        onLimit: c.onLimit,
        language: this.o.board.conversation(),
        ...(resume ? { resume } : {}),
        ...(images?.length ? { images } : {}),
        tools: [...(told ? [told.tool()] : []), ...(toObeya ? [toObeyaTool((request) => toObeya(c.card!, request))] : [])],
        ...(this.o.permissionMode ? { permissionMode: this.o.permissionMode } : {}),
        ...(c.signal ? { signal: c.signal } : {}),
        ...(c.onWaiting ? { onWaiting: c.onWaiting } : {}),
      });
    const fresh = () => {
      const f = c.fallback?.() ?? { message: c.message, images: c.images };
      return ask(f.message, f.images);
    };
    if (!c.resume) return fresh();
    return ask(c.message, c.images, c.resume).catch((e) => {
      if (e instanceof Interrupted) throw e;
      return fresh();
    });
  }

  /** Who answers a thread: the project agent for a project or one of its workstreams, else a Coordinator turn. */
  private agentFor(root: Exchange): { by: By; about: Item | undefined; project: Item | undefined } {
    const about = root.about ? this.o.board.item(root.about) : undefined;
    const project = about?.kind === 'project' ? about : about?.parent ? this.o.board.item(about.parent) : undefined;
    return { by: project?.plan ? 'project' : 'coordinator', about, project };
  }

  /** The session of the Question card a thread moved onto, archived or deleted since. */
  private cardSession(root: Exchange): string | undefined {
    if (!root.movedTo) return;
    try {
      return this.o.board.row(root.movedTo).session_id ?? undefined;
    } catch {
      return;
    }
  }

  /** One turn after the other in each thread; with none running, it starts at once. */
  private queue(thread: number, fn: () => Promise<unknown>): Promise<unknown> {
    return oneAtATime(this.turns, thread, fn);
  }

  /** `project`: the project whose agent answered, whose sheet shows the answer in full too. */
  private deliver(talkId: number, thread: number, by: By, question: string, a: OwnerAnswer, card: string | undefined, project: Item | undefined) {
    const text = clip(a.text, 12000);
    const t = this.o.board.sheet.exchange(talkId);
    // in the log of the card that was open; with the thread moved onto a Question card meanwhile, there too
    const moved = t?.movedTo && this.o.board.item(t.movedTo)?.kind === 'question' ? t.movedTo : undefined;
    this.o.board.sheet.answer(talkId, text, by, a.files);
    const ref = answerRef(thread, a.files, t?.continues);
    if (card) {
      this.dropLive(card, thread);
      this.o.board.log(card, 'say', by, text, { answer: ref });
    }
    if (moved) {
      this.dropLive(moved, thread);
      this.o.board.log(moved, 'talk', by, text, { answer: ref });
      const s = this.o.board.thread(moved);
      this.o.board.setThread(moved, { answers: s.answers + 1, files: s.files + (a.files?.length ?? 0) });
    }
    // above the microphone too, wherever the owner is by now; in full on the card or in the sheet
    this.o.board.notify({ ...(card || moved ? { cardId: card ?? moved, inTalk: true as const } : { talk: talkId, ...(by === 'project' && project ? { project: project.id } : {}) }), text });
    this.o.onAnswer?.(talkId, question, text);
  }

  /** An exchange from the sheet answered on its thread's Question card. */
  private answer(talkId: number, question: string, text: string, by: By, files: AnswerFile[] = []) {
    this.o.board.sheet.answer(talkId, text, by, files);
    this.o.onAnswer?.(talkId, question, text);
  }

  /** The thread so far, for an agent that starts afresh: the owner's words and the answers, with their files. */
  private history(thread: number, cardId?: string): string {
    const lines = cardId
      ? this.o.board
          .events(cardId)
          // words not read yet come with a later turn
          .filter((e) => inConversation(e) && !e.unread)
          .map((e) => said(e))
      : this.o.board.sheet
          .thread(thread)
          .flatMap((r) => [`The owner: "${r.said}"`, ...(r.answer !== undefined ? [`You: ${r.answer}${fileList(r.files)}`] : [])]);
    // the words being asked now come after it
    return `You answered the owner before, in a session that cannot be resumed. The conversation so far, oldest first:\n\n${lines.join('\n\n')}`;
  }

  private questionCard(id: string): Item {
    const i = this.o.board.item(id);
    if (!i) throw new BadRequest('unknownCard', 'unknown card');
    if (i.kind !== 'question') throw new BadRequest('notQuestion', 'the card is no Question card');
    return i;
  }

  private message(said: string, question: string, about: Item | undefined, project: Item | undefined, askedIn?: string): string {
    const parts = askedIn
      ? [`The owner wrote to you in the project's sheet in Obeya, where your answer stands below their words: "${said}"`]
      : [`The owner said: "${said}"`, `The question, as you understood it then: ${question}`];
    if (about && about.kind !== 'project') {
      const state = about.queue ? 'planned, queued' : about.need ? `${about.state}: ${about.need}` : about.state;
      parts.push(
        [
          `It is about the ${about.kind} "${about.title}"${about.label ? ` (workstream ${about.label} of the project "${project?.title ?? ''}")` : ''}, state ${state}.`,
          about.statusLine ? `Its last status line: ${about.statusLine}` : '',
          about.question ? `Its open question: ${about.question.text}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      );
      const brief = ['planned', 'proposal', 'working', 'waiting', 'inPr', 'approved'].includes(about.state) ? this.o.startBrief(about) : undefined;
      if (brief)
        parts.push(
          `${about.state === 'planned' || about.state === 'proposal' ? 'The task its worker would get if the owner started it now' : 'The task its worker got at its start'} (the worker also follows the repository's CLAUDE.md and docs):\n\n<task>\n${brief}\n</task>`,
        );
      const log = this.o.board
        .events(about.id)
        .filter((e) => e.kind !== 'activity')
        .slice(-LOG_LINES);
      if (log.length) parts.push(`The card's log, latest last:\n${log.map((e) => `- ${e.at.slice(0, 16)} ${e.author} (${e.kind}): ${clip(e.text, 300)}`).join('\n')}`);
    } else if (project) parts.push(`It is about the project "${project.title}".`);
    if (project?.plan) parts.push(`The project's plan doc: ${project.plan.file}.`);
    return parts.join('\n\n');
  }
}

/** What the agent hears when the owner goes on: in Obeya's sheet (with the question as Obeya understood it) or on the Question card. */
const followUp = (said: string, question: string | undefined, onCard: boolean) =>
  [
    onCard
      ? `The owner moved this conversation onto a card of its own, and goes on there; their words come to you directly:\n\n${said}`
      : `The owner follows up on your answer. They said: "${said}"`,
    question ? `The question, as Obeya understood it: ${question}` : '',
    'Answer it the same way: read and check what you need (what you read and computed before is still yours), then call answer_owner once.',
  ]
    .filter(Boolean)
    .join('\n\n');

/** What the agent of a Question card hears when the owner writes while its turn waits for its background work. */
const meanwhile = (said: string) =>
  `While your background work runs, the owner wrote on the card; their words come to you at once:\n\n${said}\n\nYour answer (answer_owner, once, when you have it) answers these words too.`;

/** What the agent of a Question card hears when the owner lets it go on after a pause. */
const RESUMED =
  'The owner paused you while you worked on your answer and has now let you go on. Pausing ended your session at once: whatever you had running was stopped with it (a command still running shows exit code 137). What they asked is still unanswered.';

/** Where the thread's files go, as every turn of it hears. */
const filesNote = (dir: string) =>
  `Your output directory for this conversation is ${dir}, outside every repository; it stays with the conversation, so what you wrote there before is there still, and earlier answers still show their files: leave those as they are and write a changed version under a new name. Files the owner asks for, or that help your answer, go there and never into a repository: a spreadsheet of the numbers, a chart or a page, the queries and scripts behind them, a draft as a document, whatever fits. Pass those the owner should see with answer_owner's files, each with a one-line caption; a page (HTML) or an image shows under your answer, any other file opens with the owner's app for it.`;

/**
 * What the agent of a thread is asked when the owner wants an answer of it as a walkthrough ("Show
 * as walkthrough"): that answer, which need not be its last.
 */
const asWalkthrough = (question: string, answer: string) =>
  `Tell this answer of yours as a walkthrough, as your instructions describe, rather than as text: the same content, walked through.\n\nThe question: ${question}\n\nYour answer:\n<answer>\n${clip(answer, 6000)}\n</answer>`;

/**
 * The same for an answer Obeya gave straight away, without looking anything up: the look-up that
 * tells it starts afresh, and checks what it walks through.
 */
const asWalkthroughOf = (said: string, answer: string) =>
  `${said ? `The owner said to Obeya: "${clip(said, 2000)}". Obeya answered straight away, without looking anything up:` : 'Obeya told the owner, without being asked:'}\n<answer>\n${clip(answer, 6000)}\n</answer>\n\nTell that answer as a walkthrough, as your instructions describe, rather than as text: the same content, walked through. Check what it says where you walk through how something works, and correct it where it is wrong.`;

const answerRef = (thread: number, files?: AnswerFile[], continues?: string): AnswerRef => ({
  thread,
  ...(files?.length ? { files } : {}),
  ...(continues ? { continues } : {}),
});

const fileList = (files?: AnswerFile[]) => (files?.length ? `\n(files: ${files.map((f) => `${f.name} – ${f.caption}`).join('; ')})` : '');

/** Whether a line of a Question card's log is a message of its conversation: the owner's words or an answer. */
const inConversation = (e: CardEvent) => e.kind === 'talk' || (e.kind === 'say' && !!e.answer);

/** A message of a Question card's conversation, as an agent that starts afresh reads it. */
const said = (e: CardEvent) => (e.author === 'owner' ? `The owner: "${e.text}"` : `You: ${e.text}${fileList(e.answer?.files)}`);

/** How the Coordinator names an answer it looked up, to say which one the owner's words follow up on. */
export const answerTag = (talk: number) => `A${talk}`;
export const fromAnswerTag = (tag: string): number | undefined => {
  const m = /^A?(\d+)$/i.exec(tag.trim());
  return m ? Number(m[1]) : undefined;
};

/** A thread's output directory under Obeya's home: never in a repository, like demos. */
export const answersDir = (home: string, canvas: string, thread: number) => join(home, 'answers', canvas, String(thread));

