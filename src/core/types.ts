// Shapes shared by the server and the UI.

import type { DemoSettings, NarrationLanguage, VoiceKind } from '../../plugin/skills/demo/lib/settings.ts';
import type { SetupId, SetupItem } from '../../plugin/skills/demo/lib/setup.ts';
import type { CardFile } from './files';
import type { Language } from './locale';
import { MESSAGES } from './messages';
import type { OutdatedBy } from './page-changes';
import type { NotAProject } from './plan-doc';
import type { Wish } from './wish';

export type { DemoSettings, NarrationLanguage, VoiceKind } from '../../plugin/skills/demo/lib/settings.ts';
export type { Language } from './locale';
export type { SetupCheck, SetupId, SetupItem } from '../../plugin/skills/demo/lib/setup.ts';

/**
 * How Obeya hears speech: Parakeet (NVIDIA's Parakeet TDT 0.6B v3, int8, through onnx-asr and ONNX
 * Runtime on the CPU), on every platform; or Whisper (mlx-whisper on Apple Silicon, faster-whisper
 * elsewhere).
 */
export type ListenBackend = 'parakeet' | 'mlx' | 'faster';

/**
 * `question`: a thread of looked-up answers the owner moved onto a card of its own, with the agent
 * that looked them up; it holds answers, no work, so its state is `done` until the owner archives it.
 */
export type CardKind = 'task' | 'project' | 'question';

export const STATES = ['idea', 'proposal', 'planned', 'working', 'waiting', 'approved', 'inPr', 'live', 'done'] as const;
export type CardState = (typeof STATES)[number];

/** A card whose work is over: `live` once it landed, `done` when it needed no change to the code (a demo, an analysis). */
export const finished = (s: CardState) => s === 'live' || s === 'done';
/** A card an agent worked on until the owner stopped it: planned again, its branch stays the card's. */
export const stopped = (i: Pick<Item, 'state' | 'branch' | 'unstarted'>) => i.state === 'planned' && !!i.branch && !i.unstarted;
/**
 * A stopped card of the owner's the archive may take: nothing waits to start it, and its workspace
 * holds no work (a branch with commits or changes keeps it, and archiving would leave that work
 * unseen in a clone), or its repository does not run on the canvas, where nothing shows that work anyway.
 */
export const stoppedArchivable = (i: Pick<Item, 'state' | 'branch' | 'unstarted' | 'source' | 'queue' | 'workspace' | 'keptIn' | 'prototypeOf' | 'kind' | 'repoDown'>) =>
  stopped(i) && i.source === 'manual' && i.kind === 'task' && !i.prototypeOf && !i.queue && ((!i.workspace && !i.keptIn) || !!i.repoDown);
/** A finished card of the owner's whose agent is done: the archive may take it. */
export const finishedArchivable = (i: Pick<Item, 'state' | 'source' | 'finishing'>) => finished(i.state) && i.source === 'manual' && !i.finishing;
/**
 * A card the canvas's "Archive finished cards" takes, and so counts on its button: a finished one the
 * archive may take, but no Question card, which is done when the owner says so, not with the work;
 * and a project whose work is done.
 */
export const archivedWithDone = (i: Pick<Item, 'state' | 'source' | 'finishing' | 'kind'>) =>
  (finishedArchivable(i) && i.kind !== 'question') || (i.kind === 'project' && i.state === 'done');
/** A finished card whose agent still works: after the landing, or answering a follow-up question. */
export const finishingUp = (i: Pick<Item, 'state' | 'finishing'>) => !!i.finishing && finished(i.state);
/** A piece of an agent's background work as the agent described it (`Run the test suite`), and since when it runs (milliseconds). */
export interface BackgroundTask {
  description: string;
  since: number;
}

/** A card's worker in a turn: its background work that runs, and whether the turn itself ended and only waits for that work to wake it (`over`). */
export interface WorkerTurn {
  tasks: BackgroundTask[];
  over: boolean;
  /** The worker ended its turn for the restart that is due, nothing of it runs any more, and it goes on once Obeya runs again. */
  restart?: true;
}

/** The card's agent is snoozed (by itself or the owner, "Later …"): it stops until its time, and neither pauses nor resumes meanwhile. */
const snoozedAway = (i: Pick<Item, 'snoozed'>) => !!i.snoozed && !i.snoozed.waiting;

/** The card's agent runs a turn the owner can pause at once (the pause on the bubble of its turn), also while it is about to pause at a safe point. */
export const pausableNow = (i: Pick<Item, 'kind' | 'state' | 'idea' | 'thread' | 'inTurn' | 'paused' | 'snoozed'>) =>
  !i.paused && !snoozedAway(i) && (i.kind === 'question' ? !!i.thread?.thinking : i.state === 'idea' && i.idea ? i.idea.thinking : !!i.inTurn);

/** The card's agent is at work and can be paused, at a safe point (the card's pause, the canvas's) or at once; not one about to pause already. */
export const pausable = (i: Pick<Item, 'kind' | 'state' | 'idea' | 'thread' | 'inTurn' | 'paused' | 'pausing' | 'snoozed'>) => !i.pausing && pausableNow(i);

/** The owner paused the card's agent, and it waits for them to resume it; a snoozed one, which holds what comes for it as a paused one does, waits for its time instead. */
export const resumable = (i: Pick<Item, 'paused' | 'snoozed'>) => !!i.paused && !snoozedAway(i);

/** The card's agent is paused, or about to pause at a safe point: what the card's ▶ and the canvas's resume let go on. */
export const halted = (i: Pick<Item, 'paused' | 'pausing' | 'snoozed'>) => (!!i.paused || !!i.pausing) && !snoozedAway(i);

/**
 * A finished card an agent worked on, on the canvas, with no agent on it now: what the owner asks
 * about it resumes the agent that did the work, which answers and ends again.
 */
export const askable = (i: Pick<Item, 'state' | 'branch' | 'prototypeOf' | 'archivedAt' | 'finishing'>) =>
  finished(i.state) && !!i.branch && !i.prototypeOf && !i.archivedAt && !i.finishing;

/**
 * How many cards of each group are still to be done: not finished, not archived, not a dropped
 * idea. A project counts by its workstreams, not as a card of its own.
 */
export function openPerGroup(items: Item[]): Map<string, number> {
  const open = new Map<string, number>();
  for (const i of items)
    if (i.group && i.kind === 'task' && !finished(i.state) && !i.archivedAt && i.idea?.status !== 'dropped') open.set(i.group, (open.get(i.group) ?? 0) + 1);
  return open;
}

/** A workstream a prototype can be built for: nobody has worked on it yet, and the Coordinator does not hold it. */
export const buildableOn = (i: Item) => i.state === 'planned' && !i.branch && !i.queue;

/**
 * A planned task nobody has worked on yet, which the Coordinator may merge with others or delete:
 * no branch, no workspace, not with the Coordinator unless it waits there behind other cards (a
 * review's follow-up task waiting for the PR's merge, say), and no prototype nor becoming a project.
 */
export const untouched = (i: Item) =>
  i.kind === 'task' && i.source === 'manual' && i.state === 'planned' && !i.branch && !i.workspace && (!i.queue || 'behind' in i.queue) && !i.prototypeOf && !i.becomesProject;

/**
 * A task of the owner's that can still be planned as a project, as an idea can: planned, nobody has
 * worked on it, the Coordinator does not hold it, and it is no prototype nor decided as a project already.
 */
export const plannableAsProject = (i: Item) =>
  i.source === 'manual' && i.kind === 'task' && buildableOn(i) && !i.prototypeOf && !i.becomesProject;

/**
 * The name a plan doc gives a prototype by: its variant, or else its approach as its title has it
 * after the idea's (which tells apart two prototypes of the same variant, "… (2)").
 */
export function prototypeName(p: Pick<Item, 'title' | 'variant'>): string {
  const variant = p.variant?.trim();
  if (variant && p.title.endsWith(variant)) return variant;
  return p.title.split(' – ').slice(1).join(' – ').trim() || variant || p.title;
}

/**
 * Which of an idea's prototypes the project it became builds on, and in which workstream, as the
 * plan doc says it: the one open workstream that names one prototype by its name (`prototypeName`)
 * in quotes; with a single prototype, also the one open workstream that mentions prototypes at all.
 * `also`: the other workstreams that mention prototypes all the same. `none` where no workstream
 * mentions a prototype; `unclear` where several name one, one names several, or one mentions a
 * prototype without naming which, with the workstreams that do.
 */
export function prototypeBuild<W extends { title: string; body: string }, P extends Pick<Item, 'title' | 'variant'>>(
  workstreams: W[],
  prototypes: P[],
): { workstream: W; prototype: P; also: W[] } | { none: true } | { unclear: 'several' | 'many' | 'unnamed'; workstreams: W[] } {
  const flat = (s: string) => s.toLowerCase().replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();
  const quoted = (text: string, name: string) => name !== '' && new RegExp(`[„“”"‚‘’'«»‹›]\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[„“”"‚‘’'«»‹›]`).test(text);
  const named = workstreams.flatMap((w) => {
    const text = flat(`${w.title}\n${w.body}`);
    const own = prototypes.filter((p) => quoted(text, flat(prototypeName(p))));
    return own.length ? [{ w, own }] : [];
  });
  const mentioning = workstreams.filter((w) => /prototyp/i.test(`${w.title}\n${w.body}`));
  if (named.length > 1) return { unclear: 'several', workstreams: named.map((n) => n.w) };
  if (named.length === 1) {
    const [{ w, own }] = named as [{ w: W; own: P[] }];
    return own.length > 1 ? { unclear: 'many', workstreams: [w] } : { workstream: w, prototype: own[0]!, also: mentioning.filter((m) => m !== w) };
  }
  if (!mentioning.length) return { none: true };
  if (mentioning.length === 1 && prototypes.length === 1) return { workstream: mentioning[0]!, prototype: prototypes[0]!, also: [] };
  return { unclear: mentioning.length > 1 ? 'several' : 'unnamed', workstreams: mentioning };
}

/** What a `waiting` card waits for: `demo` a handover with a demo, `review` one without. */
export type Need = 'demo' | 'question' | 'review';

/** A question an agent asks the owner, with answer options to choose from when it has them. */
export interface Question {
  text: string;
  options: string[];
  /** Several options may be chosen together. */
  multiple?: boolean;
  /** What the asking agent would pick if it had to decide: some of the options, and why. */
  pick?: { options: string[]; why: string };
  /** Obeya asks for a worker that is stuck (its turn failed, or ended twice without a handover), not the worker. */
  stuck?: true;
}

/** A question as its card's log holds it: the text, then one line per option. */
export const formatQuestion = (q: Question, language: Language): string =>
  q.options.length ? `${q.text}${q.multiple ? ` (${MESSAGES[language].multiple})` : ''}\n${q.options.map((o) => `– ${o}`).join('\n')}` : q.text;

/** Its worker handed the work over: the card waits for the owner's approval or feedback. */
export const handedOver = (i: Pick<Item, 'state' | 'need'>) => i.state === 'waiting' && (i.need === 'demo' || i.need === 'review');

/** Its worker takes in the owner's words on its handover: meanwhile the card is at work, and still waits for approval. */
export const answering = (i: Pick<Item, 'state' | 'need' | 'answering'>) => handedOver(i) && !!i.answering;

/**
 * Whether an agent hears what the owner says or types on the card when it is open: its worker (at
 * work, waiting, in a pull request, finishing after the landing, or one a question resumes on a
 * finished card), an idea's exploration agent, or the agent that reworks a proposal (while it
 * does, the words wait for the rework after it). The words then go straight to it; on any other
 * card they go to the Coordinator.
 */
export const agentListens = (i: Pick<Item, 'kind' | 'state' | 'branch' | 'prototypeOf' | 'archivedAt' | 'finishing'>) =>
  !i.archivedAt && (i.kind === 'question' || i.state === 'idea' || i.state === 'proposal' || i.state === 'working' || i.state === 'waiting' || i.state === 'inPr' || !!i.finishing || askable(i));

/**
 * A card the owner left without a title but with a task (text or screenshots): Obeya names it from
 * that (`Coordinator.name`). Without either it is an empty card, dropped when closed.
 */
export const nameless = (i: Pick<Item, 'kind' | 'title' | 'body' | 'images'>) => i.kind !== 'project' && !i.title.trim() && (!!i.body.trim() || !!i.images?.length);

/** A title from a task's first words, on a card not named yet, and when Obeya's naming fails. */
export function titleFrom(body: string): string {
  const line = body.trim().split('\n')[0]!.trim();
  if (line.length <= 70) return line;
  const cut = line.slice(0, 70);
  return `${cut.slice(0, cut.lastIndexOf(' ') > 30 ? cut.lastIndexOf(' ') : 70)}…`;
}

/**
 * The questions on a card that wait for the owner's answer: its idea agent's while the idea is open
 * and the agent is not at work on a reply (which may settle them), its proposal's while it is not
 * reworked, its worker's, its demo report's. The one place where each kind of card says which of its
 * questions are open: its conversation shows them at its end with the field under it set to answer
 * them, the canvas card and the phone's count show them, the Coordinator hears of them.
 */
export function openQuestions(i: Pick<Item, 'archivedAt' | 'state' | 'need' | 'question' | 'idea' | 'proposal'>): Question[] {
  if (i.archivedAt) return [];
  if (i.state === 'idea') return i.idea?.status === 'open' && !i.idea.thinking ? i.idea.questions : [];
  if (i.state === 'proposal') return i.proposal && !i.proposal.revising ? i.proposal.questions : [];
  return i.state === 'waiting' && (i.need === 'question' || i.need === 'demo') && i.question ? [i.question] : [];
}

/**
 * A card needs the owner: it waits (but not while its worker takes in what the owner wrote on its
 * handover, nor once they approved it and its work lands), is a proposal or an accepted one its agent withdrew or
 * replaced since, has a pull request that only waits for the owner's merge, or is an open idea whose agent has replied
 * and is done.
 */
export const needsYou = (i: Item) =>
  !i.snoozed &&
  ((i.state === 'waiting' && !answering(i) && !i.landing) || (i.state === 'proposal' && !i.proposal?.revising) || !!i.superseded || (i.state === 'inPr' && [i.pr, ...(i.morePrs ?? [])].some((p) => p?.ready && !p.merged && !p.closed)) || (!!i.idea && i.idea.status === 'open' && i.idea.yourTurn && !i.idea.thinking));

/**
 * What a worker can wait for another card to reach: `done`, its work on main (or the card closed
 * without a change); `waitsForOwner`, it needs the owner (asks, hands its work over, a proposal or an
 * idea's questions; snoozed by them or not), or got done already.
 */
export const AWAITED_STATES = ['done', 'waitsForOwner'] as const;
export type AwaitedState = (typeof AWAITED_STATES)[number];

export type Awaited = 'reached' | 'gone' | 'archived' | 'stopped' | 'dropped';

/** Why a snoozed card woke: its time came, the owner woke it, Obeya had something for its agent, it needs the owner, what became of the card it waited on, or what the contributor it waited for did (`said`, as its log says it). */
export type Woke = 'time' | 'owner' | 'news' | 'needsYou' | { met: Awaited } | { said: string };

/**
 * Whether the card a snoozed worker waits on gets it to wake: `reached` the state it waits for;
 * `gone`, `archived`, `stopped` (planned again by the owner), `dropped` (an idea let go) when it no
 * longer gets there by itself; null while it may still.
 */
export function awaited(card: Item | undefined, state: AwaitedState): Awaited | null {
  if (!card) return 'gone';
  if (finished(card.state) || (state === 'waitsForOwner' && needsYou({ ...card, snoozed: undefined }))) return 'reached';
  if (card.archivedAt) return 'archived';
  if (stopped(card)) return 'stopped';
  if (card.idea?.status === 'dropped') return 'dropped';
  return null;
}

/** A worker on the card is at work (whether or not in a turn right now): it has started on the card, opens or follows its pull request, finishes after the landing, or takes in the owner's words on its handover. */
const workerAtWork = (i: Item) => i.kind === 'task' && (i.state === 'working' || i.state === 'inPr' || !!i.finishing || answering(i));

/** A task planned and not with the Coordinator: snoozed, it starts at the time instead of now. */
export const plannedToStart = (i: Pick<Item, 'kind' | 'state' | 'queue' | 'archivedAt'>) => i.kind === 'task' && i.state === 'planned' && !i.queue && !i.archivedAt;

/**
 * A card the owner can snooze until a point in time ("Later …"): one at work (its worker stops
 * until then, as on a pause), one that waits for them (it leaves them until then), or one planned
 * (it starts then); a snoozed card's time can be changed.
 */
export const snoozable = (i: Item) => !i.archivedAt && (!!i.snoozed || needsYou(i) || workerAtWork(i) || plannedToStart(i));

/**
 * A review card the owner can set aside until its contributor writes on the pull request or pushes
 * ("Until amerlander responds" in "Later …"): it is handed over (whether snoozed until a time
 * meanwhile or not), and not snoozed so already.
 */
export const awaitsContributorNext = (i: Item) => !!i.contribution && !i.archivedAt && handedOver(i) && !answering(i) && !i.landing && !i.snoozed?.contributor && (!i.snoozed || !!i.snoozed.waiting);

/** Answers in the Coordinator's sheet the owner has not seen yet. */
export const unreadAnswers = (talk: Talk[]) => talk.filter((x) => x.unread).length;

/** Per project, its agent's answers to what the owner asked in its sheet that wait unread: its card shows them. */
export function unreadPerProject(talk: Talk[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const x of talk) if (x.unread && x.askedIn) m.set(x.askedIn, (m.get(x.askedIn) ?? 0) + 1);
  return m;
}

/** What on a canvas waits for the owner: the cards that need them, and the Coordinator while an answer waits unread. */
export const waitingOn = (s: Pick<CanvasSnapshot, 'items' | 'talk'>) => s.items.filter(needsYou).length + (unreadAnswers(s.talk) ? 1 : 0);

/**
 * What of a canvas "Needs you" lists (the phone's, and the navigation on every other canvas's page):
 * the cards that need the owner (none snoozed, which are put off), and the Coordinator's answers that
 * wait unread.
 */
export type Waiting = Pick<CanvasSnapshot, 'items' | 'talk'>;
export const waitingIn = (s: Pick<CanvasSnapshot, 'items' | 'talk'>): Waiting => ({
  items: s.items.filter(needsYou),
  talk: s.talk.filter((x) => x.unread),
});

/**
 * Who wrote a card's task: the owner (also through the Coordinator, from their words), the plan doc
 * of its workstream, Obeya (the work retrospective), the idea a prototype is for, or a worker whose
 * proposal the owner accepted. A decided idea's task is its brief, the idea's agent's.
 */
export type TaskAuthor = 'owner' | 'plan' | 'coordinator' | 'idea' | 'proposal';

export const taskAuthor = (item: Pick<Item, 'source' | 'prototypeOf' | 'retro' | 'proposed' | 'brief'>): TaskAuthor =>
  item.source === 'plan' ? 'plan' : item.prototypeOf || item.brief !== undefined ? 'idea' : item.retro ? 'coordinator' : item.proposed ? 'proposal' : 'owner';

/** One item on the canvas as the UI sees it: a stored card merged with what its plan doc says. */
export interface Item {
  id: string;
  /** The card's code in addresses (`/c/<canvas>/card/<code>`): a few hex digits, unique among all cards; the id works there too. */
  short?: string;
  /** The card's number (`K42`, `cardTag`): counting across all canvases, given once and never again. */
  number: number;
  kind: CardKind;
  state: CardState;
  need?: Need;
  title: string;
  /** Free text: the owner's description, or a workstream's text from the plan doc (inline markdown). */
  body: string;
  /** Position; relative to the parent project for its workstreams. */
  x: number;
  y: number;
  parent?: string;
  /** `manual` cards are the owner's; `plan` cards mirror a plan doc and are read-only here. */
  source: 'manual' | 'plan';
  /** Workstream label from the plan doc (`W3`). */
  label?: string;
  /** Projects only. */
  plan?: { file: string; goal: string };
  /** Projects only: the idea their plan doc was written from. */
  origin?: string;
  /** Projects only: the Coordinator reads from the plan doc which workstream builds on which, to arrange them. */
  arranging?: true;
  /** Workstreams only: the workstreams of its project it builds on, as the Coordinator read them from the plan doc. */
  buildsOn?: string[];
  /** Cards connected by the owner that must finish before this card starts. */
  manualDependsOn?: string[];
  /** The worker's latest `report`. */
  statusLine?: string;
  /**
   * Open question: the worker's, when `need` is `question`; or the one in its demo report, while
   * the demo waits for approval and the owner has not answered it.
   */
  question?: Question;
  /** The worker's summary, when `need` is `review` or `demo`. */
  summary?: string;
  /**
   * Its worker takes in what the owner wrote or said on its handover (`need` is `review` or `demo`):
   * until its turn ends, the card is at work and not the owner's, and still waits for approval.
   */
  answering?: true;
  /**
   * Its worker answered what the owner wrote or said on its handover without a new demo: the card
   * waits for the owner because of that answer, not a demo to watch.
   */
  answered?: true;
  /**
   * The owner's comments on places in the demo video (their event ids) that Obeya holds back while
   * they watch, to give them to the worker in one message once they are done (`Spot`).
   */
  held?: number[];
  /** The owner approved the work and Obeya lands it on main (seconds of git): still `waiting`, but no longer the owner's. */
  landing?: true;
  /** The demo, when `need` is `demo`; its files are served under `/api/cards/:id/demo/`. */
  demo?: Demo;
  /**
   * The demos of earlier handovers a later one replaced, the oldest first, as long as their files
   * are still on disk; each one's files are served under `/api/cards/:id/demos/:n/`.
   */
  demos?: EarlierDemo[];
  /**
   * The files its worker named as the result at its latest handover that named any, the left column's
   * first tabs after the demo; served with the others it changed under `/api/cards/:id/files/`.
   * An empty list: none named, but there are files of its change to show (a folder's card handed over without a demo).
   */
  files?: CardFile[];
  /**
   * The size of the card's change as the server last read it (at the handover, and whenever the card's
   * diff is read): the lines of its change list and the lines added and removed. The page lays out
   * the change list and the branch line with it before it has read the change itself, so that what
   * stands below them (the demo) does not move when the change arrives.
   */
  changeSize?: ChangeSize;
  /** The demo's page for colleagues, once the owner shared it (or is about to). */
  share?: Share;
  /** Where the repository's site publishes on approval: the owner unticked "Share on approval", so approving shares nothing. */
  notOnApproval?: true;
  /**
   * The tags of the card's page (`pageTags` in src/core/page-tags.ts), by dimension, as they stand
   * without the site's vocabulary: set by hand, else by the newest worker that gave them, else by
   * Obeya's reading session. A dimension without a key has none chosen yet.
   */
  tags?: PageTags;
  /** When something last happened at the card (a change of state, a line in its conversation, an edit); moving it does not count. */
  changedAt?: string;
  /** The card it comes from: a proposal's source, a prototype's idea, or the card a follow-up follows up on. */
  from?: string;
  /** With `from` on another canvas (a card moved there, or one made there by Obeya): that card's title and canvas. */
  fromElsewhere?: Elsewhere;
  /** A card the work retrospective proposed: the cards and the friction on them it rests on. */
  retro?: string;
  /** A worker's proposal, while it waits: an idea or a task, why, and what the owner has to decide. */
  proposal?: Proposal;
  /** An agent's proposal the owner accepted: its text is that agent's. */
  proposed?: true;
  /** An accepted proposal its agent withdrew or replaced since, while the card is not finished: the owner removes it or keeps it. */
  superseded?: Superseded;
  /** The repository the card belongs to (an id from the canvas's `repos`). */
  repo: string;
  /**
   * Before work begins on a task or an idea of the owner's: it is to be built in a repository that
   * does not exist yet (`NewRepo`), as the owner or the idea's agent chose. Building or starting it
   * creates that repository first.
   */
  newRepo?: NewRepo;
  /**
   * Its repository does not run on the canvas (it left the configuration, or did not start): its
   * agents take nothing until it is back, and no other repository's agents take it meanwhile.
   * Never on a Question card, whose agent reads only.
   */
  repoDown?: true;
  branch?: string;
  /** Where the branch is checked out, while the card has a workspace: a directory, `host:/dir` on another machine. */
  workspace?: string;
  /** The clone that keeps its branch since its workspace was taken from it, until it works again (the same form as `workspace`). */
  keptIn?: string;
  /** Files the Coordinator expects the card to change. */
  scope?: string[];
  /** A planned card the Coordinator is deciding on, or that waits for cards in progress. */
  queue?: Queue;
  /** The pull request, once the worker opened it after approval; on a review card, the one it reviews. */
  pr?: PullRequest;
  /**
   * Further pull requests the worker opened for the card's work, in other repositories (or a second
   * one in its own): the card is live once all of them and `pr` are merged.
   */
  morePrs?: PullRequest[];
  /** A review card: the pull request of someone outside that the card reviews and, once approved, merges. */
  contribution?: Contribution;
  /**
   * A workstream planned again: a part of it landed (this commit, this pull request), but its plan
   * doc keeps it open. A new run does the rest.
   */
  landedPart?: { commit?: string; pr?: { url: string; number: number } };
  /** When the owner archived the card; archived cards are not on the canvas but in its archive. */
  archivedAt?: string;
  /** Ideas only: what the discussion has settled so far. */
  idea?: Idea;
  /** Question cards, and an idea that was one: the thread of looked-up answers it holds. */
  thread?: Thread;
  /** A prototype's idea: the throwaway prototype is built for it and never lands itself. */
  prototypeOf?: string;
  /** A prototype of one of the variants its idea's agent planned: that variant's approach. */
  variant?: string;
  /** A prototype in the archive: discarded (its code thrown away), or built (its idea was built on its branch). */
  prototypeEnd?: 'discarded' | 'built';
  /** A prototype built for a workstream of the project its idea became: that workstream (W6 "Build the page"). */
  builtInto?: string;
  /** A prototype: its idea's title, wherever the idea is (on the canvas, or in the archive once it became a project). */
  ideaTitle?: string;
  /** A prototype whose worker proposes to build the idea on it: why, in its words. */
  buildProposal?: string;
  /** Ideas: their prototypes, on the canvas or in the archive, the oldest first; each shows its demo on the idea. A workstream built on a prototype: that one. */
  prototypes?: Item[];
  /** A card that was an idea, or a workstream of the project an idea became, built on the branch of one of the idea's prototypes: that prototype. */
  builtOn?: string;
  /** Built on a prototype's branch, and no agent has worked on it since: it is planned, not stopped. */
  unstarted?: true;
  /** The work has landed and its worker finishes what remains (a migration, say) before its session ends. */
  finishing?: boolean;
  /** While `finishing`: nothing just landed, the owner asked about the finished card and its agent answers. */
  followUp?: boolean;
  /** While `followUp`: its agent needs a full clone to answer and waits, without a workspace, for the next free one. */
  waitsForClone?: true;
  /**
   * Its worker is in a turn right now, its background work included (a render, a watcher): what it
   * does shows, and the owner can pause it. Not on a card that waits for the owner once the turn
   * itself has ended and only its background work runs (the app served after the handover).
   */
  inTurn?: true;
  /** Its worker ended its turn for the restart that is due (another card's code landed, say) and goes on once Obeya runs again: no agent works on it meanwhile. */
  restartPaused?: true;
  /** The worker's background work that runs (a test run, a render, a watcher), the oldest first: while `inTurn`, or after the turn on a card that waits for the owner. */
  background?: BackgroundTask[];
  /**
   * The card's agent other than its worker (an idea's, a Question card's, the reviser of a proposal,
   * the Coordinator naming or checking it) waits for the account's usage limit: it goes on by itself then (ISO time).
   */
  limitedUntil?: string;
  /** Since when it waits for the owner (`needsYou`), for the phone view's "Needs you". */
  waitingSince?: string;
  /**
   * The owner paused the card's agent (its worker, the idea's agent, the Question card's agent):
   * nothing of it runs, its session stays, and it goes on where it stopped with "Resume" or
   * the owner's next words to it.
   */
  paused?: true;
  /**
   * The owner asked the card's agent to pause once it has brought its work to a safe point (the
   * card's pause, the canvas's): it works on until its turn ends, and is `paused` then.
   */
  pausing?: true;
  /** Set aside until a point in time: nothing of its agent runs, and it does not wait for the owner meanwhile. */
  snoozed?: Snooze;
  /**
   * Where the app in the card's workspace runs, as its worker opens it (`http://localhost:5173`):
   * while the worker says it runs and Obeya has not stopped it. The card offers it to the owner to
   * try by hand, once it answers.
   */
  app?: string;
  /** The harness, model and effort the card's agent session runs on, the model as the harness named it when the session started (`claude-opus-5-5`). */
  runsOn?: { harness: Harness; model: string; effort?: AgentEffort };
  /**
   * What the card's agents cost so far in US dollars, estimated at API list prices (a project's: its
   * project agent's and its workstreams'); none before any reported a cost. Counted whether or not
   * the owner has costs shown (`CostsView`).
   */
  spent?: number;
  /** The harness, model and effort the owner chose for this card's agent, over its group's (`CardAgent`); absent: the group's. */
  agent?: CardAgent;
  /** Waiting for approval, its branch holds no change (checked at the handover): approving makes the card `done`. */
  noChange?: boolean;
  /**
   * Waiting for approval, its branch changes how work lands (`.obeya/settings.json`, checked at the
   * handover): approving lands it as the branch says, not as the repository does until then.
   */
  lands?: CardLanding;
  /**
   * Screenshots the owner attached to the card's task; its worker gets them at the start. On a
   * proposal, those that go with its task once it is accepted (the owner's or its reviser's pick).
   */
  images?: string[];
  /** A card that was an idea and has been decided: the brief it was decided on. */
  brief?: string;
  /** A card that was an idea and has been decided: the mocks of its brief. */
  mocks?: Mock[];
  /** An idea or a task of the owner's, decided as a project: its worker writes the plan doc, and the project takes its place. */
  becomesProject?: boolean;
  /** A project the owner folded to its head: its workstreams are not shown on the canvas, only counted in it. */
  collapsed?: true;
  /** The group the card belongs to (a `Group` id); a workstream's is its project's. */
  group?: string;
}

/** A year: no card is snoozed longer, nor set to start later than that. */
const SNOOZE_LIMIT = 366 * 24 * 60 * 60_000;

/** Whether a card can be snoozed until or set to start at `at` (ms; NaN: no time): only within the coming year. */
export function laterTime(at: number, now = Date.now()): 'none' | 'past' | 'far' | 'ok' {
  if (Number.isNaN(at)) return 'none';
  if (at <= now) return 'past';
  return at > now + SNOOZE_LIMIT ? 'far' : 'ok';
}

/**
 * A card set aside until a point in time (`CardRow.snoozed`): by its worker, which has nothing to do
 * until then (a test that runs for days, a check at midnight), or by the owner; or by its worker
 * until another card reaches a state (`on`). Obeya holds the time and the card and wakes it then;
 * the owner's words, "Wake now", or what Obeya has for an agent that snoozed itself wake it
 * earlier.
 */
export interface Snooze {
  /** When it wakes (ISO); without one, it wakes when the card it waits on gets there. */
  until?: string;
  /** The card of the canvas it waits on (as its title read then), and what for: it wakes once that card got there, or no longer can. */
  on?: { card: string; title: string; state: AwaitedState };
  by: 'agent' | 'owner';
  /** What the agent does once it wakes, in its words. */
  why?: string;
  /** It waited for the owner when they snoozed it: it comes back to them at the time, and nothing goes to its agent. */
  waiting?: true;
  /** The owner changed the time its agent snoozed until: the agent hears so when it wakes. */
  moved?: true;
  /** It is planned: it starts at the time, through the Coordinator, as if started then. */
  start?: true;
  /**
   * A review card the owner set aside until its contributor (`author`) writes on the pull request or
   * pushes, whichever they do first, counting from `since` (when the card came to wait for the owner);
   * with a time too, at the latest then. Its worker then reviews again.
   */
  contributor?: { author: string; since: string };
}

/**
 * A group of cards on the canvas, shown as a coloured territory behind them. It exists while a card
 * belongs to it (on the canvas or in the archive).
 */
export interface Group {
  id: string;
  name: string;
  /** Its colour's hue, 0–359. */
  hue: number;
}

/**
 * What a worker proposes beyond the card's text, which it writes for the agent that will take the
 * card on. Accepting it writes the questions into the text: those the owner answered on the
 * proposal as decided, the others as open.
 */
export interface Proposal {
  /** Something to think through with the owner first: accepted, it becomes an idea. */
  idea?: boolean;
  /** Why the worker proposes it, for the owner only; the card's text does not say it. */
  reason?: string;
  questions: Question[];
  /**
   * What the owner said it should become (`spoken`: through speech recognition; `said`: the lines of
   * the log with these words), while an agent reworks the text, the reason and the questions by it;
   * `next`: what they said meanwhile, which the rework after it takes in.
   */
  revising?: Revising & { next?: Revising[] };
  /**
   * "Accept and start" was clicked while it was reworked (`idea`: "Discuss as an idea"): it
   * is accepted once the new text is there, unless that asks questions.
   */
  acceptAfterRevision?: true | 'idea';
  /** Its agent withdrew it or replaced it by another proposal of its own (`withdraw_proposal`, `propose_card` with `replaces`). */
  superseded?: Superseded;
  /**
   * When it is to start (ISO), for a check that can only be done later (`propose_card` with
   * `start_at`): accepted, it is planned and snoozed until then, and starts at the time.
   */
  startAt?: string;
  /**
   * Obeya's own proposal of a card that sets up a repository: the one that fills in its settings,
   * while Obeya knows them not yet (design: Repositories and configuration), or the one that gives
   * its shared pages a theme (design: Sharing demos). Accepted, it is the owner's card like the one
   * the Configuration dialog makes.
   */
  setup?: true;
}

/**
 * An agent's proposal its agent withdrew or replaced: still open, it went at once; already accepted,
 * the card carries this until the owner removes it or keeps it.
 */
export interface Superseded {
  /** The proposal that takes its place, and its title then; none when it was withdrawn without one. */
  by?: string;
  title?: string;
  /** Why, in the agent's words. */
  why?: string;
}

/** The owner's words a proposal is reworked by, with the screenshots that came with them (image ids). */
export interface Revising {
  words: string;
  spoken?: boolean;
  said?: number[];
  images?: string[];
}

/** A decision taken on a card: an answer to a worker's question, or the owner's call on an idea. */
export interface Decision {
  id: number;
  cardId: string;
  question: string;
  answer: string;
  by: 'owner' | 'project' | 'coordinator';
  at: string;
}

/** What a project's sheet shows beyond the project: its decisions and the idea it came from. */
export interface ProjectHistory {
  /** The project's decisions and those of its idea, oldest first. */
  decisions: Decision[];
  /** The idea the plan doc was written from, wherever it is now (on the canvas or archived). */
  origin: Item | null;
  /** The questions its project agent answered (asked in its sheet or of Obeya) and their follow-ups, oldest first. */
  talk: Talk[];
}

/**
 * An idea under discussion with its exploration agent. `open` while it is discussed; parked or
 * dropped ideas stay on the canvas with their state, and talking to them opens them again.
 */
export interface Idea {
  status: 'open' | 'parked' | 'dropped';
  /** The state of the idea as the agent keeps it (markdown): goal, variants, decisions, open questions. */
  brief: string;
  /** The exploration agent is working on a reply. */
  thinking: boolean;
  /** "Build it like this" was clicked while the agent worked on a reply: the idea is built once the reply is there, unless it asks questions. */
  buildAfterReply?: true;
  /** The agent replied and the owner has not answered yet: an open idea then needs the owner. */
  yourTurn: boolean;
  /** The questions of the agent's latest reply, until the owner says something. */
  questions: Question[];
  /** What the agent would do next in the owner's place, from its latest reply, until the owner says something. */
  next?: NextStep;
  /** The prototypes the brief plans, one per variant: "Have a prototype built" offers them, to start at once. */
  variants: PlannedPrototype[];
  /** How the brief's variants look, one mock each, shown beside it. */
  mocks: Mock[];
  /** The part that is settled while the rest is open: "Split off a task" builds it as a task of its own. */
  split?: SettledPart;
}

/** The thread of looked-up answers a Question card holds, as its card shows it. */
export interface Thread {
  /** The exchange with Obeya the thread started with: its id names the thread and its output directory. */
  talk: number;
  /** Its agent is reading, for what the owner asked on the card. */
  thinking?: boolean;
  answers: number;
  files: number;
}

/** A file a looked-up answer comes with, in its thread's output directory: its path there and a one-line caption. */
export interface AnswerFile {
  name: string;
  caption: string;
}

/**
 * What makes a message a looked-up answer: the thread it belongs to (whose output directory holds
 * its files), its files, and the question of the answer it continues.
 */
export interface AnswerRef {
  thread: number;
  files?: AnswerFile[];
  continues?: string;
  /** Its walkthrough plays while the agent still tells it: the answer's words take this message's place once they come. */
  live?: true;
}

/** A few lines of HTML the idea's agent writes to show how something would look; the card shows it in a sandboxed frame. */
export interface Mock {
  title: string;
  html: string;
}

/** A prototype the idea's agent plans: its approach in a few words (its title) and what it builds and shows (its task). */
export interface PlannedPrototype {
  approach: string;
  show: string;
}

/**
 * The part of an idea that is settled while the rest is still open, as its agent marks it: what
 * "Split off a task" makes a task of its own, the idea staying with what is open.
 */
export interface SettledPart {
  title: string;
  brief: string;
}

/** The owner's next click on an idea: answer its questions, or one of the decisions on the card. */
export const NEXT_STEPS = ['answer', 'build', 'splitOff', 'planDoc', 'prototype', 'park', 'drop'] as const;
export interface NextStep {
  step: (typeof NEXT_STEPS)[number];
  why: string;
}

export interface PullRequest {
  url: string;
  number: number;
  /** `owner/name` of its repository, where that is another than the card's. */
  repo?: string;
  /** Merged already, while the card waits for its other pull requests. */
  merged?: boolean;
  /** Closed without a merge. */
  closed?: boolean;
  /** What it waits for before it is merged, as last polled (`PrWait`); none once it is ready. */
  waits?: PrWait[];
  /** Checks on the PR's latest commit, as last seen. */
  checks: { name: string; state: 'pending' | 'success' | 'failure'; url?: string }[];
  conflict: boolean;
  /**
   * Nothing is left for the worker (checks green, threads resolved, reviewers answered), and GitHub
   * refused Obeya's merge for `mergeError`, or the reviewer's confidence is too low for Obeya to
   * merge (`held`, Greptile's 3/5 say), or the repository's settings leave the merge to the people
   * on the forge (`manual`, `autoMerge` off): the owner merges, or tells the worker what is missing.
   */
  ready?: boolean;
  mergeError?: string;
  held?: { score: string; by: string };
  manual?: boolean;
  /** The review as last seen, oldest first (`reviewOf` in the server's forge). */
  review?: PrReviewEntry[];
}

/**
 * What a pull request waits for before it can be merged, in the order it is in the way: a conflict,
 * a branch behind its base that the repository wants up to date, a draft, branch protection (an
 * approval, a required check), the forge not having worked out mergeability yet, checks failed or
 * running, review threads open, a reviewer's standing request for changes, a review of an older
 * commit than its newest, an answer to the
 * author's request for another look, and the worker at work on something passed to it.
 */
export type PrWait = 'conflict' | 'behind' | 'draft' | 'protection' | 'forge' | 'checksFailed' | 'checks' | 'threads' | 'changes' | 'review' | 'answer' | 'agent';

/**
 * The pull request a review card reviews: opened by someone outside (the contributor), reviewed by
 * the card's worker and merged by Obeya once the owner approves its demo.
 */
export interface Contribution {
  url: string;
  number: number;
  /** The contributor's account on the forge. */
  author: string;
  title: string;
  /** The contributor allows maintainers to push to the PR's branch (GitHub's "Allow edits by maintainers"). */
  canModify: boolean;
  /** What the worker found at its latest handover: the checks on the PR's head, whether it merges into the current main without conflicts. */
  results?: ReviewResults;
  /** The review's findings as the worker keeps them, for the owner to decide on one by one; none until it recorded them. */
  findings?: Finding[];
  /** The worker's change request on the PR, while the card waits for the contributor. */
  requested?: { url?: string; at: string };
  /** The worker's own commits for the PR, held on the card until the owner approves (`HeldChanges`). */
  held?: HeldChanges;
  /** Where work lands on the local main: its unpushed commits collide with the PR, as Obeya found before the merge. */
  clash?: Clash;
}

/**
 * What a review card's worker changed itself on the PR, held on the card: on the owner's approval
 * Obeya pushes its `commits` onto the PR's branch and posts `body` there, as a comment, or with
 * requests to the contributor (the findings `asks`) as one review asking for changes.
 */
export interface HeldChanges {
  body: string;
  commits: number;
  asks: number[];
}

/**
 * Commits on the local main nobody pushed yet that a pull request collides with: once it is merged,
 * pulling it into the local main stops at `commit` (`subject`, and the card that landed it, where
 * one did), in `files`; `unpushed` is how many such commits the local main has.
 */
export interface Clash {
  commit: string;
  subject: string;
  files: string[];
  unpushed: number;
  card?: { id: string; title: string };
}

/**
 * What the owner decides for a finding of a review card: it goes to the contributor as a change
 * request, (`self`) the worker makes the change, which Obeya pushes onto the PR's branch on the
 * owner's approval, (`later`) it becomes a follow-up task of its own, outside the PR, or (`drop`)
 * nobody pursues it.
 */
export type ChangeRoute = 'contributor' | 'self' | 'later' | 'drop';

/** What approving a review card did instead of merging: its PR conflicts with main, which its agent resolves, or only the contributor can. */
export type ApproveResult = { conflict: 'agent' | 'contributor' } | undefined;

/** One finding of a review card's review, as its worker keeps it. */
export interface Finding {
  /** Its number on the card, kept while the worker rewrites the list. */
  id: number;
  title: string;
  text: string;
  security?: boolean;
  /**
   * `open` until something came of it: `sent` to the contributor (`url`, the review it went in),
   * `fixed` by the worker (`url`, the post its push went out with, once Obeya pushed it), `resolved` (the contributor's push fixed it, or it no
   * longer applies), `dropped` (the owner does not pursue it), `later` (a follow-up task, `card`,
   * which the worker makes once the owner chose it).
   */
  status: FindingStatus;
  url?: string;
  /** The follow-up task the worker made of it, on the owner's word; several findings may share one. */
  card?: string;
  /** What the owner decided for it, while the worker carries it out; one they ignore is `dropped` at once. */
  decided?: Exclude<ChangeRoute, 'drop'>;
  /** Decided for the contributor while the worker's own changes are under way or held: the request goes with them, as one message. */
  withChanges?: true;
  /** The other findings its worker would make one follow-up task with it (their ids), in both directions. */
  with?: number[];
}

export type FindingStatus = 'open' | 'sent' | 'fixed' | 'resolved' | 'dropped' | 'later';

/** What the worker of a review card reports with its handover. */
export interface ReviewResults {
  checks: { name: string; passed: boolean }[];
  /** It merges into the current main without conflicts. */
  mergeable: boolean;
}

/** A comment on a pull request; `mine` when the PR's author wrote it (the worker, in the owner's name). */
export interface PrComment {
  author: string;
  mine?: boolean;
  body: string;
  /** When it was written, or last changed when `edited`. */
  at: string;
  edited?: boolean;
  url?: string;
}

/** A reviewer's comment on the code and the replies in its thread. */
export interface PrThread extends PrComment {
  path?: string;
  line?: number;
  resolved: boolean;
  replies: PrComment[];
}

/** A round of a reviewer's comments on the code, or a comment in the conversation. */
export type PrReviewEntry = { author: string; mine?: boolean; at: string; threads: PrThread[] } | PrComment;

/**
 * How long a project's workstreams, started together, wait before the Coordinator plans them: the
 * owner can take the start back until then (a button on the project card is easily hit).
 */
export const START_ALL_HOLD_MS = 8000;

/** How long taking a card's workspace from it (the Workspaces list) waits for the owner's "Undo". */
export const EVICT_HOLD_MS = 8000;

/** How long pushing main for a review card whose PR collides with unpushed commits waits for the owner's "Undo". */
export const PUSH_HOLD_MS = 8000;

/**
 * `since`: when the card came to the Coordinator; of the cards whose turn comes, the one waiting
 * longest goes first. `together`: the project whose workstreams the Coordinator judges all at once.
 * `workspace`: the Coordinator let the card start, but no workspace was free for it (`none`: all
 * leased or none set up; `dirty`: every free one has uncommitted changes); it starts once one is.
 * `behind`: the cards it waits for; `buildsOn`: those of them it builds on (workstreams of its
 * project), which hold it until they have landed, also while not started or stopped.
 * `manualWait`: those of `behind` that only an arrow the owner drew holds it for, not a wait the
 * Coordinator inferred; `buildsOn` names inferred waits alone.
 * `paused`: the Coordinator let it start, but the owner paused its canvas's agents; it starts once they resume them.
 * `begun`, on a card waiting for a workspace or a paused canvas: the owner started it anyway, or it
 * was at work before (its workspace taken from it); the owner's arrows no longer hold it.
 */
export type Queue = Wait & { since: string };

/**
 * What a card in the queue waits for (`Queue`). `together`: judged in one turn with the cards of the
 * same key, a project's workstreams started at once (the project's id) or cards freed at once (`freed:…`).
 */
export type Wait = { checking: true; together?: string } | { behind: string[]; reason: string; buildsOn?: string[]; manualWait?: string[] } | { workspace: WorkspaceShortage; begun?: true } | { paused: true; begun?: true };

/** Why a card waits to start: no clone free (`none`), the free ones dirty, or every machine with a clean free one busy to its slots (`slots`). */
export type WorkspaceShortage = 'none' | 'dirty' | 'slots';

/**
 * How a demo shows the work: a narrated `video` of something that happens, or an `html` artifact
 * to look at (design drafts side by side, a layout, an analysis).
 */
export type DemoKind = 'video' | 'html';

export interface Demo {
  kind: DemoKind;
  /** Seconds and title of each scene; none for an HTML artifact. */
  chapters: [number, string][];
  /** A question only the owner can answer, beyond "approve or give feedback". */
  question?: string;
  /** Its answer options, several of them together when `multiple`, and the worker's own pick, as on a worker's question. */
  options?: string[];
  multiple?: true;
  pick?: Question['pick'];
  /** The owner's answer to it; the demo keeps waiting for approval. */
  answer?: string;
  /** The handover event it came with: a later handover may keep the demo, and its question stays with the first. */
  handover?: number;
  /**
   * It came with the worker's question (`handover` is then that question's event): drafts or variants
   * to choose between, not the result of the work, so a handover does not keep it as its demo.
   */
  asked?: true;
  /** When that handover was. */
  at?: string;
  /** The page it is shared on, for colleagues who have never seen Obeya: written by the worker at handover, or later from its summary. */
  page?: DemoPage;
  /** An HTML artifact that is its `index.html` alone: it also goes out as one HTML file. */
  single?: true;
  /**
   * What its worker said of it beside the demo before: recorded afresh (`replaces`), or only showing
   * a detail corrected or explained since (`supplements`), to share beside that one.
   */
  follows?: 'replaces' | 'supplements';
  /** A video without `poster.jpg` (one the demo skill did not render): the player shows its first frame instead. */
  noPoster?: true;
  /** A video's caption tracks by language, in their order, each in `captions.<language>.vtt` (empty: no subtitles); missing for one with `captions.vtt` alone. */
  tracks?: string[];
  /** A video without sound: its captions show from the start. */
  silent?: true;
  /** A video's width and height in pixels, read at the handover: the player has its shape before the video's first bytes arrive. */
  size?: [number, number];
}

/** The size of a card's change (`Item.changeSize`): the lines of its change list (`changeRows`), and the lines added and removed. */
export interface ChangeSize {
  files: number;
  added: number;
  removed: number;
}

/** A demo a later handover replaced: `n` is its place among the card's earlier demos, for its files. */
export type EarlierDemo = Demo & { n: number };

/**
 * What goes on a shared page with the card's demo `i` (of its demos, the oldest first): that demo
 * and, while one supplements the demo before it (`follows`), that one too, the oldest first. A page
 * never shows a supplement without what it supplements.
 */
export function withSupplemented<T extends Pick<Demo, 'follows'>>(demos: T[], i: number): T[] {
  let first = i;
  while (first > 0 && demos[first]!.follows === 'supplements') first--;
  return demos.slice(first, i + 1);
}

/** Which of the demo's chapters plays at `at` seconds (the first before any starts); a seek lands a little before a chapter's start. */
export const chapterAt = (chapters: Demo['chapters'], at: number) => chapters.reduce((cur, [start], i) => (start <= at + 0.05 ? i : cur), 0);

export interface DemoPage {
  title: string;
  /** Two to five sentences on what changes and why. */
  text: string;
  /** The values of the site's vocabulary (`demo.site.tags`) the worker chose for each dimension; an empty list where none fits. */
  tags?: PageTags;
}

/** Tags by dimension: a site's vocabulary (each dimension with its values), or what a page carries of it. */
export type PageTags = Record<string, string[]>;

/**
 * The largest video exported as one HTML file (which holds it in base64, a third larger): such a
 * file still goes by mail. A larger one is exported as a ZIP only.
 */
export const EXPORT_HTML_MAX = 15 * 1024 * 1024;

/**
 * A card's shared demo page. `publishing` while it goes out, `shared` once the page is
 * up, `withdrawing` while it is taken down.
 */
export interface Share {
  state: 'publishing' | 'shared' | 'withdrawing';
  /** The page; set once it was published, kept while it is published again. */
  url?: string;
  /** The card's demos on the page, by their handovers (`Demo.handover`), the oldest first. */
  on?: number[];
  /** The card's latest demo is not on the page. */
  stale?: boolean;
  /** The page shows the card's demo, but pages changed since it was published ("Share again"): those changes, oldest first. */
  outdated?: OutdatedBy[];
  /** The page is on the owner’s personal demo site, unlisted (behind a random part of its address). */
  unlisted?: true;
}

/** The kinds of screenshot the owner can attach, with the extension each is stored under. */
export const IMAGE_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
/** What the model takes per image (5 MB base64); the browser scales screenshots down to fit. */
export const MAX_IMAGE_BYTES = 3_750_000;
/** The largest other file the owner may drop into what they write; its path goes to the agent. */
export const MAX_FILE_BYTES = 100_000_000;

/** One line in a card's log. */
export interface CardEvent {
  id: number;
  cardId: string;
  at: string;
  /**
   * `talk` is the discussion of an idea: the owner's messages and the exploration agent's replies.
   * `closing`: a worker's closing words after its reply or handover, which mostly repeat it: they
   * fold under that message. `denied`: a tool call of the worker's refused without asking anyone,
   * with who refused it and why.
   */
  kind: 'report' | 'activity' | 'say' | 'closing' | 'question' | 'answer' | 'hint' | 'review' | 'state' | 'error' | 'talk' | 'denied';
  author: 'worker' | 'owner' | 'project' | 'coordinator' | 'obeya' | 'explorer';
  text: string;
  /** Set on an error the UI words itself; `text` then holds the server's technical detail. */
  code?: ErrorCode;
  /** Screenshots the owner attached (ids under `/api/c/<canvas>/images/`). */
  images?: string[];
  /** The mocks of an exploration agent's reply. */
  mocks?: Mock[];
  /** The owner's words: the message of the conversation they reply to (its id), shown above them as a quote. */
  replyTo?: number;
  /** The owner's words: the place in the card's demo video they are about. */
  spot?: Spot;
  /** A looked-up answer: its exchange and thread, and its files. */
  answer?: AnswerRef;
  /** The owner's answer to a worker's question: the options they picked, which lead its text (`pickedAnswer`). */
  picks?: string[];
  /** The owner's words the card's agent has not read yet: Obeya holds them for it, and the owner can still take them back. */
  unread?: true;
  /** The owner's words the agent read later than they were written: they stand after this line of the log, where it read them. */
  readAfter?: number;
  /** Obeya's reply on the card says it cannot do what the owner asked (or the owner asked to tell its makers): what a draft for them starts from. */
  wish?: Wish;
  /**
   * Obeya's reply on the card answers the owner's words without acting on them (no actions to take
   * back): it stands in the conversation, where the confirmation of actions folds away.
   */
  reply?: true;
  /**
   * Obeya's reply to what the card's agent passed on from the owner's words (`to_obeya`): it answers
   * a step of the agent's, so it stands under the agent's message that step leads to.
   */
  forwarded?: true;
  /**
   * An error of a session that signed in to Claude with a token (Obeya's `claude-token` or
   * `CLAUDE_CODE_OAUTH_TOKEN`; on another machine, without one, that machine's own login), not with
   * this machine's account: signing in again here does not renew it, a new token does.
   */
  token?: true;
}

/** Obeya's line that a worker started on the card afresh: what it handed over before belongs to an earlier run. */
export const started = (e: Pick<CardEvent, 'kind' | 'author' | 'text'>) => e.kind === 'state' && e.author === 'obeya' && /^(Agent gestartet|Agent started)/.test(e.text);

/** The owner's answer as the log holds it: the options picked, then their own words. */
export const pickedAnswer = (picks: string[], words: string) => [picks.join(', '), words.trim()].filter(Boolean).join('\n\n');

/** The owner's own words in an answer, without the options picked that lead it. */
export function ownWords(e: Pick<CardEvent, 'text' | 'picks'>): string {
  const lead = e.picks?.join(', ');
  return lead && e.text.startsWith(lead) ? e.text.slice(lead.length).trim() : e.text;
}

/** A place in a card's demo video the owner's words are about, as the worker reads it with them. */
export interface Spot {
  /** Seconds into the video. */
  at: number;
  /** The chapter playing there. */
  chapter?: string;
  /** What the narration says around there. */
  narration?: string;
  /** The frame there, taken in the browser (an image id like a screenshot's). */
  still?: string;
  /** The demo it is in, by the handover it came with (`Demo.handover`): the card's demo then, or an earlier one the owner went back to. */
  demo?: number;
  /** It is in a demo a later handover replaced. */
  earlier?: true;
}

/** A place in the demo video as the browser sends it with the owner's words: Obeya adds chapter and narration. */
export type SpotInput = Pick<Spot, 'at' | 'still' | 'demo'>;

export interface CanvasInfo {
  id: string;
  name: string;
  /** The repositories on the canvas; the first is its home. */
  repos: RepoRef[];
  /** How many times which of its repositories do not run as the configuration has them changed: the page reads the configuration's problems again when it changes. */
  configRev?: number;
  /** The owner paused the canvas's agents: cards the Coordinator lets start wait in the queue until they resume them. */
  paused?: true;
  /** Its agents at work now (`pausable`) and those the owner paused or that are about to pause (`halted`), for the canvas switcher; absent while none is either. */
  agents?: { running: number; paused: number };
}

export interface RepoRef {
  id: string;
  name: string;
  path: string;
  branch: string;
  /** A folder without git: cards work in it directly, with no branches, landing, pull requests, prototypes or hosts. */
  folder?: true;
  /** It has a share target: demos go to a page outside Obeya (the configuration's command, or the `demo.site` of the repository's settings); without one they are exported as a file. */
  share?: boolean;
  /** The demo site of its settings needs an env file this machine lacks (as the settings name it, relative to Obeya's home): demos are exported meanwhile. */
  shareNeeds?: { site: string; file: string };
  /**
   * With `share`: each approved card's latest demo goes on the page by itself, unless the card opts
   * out: its site publishes on approval (`demo.site.publish`), or it shares on the owner's personal
   * site and the owner ticked it there for that.
   */
  shareOnApproval?: true;
  /** With `share`: the site's vocabulary of tags (`demo.site.tags`), which a card's page takes its tags from. */
  shareTags?: PageTags;
  /** With `share`: its demos go to the owner's personal site (it has no site of its own this machine can deploy to). */
  shareOnPersonal?: true;
  /** With `shareOnPersonal`: the personal site is unlisted. */
  shareUnlisted?: true;
  /** Without `share`: why the owner's personal site does not take its demos: none is set up on this machine, or the repository is private and not ticked for it. */
  sharePersonal?: 'none' | 'private';
  /** Its approved work goes out as a pull request (else it lands on the default branch of the Obeya checkout). */
  pullRequests?: boolean;
  /** Its `origin` is on a server, where others may open pull requests ("Review PR #5"). */
  forge?: true;
  /** With `pullRequests`: the owner may have approved work pushed directly onto the default branch instead (`direct` of its settings). */
  direct?: boolean;
  /**
   * How many times what the configuration's problems of the repository are read from changed on
   * its default branch while the canvas runs (its `.obeya/settings.json`, a leftover
   * `.obeya/adapter/`): the page reads the problems again when it changes.
   */
  configRev?: number;
}

/** A repository's pool of clones, by the machine they are on, in the order new cards go there; or its slots for workers in worktrees. */
export interface ClonePool {
  repo: string;
  hosts: PoolHost[];
}

/** A machine's part of a pool: its clones and the cards that hold them, and how many of their workers may be busy at once. */
export interface PoolHost {
  /** The host's name in the configuration; for the machine Obeya runs on, its own name. */
  name: string;
  /** The machine Obeya runs on. */
  here?: boolean;
  /** Its workers work in worktrees: `total` is its slots, and `cards` those of the workers at work. */
  worktrees?: boolean;
  /** How many of its workers may be in a turn at once; a new card goes elsewhere or waits once they are. */
  slots: number;
  /** Its clones: how many, and the cards that hold one now. */
  total: number;
  cards: string[];
  /** The cards whose worker is in a turn there now. */
  busy: string[];
  /** The folders of clones Obeya made that left the pool and stay, since something in them would be lost, with what. */
  kept?: KeptClone[];
  /** Its free clones no new card gets now, by their last look; none when every free clone can be taken. */
  blocked?: BlockedClone[];
  /** Each of its clones (free ones too), or worktrees, by path there and with the card that holds it. */
  workspaces: PoolWorkspace[];
}

/** A clone or worktree in the pool: its path on its machine, the card holding it (`card`, `title`). */
export interface PoolWorkspace {
  path: string;
  card?: string;
  /** The holding card's title, also for a card not on the canvas (in the archive, say). */
  title?: string;
  /** The canvas of a holding card that lies on another canvas than the pool's. */
  canvas?: string;
  /** Its card may give it up for a card waiting for one ("Give to the waiting card": its worker stops, its work is kept on its branch). */
  takeable?: true;
  /** Its card gives it up once the undo window of "Give to the waiting card" is through. */
  leaving?: true;
}

/** The folder of a clone Obeya made that left the pool and stays (its path there), and what would be lost with it. */
export interface KeptClone {
  path: string;
  lost: LostWork[];
}

/**
 * What lies in a clone's folder that would be lost with it: submodules (not looked into), worktrees
 * made from it in use, changes not committed or files not in git (`n` of them), a stash, or a ref
 * (`kind`, its `name`: a branch, a tag, a detached HEAD) with `n` commits that are not on `origin`.
 */
export type LostWork =
  | { what: 'submodules' }
  | { what: 'worktrees'; n: number }
  | { what: 'changes'; n: number }
  | { what: 'stash' }
  | { what: 'commits'; kind: 'branch' | 'tag' | 'head' | 'ref'; name: string; n: number };

/**
 * A free clone no new card gets now, and why, for the owner to put right: `dirty`, uncommitted
 * changes (the first `files`, `more` beyond them); `broken`, git fails in it (`error`); `missing`,
 * its folder is not there; `unreachable`, its machine does not answer over SSH; `failed`, git
 * failed making it ready for a card a moment ago (`error`), so it is passed over for a minute.
 * `made`: a clone Obeya made, which its next start makes again where the folder is missing.
 */
export interface BlockedClone {
  /** Its path on its machine. */
  path: string;
  why: 'dirty' | 'broken' | 'missing' | 'unreachable' | 'failed';
  files?: string[];
  more?: number;
  error?: string;
  made?: true;
  /** The branch checked out in it, as the last look found it. */
  branch?: string;
  /** The card whose branch that is, which left the changes there: on the canvas or not (`canvas`, `title`), and whether its work has landed. */
  by?: { card: string; title: string; canvas?: string; work: 'landed' | 'open' | 'none' };
}

export interface CanvasSnapshot {
  canvas: CanvasInfo;
  items: Item[];
  /** The canvas's groups, the oldest first. */
  groups: Group[];
  preferences: Preference[];
  /** The settings the work retrospective proposes for the canvas's repositories, waiting for the owner; none when none waits. */
  settingProposals?: SettingProposal[];
  /** The owner's latest exchanges with the Coordinator without an open card (those with one are in its log). */
  talk: Talk[];
  /** The clone pools of the repositories that use clones; none when no repository does. */
  workspaces?: ClonePool[];
  /** Shared pages their sites now write differently, and sharing many of them again; none when there is neither. */
  reshare?: Reshare;
  /** The plan directories the canvas has a note about (`PlanDir`); none when it has none. */
  planDirs?: PlanDir[];
  /** A mark of the archive that changes with anything it lists: the page reads what it shows of the archive again only then. */
  archive?: string;
  /** What all agents on the canvas cost so far in US dollars (its cards', archived ones too, and its own agents', the Coordinator's); none before any reported a cost. */
  spent?: number;
}

/**
 * A page of the archive as the page asks for it while the owner scrolls or searches, the most
 * recently archived first: each archived card, a project followed by its workstreams.
 */
export interface ArchivePage {
  items: Item[];
  /** Where the next page begins, to ask for it; none after the last. */
  next?: string;
  /** A search: how many cards it found in all. */
  found?: number;
  /**
   * The search across canvas and archive: the cards found on this page by id, a workstream among them
   * too, those with every word in the title first; `items` brings each with its project's entry.
   */
  hits?: string[];
}

/**
 * A repository's plan directory, shown as a note beside the projects (or where the owner put it): the docs in it that are not
 * projects, with the reason and the card preparing each as one (`preparing`), or, while the
 * repository has no plan doc and never had a project (`empty`), where the first one goes.
 */
export interface PlanDir {
  repo: string;
  /** As the repository's settings name it, `docs/plan`. */
  dir: string;
  empty: boolean;
  others: { file: string; reason: NotAProject; preparing?: string }[];
  /** Where the owner put the note, its top left on the canvas; without it, it stands above the projects. */
  at?: { x: number; y: number };
}

/**
 * Shared demo pages to bring up to date at once, from the Coordinator's sheet: how many are
 * outdated, and the run that shares them again one after the other.
 */
export interface Reshare {
  /** Pages that could be shared again and are not queued (after "Hide", those a newer change left outdated). */
  outdated: number;
  /** Shared pages on a site with a vocabulary that lack tags in a dimension (none chosen, or a value the vocabulary no longer has), not queued. */
  untagged?: number;
  /** What sharing them again brings: each change they lack, oldest first, with how many of them lack it. */
  changes?: { id: OutdatedBy; pages: number }[];
  run?: {
    total: number;
    /** Shared again. */
    done: number;
    /** Failed, with the reason in their card's log. */
    failed: { id: string; title: string }[];
    /** Still to go, the one going out now included. */
    left: number;
    /** The card whose page goes out now. */
    current?: string;
    /** The owner stopped it: the pages not yet out stay as they were. */
    stopped?: boolean;
    /** It tags the pages without tags and shares them again ("N pages without tags"), rather than sharing outdated ones again. */
    tags?: boolean;
  };
}

/** One exchange between the owner and the Coordinator. */
export interface Talk {
  id: number;
  at: string;
  /** What the owner said or typed. */
  said: string;
  /** Absent while the Coordinator reads the words. */
  reply?: string;
  /** The reply only answers the words (no actions to take back, no question looked up): a text answer "Show as walkthrough" can tell. */
  replyOnly?: true;
  /** The card that was open. */
  cardId?: string;
  /** The owner took the actions back. */
  undone?: boolean;
  /** Screenshots that came with the command; they went to the cards it created or concerned. */
  images?: string[];
  /** A question the Coordinator looks up; its answer comes later. */
  question?: string;
  answer?: string;
  /** Who answered: the Coordinator, or the project agent of the workstream asked about. */
  answerBy?: 'coordinator' | 'project';
  /** The answer came for the sheet, and the owner has not had the sheet in view since. */
  unread?: true;
  /** A looked-up question: the thread it belongs to (the id of the exchange that started it). */
  thread?: number;
  /** A follow-up: the exchange whose answer it continues, and that one's question. */
  follows?: number;
  continues?: string;
  /** The files the answer came with, in the thread's output directory. */
  files?: AnswerFile[];
  /** The thread moved onto a Question card: that card; its answers stand there from then on. */
  movedTo?: string;
  /** The message of the sheet the owner's words reply to, shown above them as a quote. */
  replyTo?: TalkQuote;
  /**
   * The reply says Obeya cannot do what the owner asked, or the owner asked to tell Obeya's makers
   * something: what a draft for them starts from, under a link on the reply.
   */
  wish?: Wish;
  /** The usage limit keeps the Coordinator from reading the words: it reads them by itself then (ISO time), the reply follows. */
  heldUntil?: string;
  /** The usage limit stopped the agent that looks the question up: it goes on by itself then (ISO time), the answer follows. */
  limitedUntil?: string;
  /** Cards the Coordinator waits on, as its reply said, to take a step once each gets there (`wait_for`). */
  waits?: TalkWait[];
  /** Words of no one: the Coordinator took them up by itself, since a card it waited on got there (or no longer can). */
  after?: TalkAfter;
  /** A question looked up for an action that needs its answer: the step the Coordinator takes once the answer is in, until it has decided it. */
  then?: string;
  /** Words of no one: the Coordinator took up the step it said it would take once the answer of that exchange was in. */
  answered?: number;
  /** Words of no one: a card left this canvas for another, built there in a new repository. */
  moved?: TalkMoved;
  /**
   * Written in this project's sheet: the words went straight to its project agent as a question
   * (`question` is the words), so Obeya has no reply of its own to them.
   */
  askedIn?: string;
}

/** A card that moved to another canvas: its id and title, and that canvas. */
export interface TalkMoved {
  card: string;
  title: string;
  canvas: string;
  canvasName: string;
}

/** A card the Coordinator waits on: until it is done or waits for the owner. */
export interface TalkWait {
  card: string;
  title: string;
  state: AwaitedState;
}

/** What became of the card the Coordinator waited on, which it took up again with: the exchange it said so in. */
export interface TalkAfter {
  title: string;
  state: AwaitedState;
  met: Awaited;
  from: number;
}

/** A message of Obeya's sheet: one part of an exchange, what the owner said, the Coordinator's reply or the looked-up answer. */
export interface TalkRef {
  talk: number;
  part: 'said' | 'reply' | 'answer';
}

/** A message of the sheet as a reply quotes it: who said it and what. */
export interface TalkQuote extends TalkRef {
  by: 'owner' | 'coordinator' | 'project';
  text: string;
}

export const isTalkRef = (r: unknown): r is TalkRef =>
  !!r && typeof r === 'object' && Number.isInteger((r as TalkRef).talk) && ['said', 'reply', 'answer'].includes((r as TalkRef).part);

/**
 * A lasting preference of the owner, learned by the Coordinator or written by the owner. A learned
 * one is a proposal until the owner accepts it; agents follow active ones only.
 */
export interface Preference {
  id: number;
  text: string;
  state: PreferenceState;
  /** The card whose exchange it was learned from. */
  cardId?: string;
  /** What the owner said there that it was learned from. */
  quote?: string;
  /** Proposed by the retrospective over many exchanges, not from one. */
  review?: boolean;
  /** The active rule a proposal would change. */
  replaces?: number;
  /**
   * A repository: the rule is about it and belongs in its CLAUDE.md, not in the preference memory.
   * Accepted, it is `filed` there through a card "Add to CLAUDE.md" and applies to no agent until it is.
   */
  target?: string;
}

export type PreferenceState = 'proposed' | 'active' | 'rejected' | 'filed';

/** The settings of a repository the work retrospective may propose a value for, in the dialog's order: what friction on workers' runs shows missing. */
export const PROPOSED_SETTINGS = ['checks', 'setup', 'softPaths', 'run'] as const;
export type ProposedSetting = (typeof PROPOSED_SETTINGS)[number];

/** A value for a setting of a repository (`RepoSettings`) that the work retrospective proposes, with the cards it rests on. */
export interface SettingProposal {
  id: number;
  /** The repository's id. */
  repo: string;
  field: ProposedSetting;
  /** A command for `setup`, the recipe for `run` (`app.run`), a list for `checks` and `softPaths`. */
  value: string | string[];
  /** One sentence for the owner: what went wrong on the cards it rests on. */
  basis: string;
  cards: { id: string; title: string }[];
  /** The setting's value as it applies now, in the snapshot. */
  now?: string | string[];
}

/**
 * What became of a setting proposal: waiting, set on this machine, put into the repository's
 * `.obeya/settings.json` for everyone, or rejected.
 */
export type SettingProposalState = 'proposed' | 'machine' | 'repository' | 'rejected';

/** `value` as this machine's settings for the repository hold it (`RepoSettings`). */
export function settingPatch(field: ProposedSetting, value: string | string[] | undefined): RepoSettings {
  if (field === 'run') return { app: { ...(value !== undefined ? { run: value as string } : {}) } };
  return { [field]: value } as RepoSettings;
}

export interface NewCard {
  title: string;
  body?: string;
  /** Where it goes; left out for a follow-up, which goes below the card it comes from. */
  x?: number;
  y?: number;
  /** A repository of the canvas; its home repository when left out (a follow-up's: that of its card). */
  repo?: string;
  /** An idea to discuss before anything is planned. */
  idea?: boolean;
  /** The card this one follows up on, e.g. for a finding of its demo. */
  from?: string;
  /** Screenshots for the task (ids from `POST /api/c/<canvas>/images`). */
  images?: string[];
}

/**
 * A repository to be created for a card: its folder (absolute or from `~`; empty while the owner has
 * not named one yet) and whether it gets a canvas of its own, which the card moves to, or joins the
 * card's canvas. `by`: who chose it; what the owner chose, the idea's agent does not change.
 * `due`: building or starting the card was clicked, and Obeya creates the repository then (ISO),
 * unless the owner takes it back meanwhile (`NEW_REPO_HOLD_MS`).
 */
export interface NewRepo {
  path: string;
  canvas: boolean;
  by: 'owner' | 'agent';
  due?: string;
}

/** How long building a card in a new repository waits for the owner to take it back. */
export const NEW_REPO_HOLD_MS = 8000;

/** The name a new repository's folder gives it (and its canvas): the last part of its path. */
export const newRepoName = (path: string) => path.trim().replace(/[/\\]+$/, '').split(/[/\\]/).at(-1) ?? '';

/** A card on another canvas, as a card that refers to it shows it. */
export interface Elsewhere {
  canvas: string;
  canvasName: string;
  title: string;
}

export interface CardPatch {
  x?: number;
  y?: number;
  title?: string;
  body?: string;
  state?: CardState;
  need?: Need | null;
  /** Another repository of the canvas, before work on the card has begun. */
  repo?: string;
  /** A project: folded to its head, its workstreams not shown on the canvas, or unfolded again. */
  collapsed?: boolean;
  /** The task's screenshots, all of them (ids from `POST /api/c/<canvas>/images`). */
  images?: string[];
  /** Before work begins: a repository to create for the card (`by` is the owner's), or none (null). */
  newRepo?: Pick<NewRepo, 'path' | 'canvas'> | null;
}

/** Owner actions on a card's work, posted to `/api/c/:canvas/cards/:id/act`. */
export type CardAction =
  /** On a project: all its planned workstreams go to the Coordinator, which orders them. */
  | { action: 'start' }
  /** A card the owner closed without a title (`nameless`): Obeya names it from its text. */
  | { action: 'name' }
  | { action: 'stop' }
  /**
   * The agent stops at once and goes on later where it stopped (`resume`, or the owner's next words
   * to it); `safePoint`: it first brings its work to a safe point and ends its turn, then stops.
   */
  | { action: 'pause'; safePoint?: true }
  | { action: 'resume' }
  /**
   * Set aside until `until` (ISO): a card at work stops until then as on a pause, one waiting for the
   * owner leaves them until then. On a snoozed card, it changes the time.
   */
  | { action: 'snooze'; until: string }
  /** A review card handed over leaves the owner until its contributor writes on the pull request or pushes (`Snooze.contributor`). */
  | { action: 'awaitContributor' }
  /** A snoozed card wakes now; a snoozed planned card starts now. */
  | { action: 'wake' }
  /** When a proposal starts once accepted (ISO), or `null`: at once. */
  | { action: 'startAt'; at: string | null }
  /** `images`: ids of screenshots uploaded before (`POST /api/c/<canvas>/images`); with them the text may be empty. */
  /** `spoken`: the words came through speech recognition, which the agent is told. */
  /** `replyTo`: the message of the card's conversation the words reply to (`CardEvent.replyTo`). */
  /** `spot`: the place in the card's demo video the words are about. */
  /** `findings`: on a review card, what the owner decided for its findings, by their numbers; with them the text may be empty. */
  | { action: 'message'; text: string; spoken?: boolean; images?: string[]; replyTo?: number; spot?: SpotInput; findings?: Record<string, ChangeRoute> }
  /** `picks`: the options of the question the owner picked; with them the text, their own words, may be empty. */
  | { action: 'answer'; text: string; spoken?: boolean; images?: string[]; replyTo?: number; picks?: string[]; spot?: SpotInput }
  /**
   * The owner has finished watching the demo video: the comments on places in it that Obeya held back
   * go to the worker. `now`: they sent them themselves ("Send now"), so they go without a moment's wait.
   */
  | { action: 'release'; now?: boolean }
  /** Deletes a comment on a place in the demo video that Obeya still holds back (`Item.held`). */
  | { action: 'unsay'; id: number }
  /**
   * A review card whose PR collides with unpushed commits on the local main: main is pushed, once
   * the undo window (PUSH_HOLD_MS) is through, and the card's agent brings the PR up to date with it;
   * `keepMain` takes it back within the window.
   */
  | { action: 'pushMain' }
  | { action: 'keepMain' }
  /** A review card whose worker's own changes are held (`HeldChanges`): Obeya pushes them and posts their text, without merging ("Push only"). */
  | { action: 'pushChanges' }
  /** The same card: the owner's own wording of the text that goes onto the PR with the approval, in place of the held one. */
  | { action: 'editHeld'; body: string }
  /**
   * `direct`: onto the default branch at once, without a pull request, where the repository allows it (`RepoRef.direct`).
   * `findings`: on a review card, the decisions on its findings that stood unsent, which go with the merge (a follow-up task, ignored).
   */
  | { action: 'approve'; direct?: boolean; findings?: Record<string, ChangeRoute> }
  /** In a folder without git, on a card waiting for approval: what it changed there is put back as it was before ("Discard changes"). */
  | { action: 'undo' }
  /** Start a queued card although it may collide. */
  | { action: 'force' }
  /**
   * The harness, model and effort this card's agent runs on, for every session it starts, over the
   * workers' group's; `null`: the group's again. Only while the card waits to start (planned, or proposed).
   */
  | { action: 'agent'; agent: CardAgent | null }
  /**
   * The Workspaces list: the card's clone goes to the cards waiting for one, after the undo window
   * (EVICT_HOLD_MS); its worker stops, its uncommitted work is kept on its branch, and it goes on
   * there once it has a workspace again. `keepWorkspace` takes it back within the window.
   */
  | { action: 'takeWorkspace' }
  | { action: 'keepWorkspace' }
  /** On a project: takes back a start of all its workstreams while the Coordinator has not planned them yet. */
  | { action: 'dequeue' }
  /**
   * On a project: its workstreams in columns by what builds on what, which the Coordinator reads
   * from the plan doc unless it has for the doc as it stands. Answers once they stand there.
   */
  | { action: 'arrange' }
  /** A waiting card `places` places (1 if left out) earlier or later in the queue, past cards it has no wait with. */
  | { action: 'reorder'; earlier: boolean; places?: number }
  /**
   * A proposal becomes the owner's card and starts (a proposed idea: its discussion opens); with
   * `start: false` it is only planned. `idea`: a proposed task becomes an idea to discuss first.
   * `picks`: the options the owner chose for each of its questions. While the proposal is reworked,
   * it is accepted and started once the new text is there, unless that asks questions.
   */
  | { action: 'accept'; start?: boolean; idea?: boolean; picks?: string[][] }
  /** A proposal: accepting it after its revision is taken back. */
  | { action: 'unaccept' }
  /** A proposal, or a card whose agent withdrew or replaced it since (`Item.superseded`): it goes, its worker stopped. */
  | { action: 'dismiss' }
  /** A card whose agent withdrew or replaced it since: the owner keeps it, and the mark goes. */
  | { action: 'keep' }
  /** A proposal: an agent reworks its text, reason and questions by what the owner said (`text`) and showed (`images`). */
  | { action: 'revise'; text: string; spoken?: boolean; images?: string[]; replyTo?: number }
  /** Ideas: talk to the exploration agent; `spoken` gets a short spoken summary back. */
  | { action: 'discuss'; text: string; spoken?: boolean; images?: string[]; replyTo?: number }
  /**
   * Ideas: the brief becomes the card's task and the card is planned. While the agent works on a
   * reply, the idea is built once the reply is there, unless it asks questions.
   */
  | { action: 'build' }
  /** Ideas: building after the reply is taken back. */
  | { action: 'unbuild' }
  /**
   * A task or an idea whose start or building waits to create its new repository (`NewRepo.due`):
   * that is taken back, and the card stays as it was.
   */
  | { action: 'stayHere' }
  /**
   * Ideas: the part its agent marked as settled becomes a task of its own beside the idea, started at
   * once; the idea stays open with its conversation, its agent and its prototypes.
   */
  | { action: 'splitOff' }
  /** Ideas, and planned tasks of the owner's nobody has worked on: a planned card whose worker writes a plan doc from the brief or the task. */
  | { action: 'planDoc' }
  | { action: 'park' }
  | { action: 'drop' }
  /**
   * Ideas: a worker builds a throwaway prototype and shows it as a demo on the idea; several may run
   * side by side. One per planned variant named in `variants` (by approach), and one for `text`.
   * Neither: one per planned variant without a prototype on the canvas, or, without any planned,
   * the idea as it stands.
   */
  | { action: 'prototype'; text?: string; variants?: string[] }
  /**
   * Prototypes: the idea is built on this prototype's branch; the idea's other prototypes are
   * discarded. Not once the idea becomes a project, whose plan doc settles its prototypes.
   */
  | { action: 'buildPrototype' }
  /** Prototypes: thrown away, into the archive with log, demo and summary. */
  | { action: 'discard' }
  /**
   * A demo is published for colleagues right away: the one with handover `demo` (the latest
   * without), on the card's page in place of the versions there, or beside them (`add`).
   */
  | { action: 'share'; demo?: number; add?: boolean }
  /** Takes the demo with handover `demo` off the page, the page down with its last one; without `demo`, the whole page. */
  | { action: 'unshare'; demo?: number }
  /** "Share on approval", where the repository's site publishes on approval: whether approving the card shares its latest demo. */
  | { action: 'shareOnApproval'; on: boolean }
  /** The owner sets the values of one dimension of the page's tags by hand; a shared page goes out again at once. */
  | { action: 'pageTags'; dimension: string; values: string[] }
  /** Question cards: the owner's words to the agent that looked the answers up. */
  | { action: 'ask'; text: string; spoken?: boolean; images?: string[]; replyTo?: number }
  /** Question cards: the thread becomes an idea, whose exploration agent starts from it. */
  | { action: 'asIdea' }
  /** Projects: the owner's words in the project's sheet, straight to its project agent, maybe replying to a message there. */
  | { action: 'consult'; text: string; spoken?: boolean; images?: string[]; replyTo?: TalkRef };

/**
 * Why the server refused a request. The server sends the code and an English detail
 * (`{ code, error }`, status 400); the UI shows its own text for the code.
 */
export type ErrorCode =
  | 'unknownCard'
  /** Pairing a device while other devices do not reach Obeya. */
  | 'notReachable'
  /** From another device that is not paired (status 401). */
  | 'notPaired'
  | 'notOwner'
  /** Managing who reaches Obeya, from another device (status 403). */
  | 'onlyHere'
  /** Turning push on at the machine Obeya runs on, which gets none (status 403). */
  | 'onlyDevices'
  /** A group that no card belongs to any more, so it is gone. */
  | 'unknownGroup'
  | 'project'
  /** An arrow between cards that would make them wait for each other, directly or through other cards. */
  | 'dependencyCycle'
  /** An arrow to or from a project or one of its workstreams, whose order comes from the plan doc. */
  | 'planDependency'
  /** An action that needs the card's agents while its repository does not run on the canvas (`Item.repoDown`). */
  | 'repoDown'
  | 'notPlanned'
  | 'queued'
  | 'notQueued'
  /** Moving a card in the queue: it is first or last already, or the card it would pass has a wait with it or is being judged. */
  | 'notMovable'
  | 'notPlannable'
  | 'noAgent'
  /** Resuming an agent the owner has not paused. */
  | 'notPaused'
  /** Snoozing a card that is neither at work nor waiting for the owner. */
  | 'notSnoozable'
  /** Waking a card that is not snoozed. */
  | 'notSnoozed'
  /** A time to snooze until that has passed, or lies more than a year ahead. */
  | 'snoozeTime'
  | 'noQuestion'
  | 'notReady'
  /** A review card's action on a card that reviews no pull request. */
  | 'notReview'
  /** "Change it myself" on a review card whose contributor does not allow maintainers' edits, or a decision on a finding it does not have open. */
  | 'noEdits'
  | 'noFinding'
  /** "Merge" with a decision on a finding standing unsent that holds the PR up (to the contributor, the agent's own change). */
  | 'decideFirst'
  /** Approving a review card: its PR moved since the handover, was closed, or the forge refused the merge (the detail says why). */
  | 'prMoved'
  /** "Push main, adapt the PR" on a review card whose PR collides with nothing unpushed (any more), or taking back a push that is not waiting. */
  | 'noClash'
  /** "Merge" on a review card whose PR collides with unpushed commits on the local main, which the card had not shown yet: it shows them now. */
  | 'pullClash'
  | 'prClosed'
  | 'mergeRefused'
  /** Approving a review card: the worker's own commits could not go onto the PR's branch (the detail says why). */
  | 'pushRefused'
  /** Deleting a comment on the demo video: it is no longer held back, the worker has it. */
  | 'notHeld'
  /** Approving directly onto main: the card's repository lands approved work only through a pull request. */
  | 'noDirect'
  /** What only a folder without git has (discarding a card's changes), or what it has not (prototypes, pull requests). */
  | 'notFolder'
  | 'inFolder'
  | 'notProposal'
  /** Choosing a card's harness and model once it is at work (or done): its agent keeps its own. */
  | 'agentStarted'
  | 'notSuperseded'
  | 'revising'
  | 'planCard'
  | 'noWorkspace'
  | 'dirtyWorkspaces'
  /** Taking a card's workspace from it: it holds no clone that may be taken (worktrees, its work landed, a prototype's), or one is being taken already. */
  | 'notEvictable'
  /** Committing the leftovers in a clone: it is no free clone of the repository, holds files marked assume-unchanged, or git failed there. */
  | 'notFreed'
  /** Starting a card while its workspace is being given to another. */
  | 'evicting'
  /** Changing a card's new repository, or starting it, while Obeya is about to make it (`NewRepo.due`). */
  | 'newRepoDue'
  /** Building or starting a card in a new repository that has no folder named. */
  | 'newRepoPath'
  /** The undo window of a new repository is over: it is being made. */
  | 'newRepoGone'
  /** Every machine with a clean free clone has as many workers busy as it has slots. */
  | 'noSlot'
  | 'workspace'
  | 'emptyText'
  /** The cloud service for voice in failed or refused the check's sentence (the detail says what it said). */
  | 'voiceCloud'
  | 'unknownPreference'
  | 'unknownSetting'
  /** An uploaded screenshot is no image the agents read, or too large. */
  | 'imageType'
  | 'imageTooLarge'
  /** A dropped file is larger than Obeya keeps. */
  | 'fileTooLarge'
  /** Only a finished card of the owner's (or a stopped task, a parked or dropped idea) goes into the archive. */
  | 'notDone'
  /** A stopped card whose workspace holds work stays on the canvas. */
  | 'holdsWork'
  | 'notArchived'
  | 'notIdea'
  /** Merging or deleting by the Coordinator: the card is no planned task nobody has worked on (any more). */
  | 'notUntouched'
  /** Merging tasks of different repositories. */
  | 'otherRepos'
  /** The card holds no thread of looked-up answers (it is no Question card). */
  | 'notQuestion'
  /** A looked-up answer's file that is not in its thread's output directory. */
  | 'noFile'
  /** The idea's agent is still working on its reply: building or planning waits for it. */
  | 'ideaThinking'
  | 'noSplit'
  /** A prototype for the idea is still running. */
  | 'prototypeRunning'
  /** The prototype's idea is becoming a project, or is one: the plan doc decides which workstream builds on which prototype. */
  | 'projectPending'
  /** The prototype's idea is gone from the canvas, and no project of it is there. */
  | 'ideaGone'
  /** Every variant the idea's agent planned has its prototype on the canvas already. */
  | 'variantsRunning'
  /** A project has no planned workstream left that is not already with the Coordinator. */
  | 'nothingToStart'
  /** The Coordinator could not read from a project's plan doc which workstream builds on which, so it arranged nothing. */
  | 'arrangeFailed'
  /** The action is for a prototype on the canvas, and the card is none. */
  | 'notPrototype'
  /** A discarded or built prototype stays in the archive; a new attempt is a new prototype. */
  | 'prototypeEnded'
  /** Sharing: the card has no demo, or its repository shares none. */
  | 'noShare'
  /** Sharing: the page is being published or withdrawn right now. */
  | 'shareBusy'
  /** Sharing: the demo is not shared. */
  | 'notShared'
  /** Sharing many pages again: a run is under way already. */
  | 'reshareBusy'
  /** Setup: the folder for the first canvas is no git repository. */
  | 'notRepo'
  /** Setup: the folder a clone would go to exists already. */
  | 'cloneTarget'
  /** Setting up git in a folder: git has no name and e-mail for the first commit. */
  | 'noIdentity'
  /** Setting up git in a folder failed; it is as it was. */
  | 'gitSetup'
  /** Setup: an installation or a clone is running already. */
  | 'setupBusy'
  /** Sharing many pages again: no page is outdated. */
  | 'nothingOutdated'
  /** "Take over into the repository for everyone": this machine sets nothing to take over. */
  | 'noSettings'
  /** "Take over into the repository for everyone": the checkout on the main branch has changes of its own in `.obeya/settings.json`. */
  | 'settingsDirty'
  /** The commands to confirm changed on the default branch since the dialog showed them. */
  | 'trustChanged'
  /** "Take over into the repository for everyone": the commit, the push or the pull request failed; why comes with it. */
  | 'settingsShare'
  /** Export: the video is too large for one HTML file. */
  | 'exportTooLarge'
  /** Export: the HTML artifact loads files beside its page, so it does not fit one HTML file. */
  | 'exportNotAlone'
  /** Approval could not land the work on main. */
  | 'landDirty'
  | 'landConflict'
  | 'landEmpty'
  | 'landCheckout'
  | 'landMerge'
  /** Pushing approved work directly onto `origin`'s default branch was turned away (a protected branch, say). */
  | 'landPush'
  | 'land'
  /** A configuration with problems; they come with it. */
  | 'config'
  /** A voice's sample could not be made; why comes with it. */
  | 'voiceSample'
  /** A voice is being installed already. */
  | 'voiceInstalling'
  /** Malformed input: a bug in the UI rather than something the owner can fix. */
  | 'invalid';

/** A repository on a canvas, as Obeya's configuration lists it (`canvases.json`). */
export interface RepoConfig {
  path: string;
  /**
   * `false`: a folder without git that is to stay one (a document archive, say): every card works in
   * the folder itself, nothing lands, and each card lists what it changed (design: Folders without git).
   */
  git?: false;
  /** Clones to register as workspaces (adapters that use clones). */
  workspaces?: string[];
  /** Clones to create under Obeya's home (adapters that use clones). */
  clones?: number;
  /** How many of its workers may be busy at once on this machine; left out, as many as it has clones, or any number in worktrees. */
  slots?: number;
  /**
   * Other machines its workers run on, reached over SSH (design: Hosts), in the order a new card
   * looks for a free slot after this one. Only for a repository whose workers use clones and whose work goes out through its
   * remote.
   */
  hosts?: HostConfig[];
  /** The settings the owner set for this machine in the configuration dialog; each goes before the repository's `.obeya/settings.json`. */
  settings?: RepoSettings;
}

/** How the repository's app runs (`app` of its settings): the recipe the workers read, and the two commands Obeya runs itself. */
export interface AppSettings {
  /**
   * How to run the app, in prose for a new colleague: how to start it, what to do after which kind
   * of change, where it gives its address, the login and test data for a demo. Every worker's brief
   * has it; empty, each worker finds it out from the repository.
   */
  run?: string;
  /**
   * Stops the app in a workspace, and does nothing where none runs. Obeya runs it there when the
   * card waits for the owner and its worker has nothing running (Parking), and tells the worker with
   * its next message.
   */
  stop?: string;
  /** Exits 0 when the workspace's app holds what must not be lost (a restored database, say): Obeya then leaves it running. */
  keep?: string;
}

/** A demo site being set up at a host, as the configuration follows it: its last lines, and how it ended. */
export interface SiteSetupJob {
  host: 'cloudflare' | 'github';
  running: boolean;
  lines: string[];
  error?: string;
  /** The host the dialog offers where this one refused (GitHub Pages from a private repository without Pro). */
  offer?: 'cloudflare';
  /** A repository's site once it is set up, for its settings. */
  site?: DemoSite;
}

/** A proposal for a demo site's tags (`demo.site.tags`), as the configuration follows it: running, then the tags and why, or the error. */
export interface TagProposalJob {
  running: boolean;
  tags?: PageTags;
  why?: string;
  error?: string;
}

/** The owner's personal demo site on this machine, as Configuration → Demos shows it. */
export interface PersonalSiteView {
  site: {
    host: 'cloudflare' | 'github';
    url: string;
    project: string;
    /** What a page's address looks like there (a fresh random part, for the dialog). */
    example: string;
    /** The env file with its credentials this machine lacks, relative to Obeya's home. */
    needs?: string;
    /** A public GitHub repository's site: listed, without a random part in its addresses. */
    listed?: true;
  } | null;
  job?: SiteSetupJob;
  /**
   * The private repositories (those on the canvases whose forge does not say they are public, and
   * those ticked), each with whether it is ticked to share there and whether it has a site of its
   * own this machine deploys to.
   */
  privateRepos: { path: string; name: string; allowed: boolean; ownSite?: true }[];
  /**
   * The repositories that share there (and those ticked for it), each with whether each approved
   * card's latest demo goes there by itself: ticked here, or by its site's settings (`bySettings`),
   * which the tick here cannot change.
   */
  approvedRepos: { path: string; name: string; on: boolean; bySettings?: true }[];
  /** The sites this machine deploys to on Cloudflare, each of another account: a new site may go into one of them. */
  cloudflareAccounts: string[];
}

/**
 * A static site the demos are shared on (`demo.site` of a repository's settings): Obeya keeps its
 * directory (one subdirectory per page, and the overview), writes the pages with its own templates
 * and runs the deploy command after each change.
 */
export interface DemoSite {
  /** The overview's heading, and the pages' tab titles. */
  title: string;
  /** Where the site is served; a page's URL is `url/<slug>/`. */
  url: string;
  /** The command line that deploys the site, run in `share/` under Obeya's home; `{dir}` stands for the site's directory. */
  deploy: string;
  /**
   * A file of `KEY=value` lines, relative to Obeya's home, added to the deploy's environment
   * (credentials, never in git). A machine without it exports demos instead of sharing them.
   */
  env?: string;
  /** Headers for reading the live site's manifest and pages (behind a login), values `${KEY}` from `env`. */
  headers?: Record<string, string>;
  /** The largest file the host takes, in bytes; 25 MiB without it. */
  maxFile?: number;
  /**
   * When a demo goes on the site: `approved`, the card's latest demo as the owner approves its work
   * (before it lands); without it, only when the owner clicks "Share".
   */
  publish?: 'approved';
  /**
   * The vocabulary pages are tagged from: each dimension with its values, in the order the overview
   * shows them. Workers and Obeya's reading session choose from it and add nothing to it.
   */
  tags?: PageTags;
}

/**
 * What Obeya needs to know about how a repository works, and its main branch, as the owner sets
 * them in the configuration dialog for this machine (design: Repository settings). Read where they
 * are used: saving them restarts nothing, but for `workspaces`, which restarts the repository's agents.
 */
export interface RepoSettings {
  /** Its main branch, where cards start from and work lands; detected where left out (`defaultBranch`). */
  branch?: string;
  /**
   * How approved work lands: `main` fast-forwards the checkout Obeya runs on to the worker's
   * branch (created clones then come from that checkout); `pr` leaves the branch for a pull
   * request and clones come from `origin`.
   */
  land?: 'main' | 'pr';
  /**
   * With `land: 'pr'`: the owner may approve a card's work directly onto the default branch
   * instead, without a pull request. Obeya rebases it onto `origin`'s default branch and pushes it
   * there (never forced); review and the CI of a pull request are skipped.
   */
  direct?: boolean;
  /**
   * With `land: 'pr'`: Obeya merges a pull request itself once nothing is left for the worker
   * (checks green, threads resolved, reviewers answered). `false` leaves the merge to the people
   * on the forge: the card then waits for the owner, ready to merge. Default: `true`.
   */
  autoMerge?: boolean;
  /** Checks a worker runs before it reports the card ready for review. */
  checks?: string[];
  /** Command a worker runs first in a fresh clone (dependencies). */
  setup?: string;
  /** Where plan docs live, relative to the repository root. */
  planDocs?: { dir: string; exclude: string[] };
  /**
   * Paths (a trailing `/` covers a directory) whose edits never count as a merge conflict between
   * two cards: they are resolved when a branch is rebased (docs, plan docs).
   */
  softPaths?: string[];
  /** Workers get full clones from a pool, or a worktree of the Obeya checkout per card. */
  workspaces?: 'clones' | 'worktrees';
  /** Accounts whose pull request comments are not review feedback (deploy bots and the like). */
  prNoise?: string[];
  /**
   * The language of what lands in the repository and lasts (code, comments, commit messages, docs,
   * plan docs, CLAUDE.md), whatever language the owner talks to its agents in; English where left out.
   */
  language?: Language;
  /** How the app runs: the recipe in every worker's brief, and how Obeya stops it while a card waits (Parking). */
  app?: AppSettings;
  /**
   * `site`: the static site Obeya keeps and deploys itself to share demos on (`src/server/site.ts`);
   * without one, "Share" exports a demo as a file. `language`: the language of the repository's
   * demos (narration, captions, report, shared pages) and of its site's overview, over the one of
   * the demo settings (`demo.json`), which applies without it.
   */
  demo?: { site?: DemoSite; language?: NarrationLanguage };
}

/**
 * A repository's settings for everyone who runs Obeya on it, in `.obeya/settings.json` as its
 * default branch has it (design: Repository settings): those for this machine but the main branch,
 * which says where the file is read from.
 */
export type SharedSettings = Omit<RepoSettings, 'branch'>;

/** How a card's own branch says its work lands, where it changes the repository's settings for that. */
export type CardLanding = Partial<Pick<RepoSettings, 'land' | 'direct'>>;

/** The fields of `SharedSettings`, in the dialog's order. */
export const SHARED_FIELDS = ['land', 'direct', 'autoMerge', 'checks', 'setup', 'planDocs', 'softPaths', 'workspaces', 'prNoise', 'language', 'app', 'demo'] as const satisfies readonly (keyof SharedSettings)[];
// every field of `SharedSettings` is in the list: one left out would be neither taken over nor read live
const everyShared: [Exclude<keyof SharedSettings, (typeof SHARED_FIELDS)[number]>] extends [never] ? true : false = true;
void everyShared;

/** The settings made of fields that are each set, layered and taken over on their own, and their fields. */
export const NESTED_SETTINGS = { app: ['run', 'stop', 'keep'], demo: ['site', 'language'] } as const satisfies { [K in keyof RepoSettings]?: readonly (keyof NonNullable<RepoSettings[K]>)[] };
export type NestedSetting = keyof typeof NESTED_SETTINGS;
export const isNested = (field: string): field is NestedSetting => field in NESTED_SETTINGS;

/** `over` in front of `under`, field by field; the fields of `app` and `demo` each on its own. */
export function layerSettings<T extends RepoSettings>(under: T | undefined, over: T | undefined): T | undefined {
  if (!under) return over;
  if (!over) return under;
  const out: RepoSettings = { ...under, ...over };
  for (const k of Object.keys(NESTED_SETTINGS) as NestedSetting[]) if (under[k] || over[k]) out[k] = { ...under[k], ...over[k] };
  return out as T;
}

/**
 * Where a repository's setting comes from where this machine sets none, highest first: the
 * repository's `.obeya/settings.json`, the clones the configuration names (`workspaces` only),
 * detection (main branch, landing), Obeya's default.
 */
export type SettingSource = 'repository' | 'clones' | 'detected' | 'default';

/** A setting's value without this machine's, and where it comes from. */
export interface SettingValue<T> {
  value: T;
  source: SettingSource;
  /** A command of the repository's that does not count until the owner confirms it (`RepoCommands`). */
  held?: true;
}

/**
 * What of a repository's own files Obeya runs or contacts on this machine without a click, or its
 * agents' sessions run outside Claude Code's permission checks, by group: one confirmed by the
 * owner counts as long as the default branch has it so (design: Trusting a repository's commands).
 */
export interface RepoCommands {
  /** `app.stop` and `app.keep` of `.obeya/settings.json`, which park a waiting card: one without the other could stop what `keep` keeps. */
  app?: { stop?: string; keep?: string };
  /** What of `demo.site` the deploy runs with and the live site is read from, and whether it deploys without a click on "Share". */
  site?: Pick<DemoSite, 'url' | 'deploy' | 'env' | 'headers' | 'publish'>;
  /** The repository's own Claude Code configuration by file (everything under `.claude/`, `.mcp.json`): hooks, MCP servers, helpers. */
  claude?: Record<string, ClaudeFile>;
}

/**
 * A file of a repository's Claude Code configuration: its git object, which tells one content from
 * another to the byte (a blob; a submodule's commit), and its text to read (a submodule's commit).
 */
export interface ClaudeFile {
  id: string;
  text: string;
}

export type TrustGroup = keyof RepoCommands;

/** The commands of a repository that do not count yet (`held`), as its default branch has them and as the owner last confirmed them. */
export interface RepoTrust {
  held: TrustGroup[];
  now: RepoCommands;
  before?: RepoCommands;
}

/** The lines of a group of commands, for the owner to read and compare: each field with its value, each file under its name. */
export function commandLines(c: RepoCommands | undefined, g: TrustGroup): string[] {
  const v = c?.[g];
  if (!v) return [];
  if (g === 'claude') return Object.entries(v as Record<string, ClaudeFile>).flatMap(([file, f]) => [`${file}:`, ...f.text.split('\n').map((l) => `  ${l}`)]);
  return Object.entries(v).map(([k, x]) => `${g === 'app' ? 'app' : 'demo.site'}.${k}: ${typeof x === 'string' ? x : JSON.stringify(x)}`);
}

/**
 * A repository's settings as they stand without this machine's: what the dialog shows where the owner
 * set nothing. Each field has a value; a demo has no site or language of its own where none is set (`null`).
 */
export type RepoValues = { [K in Exclude<keyof RepoSettings, NestedSetting>]-?: SettingValue<NonNullable<RepoSettings[K]>> } & {
  app: { [F in keyof AppSettings]-?: SettingValue<NonNullable<AppSettings[F]>> };
  demo: { site: SettingValue<DemoSite | null>; language: SettingValue<NarrationLanguage | null> };
};

/**
 * A repository's entry in the configuration without what applies as it is read (its settings but
 * where its workers work): where it differs, the repository's agents restart with it.
 */
export function repoShape({ settings, ...r }: RepoConfig): string {
  return JSON.stringify({ ...r, workIn: settings?.workspaces });
}

/** Whether saving `after` over `before` restarts or stops some repository's agents: one that left, or whose shape changed (`repoShape`). */
export function restartsAgents(before: CanvasConfig[], after: CanvasConfig[]): boolean {
  const shapes = (canvases: CanvasConfig[]) => new Map(canvases.flatMap((c) => c.repos.map((r) => [r.path, repoShape(r)] as const)));
  const now = shapes(after);
  return [...shapes(before)].some(([path, shape]) => now.get(path) !== shape);
}

/** The clones a repository gets whose settings say clones, the first canvas's or one added later: two cards run at once. */
export const CLONES = 2;

/**
 * Where the count of a repository added in the dialog stands (`withClones`): `filled`, the dialog's
 * `CLONES` is in; `withdrawn`, the dialog took it out again for the existing clones listed; `owner`,
 * the count is the owner's (typed, changed, emptied, or there before the dialog had a say). A path
 * not in it has had nothing filled in yet.
 */
export type FilledClones = Map<string, 'filled' | 'withdrawn' | 'owner'>;

/**
 * The draft with `CLONES` filled in for each repository the saved configuration does not have whose
 * settings say clones (`resolved`, by index) and that names none, once per path, or null when it
 * changes nothing. The dialog's number goes again once existing clones are listed beside it (they
 * add up, so 2 beside 2 existing would make 4) and comes back when the list is emptied, as long as
 * the owner has not touched it; `filled` keeps where each path stands, so a count of the owner's,
 * emptied included, stays as it is.
 */
export function withClones(draft: CanvasConfig[], saved: CanvasConfig[], resolved: (ResolvedCanvas | null)[], filled: FilledClones): CanvasConfig[] | null {
  const known = new Set(saved.flatMap((c) => c.repos.map((r) => r.path.trim())));
  let changed = false;
  const next = draft.map((c, i) => ({
    ...c,
    repos: c.repos.map((r, j) => {
      const path = r.path.trim();
      if (!path || known.has(path) || resolved[i]?.repos[j]?.workspaces !== 'clones') return r;
      const existing = !!r.workspaces?.some((w) => w.trim());
      const state = filled.get(path);
      if (state === 'owner') return r;
      // the count is no longer the one the dialog left: the owner's from now on
      if (r.clones !== (state === 'filled' ? CLONES : undefined)) {
        filled.set(path, 'owner');
        return r;
      }
      if ((state === 'filled') === !existing) return r;
      changed = true;
      filled.set(path, existing ? 'withdrawn' : 'filled');
      if (!existing) return { ...r, clones: CLONES };
      const { clones: _, ...rest } = r;
      return rest;
    }),
  }));
  return changed ? next : null;
}

/** A machine reached over SSH that a repository's workers run on, in clones of their own there. */
export interface HostConfig {
  /** What the owner calls it; workspaces there are named by it. */
  name: string;
  /** What `ssh` connects to: `user@machine`, or a name from `~/.ssh/config`. */
  ssh: string;
  /** The directory there that holds the clones (`~/…` in that machine's home). */
  root: string;
  /** How many clones Obeya keeps there (`<root>/1`, `<root>/2`, …). */
  clones: number;
  /** How many of the repository's workers may be busy there at once; as many as it has clones when left out. */
  slots?: number;
}

/** A canvas in Obeya's configuration. */
export interface CanvasConfig {
  /** Names the canvas; its id follows. Without it, both are the first repository's name. */
  name?: string;
  /** Keeps the canvas's id, and with it its cards, whatever its name says: set when a canvas is renamed. */
  id?: string;
  repos: RepoConfig[];
}

/** What a configuration amounts to: each canvas's id and name, and its repositories with their settings. */
export interface ResolvedCanvas {
  id: string;
  name: string;
  repos: {
    id: string;
    workspaces: 'clones' | 'worktrees';
    /** A folder without git (`RepoConfig.git` false): no branch, landing, clones or hosts. */
    folder?: true;
    /**
     * It still has a `.obeya/adapter/` on its main branch, which Obeya no longer reads: its values
     * belong in `.obeya/settings.json` (problem `adapterGone`).
     */
    adapterGone?: boolean;
    /** Its settings without this machine's, with where each comes from. */
    values: RepoValues;
    /** Its commands that wait for the owner to confirm them (problem `untrusted`). */
    trust?: RepoTrust;
    /**
     * Where "Take over into the repository for everyone" puts `.obeya/settings.json`: a commit on the main
     * branch where work lands there, else a pull request.
     */
    shareTo: 'main' | 'pr';
    /** Where it goes out as a pull request, it may also be pushed straight onto `origin`'s main branch (`direct`). */
    shareDirect?: boolean;
    /**
     * On a canvas that runs: the clones its pool loses with this configuration (path on its machine,
     * the host where not here, the number where Obeya made it, the title of the card that holds it).
     */
    leaving?: LeavingClone[];
  }[];
}

/** A clone a repository's pool loses with a configuration (`ResolvedCanvas`). */
export interface LeavingClone {
  path: string;
  host?: string;
  /** Its number where Obeya made it; its folder goes once nothing in it would be lost. One the owner listed has none, and stays on disk. */
  made?: number;
  /** The title of the card that holds it: it leaves once that card gives it back. */
  card?: string;
}

/** Something in a configuration that keeps Obeya from starting with it; `canvas` and `repo` count from 0. */
export interface ConfigProblem {
  code: ConfigProblemCode;
  canvas?: number;
  repo?: number;
  /** In English, for developers and the Coordinator. */
  detail: string;
}

/** Problems of the running canvases, not of the configuration: a canvas or repository that did not start as it has them (`StartFailure`). Saving the configuration, or "Try again", has them try again. */
export const START_FAILED: ConfigProblemCode[] = ['canvasDown', 'repoDown', 'repoBefore'];

/** Whether a problem keeps the configuration from being saved: not one in the repository, which is fixed there. */
export const blocksSaving = (p: ConfigProblem) => !['demoSite', 'adapterGone', 'repoSettings', 'untrusted', ...START_FAILED].includes(p.code);

export type ConfigProblemCode =
  /** No canvas at all. */
  | 'noCanvas'
  | 'noRepo'
  /** A repository whose path is empty. */
  | 'noPath'
  /** A path that is no git repository. */
  | 'notRepo'
  /** A folder without git (`RepoConfig.git` false) whose path is no folder. */
  | 'noFolder'
  /** A repository the canvas has already, under this path or another. */
  | 'sameRepo'
  /** The repository still has a `.obeya/adapter/`, which Obeya no longer reads: its values belong in `.obeya/settings.json`. */
  | 'adapterGone'
  /** Two canvases with the same id. */
  | 'sameId'
  /** The repository the canvas was first served with is missing. */
  | 'homeMissing'
  /** A clone listed as a workspace that is no git repository. */
  | 'notClone'
  /** A clone listed as a workspace whose origin is another repository's. */
  | 'otherClone'
  /** The demo site the repository's settings name cannot be used: a field is missing, or its deploy command names a program that is not there. */
  | 'demoSite'
  /** A host that cannot work for the repository: its workers use worktrees, or its work does not go out through a remote. */
  | 'hostRepo'
  /** Two hosts of one name that connect to different machines. */
  | 'hostName'
  /** A main branch set for this machine that the repository does not have. */
  | 'noBranch'
  /** Something in the repository's `.obeya/settings.json` that does not count (fixed there, so it keeps nothing from being saved). */
  | 'repoSettings'
  /** Commands of the repository, new or changed on its default branch, that wait for the owner to confirm them (`RepoTrust`). */
  | 'untrusted'
  /** The canvas does not run: its home repository did not start (a git error, say). */
  | 'canvasDown'
  /** The repository did not start: it is left out of its canvas, its cards kept. */
  | 'repoDown'
  /** The repository's agents did not start as the configuration has them now: they work on as they were set up before. */
  | 'repoBefore'
  /** Malformed: a bug in whoever wrote it. */
  | 'invalid';

/**
 * Obeya's configuration as the owner sees and edits it, at once: what it amounts to and what is
 * wrong with it come after, from its check (`ConfigChecked`), which reads every repository.
 */
export interface ConfigView {
  /** The file it is saved in. */
  file: string;
  /** Where the running canvases come from: that file, or repositories named on the command line. */
  source: 'file' | 'args';
  /** As saved (or as given on the command line, before anything is saved). */
  canvases: CanvasConfig[];
  /** The ids of the canvases this server runs. */
  running: string[];
  /**
   * Settings of the running server, from its command line; its version (`package.json`), and the
   * commit of the checkout it runs from (null for the compiled binary).
   */
  server: { port: number; home: string; permissionMode: string; restarts: boolean; version: string; commit: string | null };
  /** Saved, and Obeya starts again with it once no agent is in the middle of a turn. */
  restarting: boolean;
}

/** A configuration checked: what it amounts to and what keeps it from working. */
export interface ConfigChecked {
  /** As saved, tidied. */
  canvases: CanvasConfig[];
  /** What they amount to, by index; null for a canvas with a problem. */
  resolved: (ResolvedCanvas | null)[];
  problems: ConfigProblem[];
}

/** What "Take over into the repository for everyone" did with a repository's settings for this machine. */
export type SettingsShared =
  /** Committed `.obeya/settings.json` on the main branch (pushed onto `origin`'s, where it went there directly): the settings now come from the repository. */
  | { committed: string; branch: string }
  /** The main branch's `.obeya/settings.json` (`origin`'s, where it would have gone there) held them already: nothing committed, pushed or opened; the settings come from the repository. */
  | { unchanged: true; branch: string }
  /** Opened a pull request with it: once it is merged, the settings come from the repository. */
  | { pr: string };

/** What saving the configuration did: Obeya starts again with it, or (repositories' settings alone) it applies at once. */
export interface ConfigSaved {
  restarting: boolean;
  /** Obeya runs with it now: canvases and repositories new in it started, settings apply as they are read, and agents whose repository's set-up changed restart once they paused. */
  applied?: boolean;
}

/** What keeps the demo settings from working (a voice to install is not one: `DemoVoiceCheck.install`). */
export type DemoSettingsProblem =
  /** `command` without one. */
  | 'noCommand'
  /** The own endpoint, or Azure's region, is missing. */
  | 'noUrl'
  /** A service without its environment variable or a key file. */
  | 'noKey'
  | 'keyFileMissing'
  /** `say` is macOS only. */
  | 'notHere';

/** What keeps one of Qwen3's clips to clone from working: it is not there, or its transcript beside it. */
export type ClipProblem = 'referenceMissing' | 'noTranscript';

/** What the settings sheet shows about a voice, saved or not yet. */
export interface DemoVoiceCheck {
  /** The person the narration speaks in, which follows from whether the voice is the owner's own. */
  person: 'first' | 'third';
  problems: DemoSettingsProblem[];
  /** The clips to clone that do not work, by their language. */
  clips: Partial<Record<NarrationLanguage, ClipProblem>>;
  /** What the voice needs installed by Obeya and is missing (Piper, Qwen3-TTS), and about how much that is. */
  install: { installed: boolean; missing: string[]; mb: number };
  /** The directory demos go into, as these settings name it (`~` expanded), else the default. */
  directory: string;
  /** The settings name a relative directory, which counts as none: it would land wherever the agent works. */
  directoryRelative?: true;
}

/** An installation Obeya runs for a voice, one at a time. */
export interface VoiceInstallJob {
  voice: VoiceKind;
  running: boolean;
  /** The last line of its output. */
  line: string;
  error?: string;
}

/** The demo settings (`plugin/skills/demo/lib/settings.ts`) as the settings sheet shows them. */
export interface DemoSettingsView {
  /** The file they are saved in, under Obeya's home. */
  file: string;
  settings: DemoSettings;
  /** The saved voice checked. */
  check: DemoVoiceCheck;
  /** The installation running or last run, while Obeya runs. */
  job?: VoiceInstallJob;
  /** `process.platform` of the server: `say` is offered on a Mac only. */
  platform: string;
  /** What demos take on disk, and how long their frames are kept; none where Obeya does not look after the demo directory (tests). */
  space?: DemoSpaceView;
}

/** The demo directory's disk space (`src/server/demo-space.ts`). */
export interface DemoSpaceView {
  /** What applies while the demo settings name nothing; null: always. */
  defaultDays: number | null;
  /** Counting or deleting right now. */
  busy: boolean;
  /** What the demo directory took at the last count, and its renders' work directories (`.work`) of that. */
  used?: { bytes: number; work: number; at: string };
  /** The last deletion that found frames to delete, since Obeya started. */
  freed?: { at: string; demos: number; bytes: number };
}

/** The owner's languages (`src/server/settings.ts`): the interface's, chosen else the system's, and the conversation's, chosen else the interface's. */
export interface LanguageView {
  /** The file it is saved in, under Obeya's home. */
  file: string;
  /** The interface language the owner chose; `null` follows the system. */
  chosen: Language | null;
  /** The system's language, or the fallback when Obeya does not speak it. */
  system: Language;
  /** The one that applies. */
  language: Language;
  /** The conversation language the owner chose; `null` follows the interface's. */
  conversationChosen: Language | null;
  /** The conversation language that applies: agents write the owner in it until the owner's words say otherwise. */
  conversation: Language;
}

/** The look Obeya's pages take (`src/server/settings.ts`): light or dark as chosen in the settings, else as the system's. */
export const THEMES = ['light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];
export interface ThemeView {
  /** The file it is saved in, under Obeya's home. */
  file: string;
  /** What the owner chose; `null` follows the system. */
  chosen: Theme | null;
}

/**
 * One of the usage limits of a plan a harness is logged in with on this machine, as the plan's usage
 * endpoint reports it (src/server/usage.ts): how much of its window is used, and when the window
 * starts anew. Codex's windows take the same kinds and groups by their length.
 */
export interface UsageLimit {
  /** The endpoint's kind of meter: `session` (five hours), `weekly_all`, `weekly_scoped` (one model's), or one Obeya does not know yet. */
  kind: string;
  /** The endpoint's group of the meter: `session` or `weekly`. */
  group: string;
  /** What a scoped meter is for, as the endpoint names it: a model (`Fable`) or a surface. */
  scope?: string;
  /** Share of the window used, 0–100. */
  percent: number;
  /** When the window starts anew (ISO time), when the endpoint says. */
  resetsAt?: string;
  /** How long the window lasts, in minutes, where Obeya knows it: Claude's session five hours, its week seven days, Codex's windows as it reports them. */
  windowMinutes?: number;
  /** The endpoint's grade of the meter: `normal`, `warning` or `critical`. */
  severity: string;
}

/** One subscription's usage limits as last fetched: the plan a harness is logged in with. */
export interface PlanUsage {
  harness: Harness;
  limits: UsageLimit[];
  /** When they were fetched (ISO time). */
  at: string;
}

/** The usage limits of each subscription with a login, for the bar while the owner has it show them. */
export interface Usage {
  plans: PlanUsage[];
}

/** Whether the bar shows the plan's usage limits (`src/server/settings.ts`); on until the owner turns it off. */
export interface UsageMeterView {
  /** The file it is saved in, under Obeya's home. */
  file: string;
  on: boolean;
}

/** Whether the page shows what the agents cost (`Item.spent`, `CanvasSnapshot.spent`; `src/server/settings.ts`); off until the owner turns it on. */
export interface CostsView {
  /** The file it is saved in, under Obeya's home. */
  file: string;
  on: boolean;
}

/**
 * How other devices reach Obeya, when the owner lets them (`src/server/remote.ts`): through
 * `tailscale serve`, which gives an HTTPS address in the tailnet, or on an address of this machine
 * the owner picks (another VPN's interface), in plain HTTP.
 */
export type RemoteSetting = ({ via: 'tailscale' } | { via: 'address'; address: string }) & {
  /** `always`: the machine does not idle-sleep while Obeya runs; otherwise only while a worker works. */
  awake?: 'always';
};

/** What Tailscale allows on this machine, as `tailscale status` says. */
export type TailscaleState =
  | { state: 'missing' }
  /** Installed, but its service does not run (or the CLI cannot reach it). */
  | { state: 'stopped' }
  | { state: 'loggedOut' }
  /** Logged in, but HTTPS certificates are off in the tailnet: `tailscale serve` cannot give an HTTPS address. */
  | { state: 'noHttps'; name: string; enable?: string }
  /**
   * `account`: the login it runs as, which the phone logs in with too; `others`: how many other
   * devices the tailnet has, none while the phone is not in it yet.
   */
  | { state: 'ready'; name: string; account?: string; others: number };

/** Why the address does not answer for other devices, though the setting is on. */
export type RemoteProblem =
  /** On Linux `tailscale serve` needs the operator right, given once (`sudo tailscale set --operator=$USER`). */
  | { code: 'operator' }
  /** Ports 443, 8443 and 10000 of the tailnet name already serve something else. */
  | { code: 'portsTaken' }
  /** The address picked is not one of this machine's, or listening on it failed. */
  | { code: 'listen'; detail: string }
  | { code: 'failed'; detail: string };

/** A device paired with Obeya: its cookie lets it in from another machine. */
export interface DeviceView {
  id: string;
  /** From its browser's user agent: "iPhone · Safari". */
  name: string;
  pairedAt: string;
  lastSeen: string;
  /** It turned notifications on: Obeya pushes to it. */
  push?: true;
  /**
   * Where its app on the home screen opens Obeya, as that app last connected: the app keeps the
   * address it was added at, so another address of Obeya's leaves it without an answer.
   */
  app?: string;
}

/** A one-time code that pairs a device: in the QR code with the address, and to type in. */
export interface Pairing {
  code: string;
  /** The address with the code, which the QR code holds. */
  url: string;
  expires: string;
  /** The device it paired, once one did. */
  paired?: DeviceView;
  /** The address the app on its home screen kept, from the entry of the same device it replaced: that app needs adding anew. */
  replaced?: string;
}

/** The section "Other devices" and "Connect a phone" (`/api/access`), for a page on this machine. */
export interface AccessView {
  local: true;
  /** The file the setting is saved in. */
  file: string;
  /** `null`: other devices do not reach Obeya. */
  remote: RemoteSetting | null;
  tailscale: TailscaleState;
  /** Where other devices reach Obeya now; `null` while they do not. */
  address: string | null;
  problem?: RemoteProblem;
  /** This machine's addresses beyond loopback, to pick one for another VPN. */
  addresses: string[];
  devices: DeviceView[];
  pairing: Pairing | null;
  /** The server's platform: what to install or run differs by it. */
  platform: string;
}

/** The agents Obeya runs, grouped as the owner sets their harness, model and effort (`src/server/settings.ts`). */
export const AGENT_ROLES = ['coordinator', 'worker', 'explorer', 'chores'] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];
/** The coding agents Obeya runs its agents on, each on the machine's own installation and login. */
export const HARNESSES = ['claude', 'codex'] as const;
export type Harness = (typeof HARNESSES)[number];
/** Claude Code's models a setting may name: its default, or one of its aliases, each the newest of its family; the menus offer the aliases. */
export const AGENT_MODELS = ['default', 'fable', 'opus', 'sonnet', 'haiku'] as const;
export type AgentModel = (typeof AGENT_MODELS)[number];
export const AGENT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type AgentEffort = (typeof AGENT_EFFORTS)[number];
/**
 * The harness, model and effort a group of agents runs with. `model`: for Claude Code one of
 * `AGENT_MODELS` (`default` for its own default); for Codex a model family (`codexFamily`), which
 * each start resolves to the newest model of that family the machine the agent runs on lists.
 */
export interface AgentSetting {
  harness: Harness;
  model: string;
  effort: AgentEffort;
}
/**
 * What the owner chose for one card's agent, over the workers' group's (`Item.agent`): a harness with
 * a model (`model` as in `AgentSetting`), an effort, or both; what is left out is the group's.
 */
export interface CardAgent {
  harness?: Harness;
  model?: string;
  effort?: AgentEffort;
}
/** A Codex model as a setting may name it: a family (`gpt-#-sol`, one `#` where the version was), or a model id Codex lists (`gpt-6.1-sol`), read as its family. */
export const CODEX_MODEL = /^(?=[^#]*#?[^#]*$)(?!#$)[A-Za-z0-9#][\w.:#-]{0,79}$/;
/** The Codex family a group runs on until the owner chooses another: Sol. */
export const CODEX_PRESET = 'gpt-#-sol';
/** A Codex model id's family and version: `gpt-6.1-sol` is `gpt-#-sol` 6.1; none for an id without a number. */
function codexVersion(id: string): { family: string; version: number[] } | null {
  const m = /^(\D*?)(\d+(?:\.\d+)*)(.*)$/.exec(id);
  return m ? { family: `${m[1]}#${m[3]}`, version: m[2]!.split('.').map(Number) } : null;
}
/**
 * The Codex family a setting names: a family as it is, a model id's family (`gpt-6.1-sol` is
 * `gpt-#-sol`; an id without a number is a family of its own), `default` the preset's.
 */
export function codexFamily(model: string): string {
  if (model === 'default') return CODEX_PRESET;
  if (model.includes('#')) return model;
  return codexVersion(model)?.family ?? model;
}
const newer = (a: number[], b: number[]) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
};
/** Of each family Codex lists, the newest model (`gpt-6.1-sol`, not `gpt-5.6-sol` beside it), in Codex's order. */
export function newestOfFamilies<M extends { id: string }>(models: M[]): M[] {
  const newest = new Map<string, { id: string; version: number[] }>();
  for (const m of models) {
    const f = codexVersion(m.id);
    const known = f && newest.get(f.family);
    if (f && (!known || newer(f.version, known.version))) newest.set(f.family, { id: m.id, version: f.version });
  }
  return models.filter((m) => {
    const f = codexVersion(m.id);
    return !f || newest.get(f.family)?.id === m.id;
  });
}
/**
 * The model a Codex family runs on with a catalog (`model/list`): the newest of the family, else the
 * one the catalog marks as its default; none where the catalog has neither.
 */
export function resolveCodexModel<M extends { id: string; isDefault?: true }>(models: M[], family: string): M | undefined {
  const key = codexFamily(family);
  return newestOfFamilies(models).find((m) => codexFamily(m.id) === key) ?? models.find((m) => m.isDefault);
}
/** The effort a model takes nearest to the one chosen, the higher of two as near: the one chosen where it takes it, or says nothing. */
export function nearestEffort(effort: AgentEffort, takes: AgentEffort[] | undefined): AgentEffort {
  if (!takes?.length || takes.includes(effort)) return effort;
  const at = AGENT_EFFORTS.indexOf(effort);
  const distance = (e: AgentEffort) => Math.abs(AGENT_EFFORTS.indexOf(e) - at);
  return takes.reduce((best, e) => (distance(e) < distance(best) || (distance(e) === distance(best) && AGENT_EFFORTS.indexOf(e) > AGENT_EFFORTS.indexOf(best)) ? e : best));
}
/** The model a setting stores for a harness: for Codex its family, for Claude Code the alias as it is. */
export const storedModel = (harness: Harness, model: string): string => (harness === 'codex' ? codexFamily(model) : model);
/** A card's own choice as stored with it, a Codex model as its family (an id or `default` stored before reads so). */
export function cardAgentOf(stored: string): CardAgent {
  const agent = JSON.parse(stored) as CardAgent;
  return agent.harness && agent.model ? { ...agent, model: storedModel(agent.harness, agent.model) } : agent;
}
/** Whether `model` is one a group on `harness` may run with: Claude Code's aliases are no Codex model, but for the default. */
export const modelFits = (harness: Harness, model: string): boolean =>
  harness === 'claude' ? AGENT_MODELS.some((m) => m === model) : CODEX_MODEL.test(model) && (model === 'default' || !AGENT_MODELS.some((m) => m === model));
/** What applies until the owner chooses otherwise: Opus throughout, high effort for workers and exploration agents. */
export const AGENT_DEFAULTS: Record<AgentRole, AgentSetting> = {
  coordinator: { harness: 'claude', model: 'opus', effort: 'medium' },
  worker: { harness: 'claude', model: 'opus', effort: 'high' },
  explorer: { harness: 'claude', model: 'opus', effort: 'high' },
  chores: { harness: 'claude', model: 'opus', effort: 'medium' },
};
/** The default of a group on a harness: the preset's effort, with the harness's preset model (Codex's Sol family). */
export function agentDefault(role: AgentRole, harness: Harness): AgentSetting {
  const preset = AGENT_DEFAULTS[role];
  return harness === preset.harness ? preset : { harness, model: CODEX_PRESET, effort: preset.effort };
}

/**
 * A model by the name people know it by: Claude's ids by family and version (`claude-opus-5-5` is
 * Opus 5.5, `claude-3-5-haiku-20241022` Haiku 3.5), any other as its harness names it.
 */
export function modelName(model: string): string {
  const m = /^claude-(?:(\d+)-(?:(\d)-)?)?([a-z]+)(?:-(\d+)(?:-(\d))?)?(?:-\d{8})?(?:\[\w+\])?$/.exec(model);
  if (!m || (!m[1] && !m[4])) return model;
  const [major, minor] = m[1] ? [m[1], m[2]] : [m[4], m[5]];
  return `${m[3]![0]!.toUpperCase()}${m[3]!.slice(1)} ${major}${minor ? `.${minor}` : ''}`;
}

/**
 * A model id's version as people know it: `claude-opus-5-5` 5.5, `gpt-6.1-sol` 6.1; none for an id
 * without a number.
 */
export function modelVersion(id: string): string | undefined {
  const name = modelName(id);
  if (name !== id) return name.slice(name.lastIndexOf(' ') + 1);
  return codexVersion(id)?.version.join('.');
}

/** A model a harness offers, as the Configuration lists it. */
export interface HarnessModel {
  id: string;
  /** Its name as the harness gives it; absent for Claude Code's aliases, which the page names itself. */
  name?: string;
  /** The model a Claude Code alias stands for here (`opus`: `claude-opus-5-5`), the newest of its family Claude Code lists, once it has said. */
  resolved?: string;
  /** The efforts it takes, where the harness says (Codex); absent: all of `AGENT_EFFORTS`. */
  efforts?: AgentEffort[];
  /** The one the harness takes by default (Codex's), which a family no longer listed runs on. */
  isDefault?: true;
}

/**
 * A model as the pickers offer it (the Configuration's and a card's): `value` is what a setting stores
 * (Claude Code's alias, a Codex family), `name` the Codex family's name (`codexFamilyName`; absent
 * for Claude Code, whose aliases the page names itself), the efforts its newest model here takes.
 */
export interface ModelChoice {
  value: string;
  name?: string;
  /** The version it runs on here (`5.5`), shown after the name; absent where unknown or the name holds it. */
  version?: string;
  efforts: readonly AgentEffort[];
}

/**
 * The models a picker offers on a harness, with the one chosen (`chosen`, as stored) among them even
 * where the harness no longer lists it. Codex's are its families, each named without a version, which `version` carries.
 */
export function modelChoices(harness: HarnessView | undefined, chosen?: string): ModelChoice[] {
  const codex = harness?.id === 'codex';
  const listed: ModelChoice[] = newestOfFamilies(harness?.models ?? []).map((m) => {
    const name = codex ? codexFamilyName(codexFamily(m.id), m.name ?? m.id) : undefined;
    // a family named by its newest model (`o3`) has its version in the name already
    const version = modelVersion(codex ? m.id : (m.resolved ?? ''));
    return {
      value: codex ? codexFamily(m.id) : m.id,
      ...(name !== undefined ? { name } : {}),
      ...(version && !name?.includes(version) ? { version } : {}),
      efforts: m.efforts ?? AGENT_EFFORTS,
    };
  });
  if (chosen === undefined || listed.some((c) => c.value === chosen)) return listed;
  return [...listed, { value: chosen, ...(codex ? { name: codexFamilyName(chosen) } : {}), efforts: AGENT_EFFORTS }];
}

/**
 * A Codex family by the name people know it by, without a version, as Claude Code's aliases are
 * named: what follows the version (`gpt-#-sol` is Sol, `gpt-#-codex-max` Codex Max); a family named
 * only by its version (`gpt-#`, `o#`) by its newest model's name here (`newest`), else its key without the version.
 */
export function codexFamilyName(family: string, newest?: string): string {
  const after = /#[-.]?([A-Za-z].*)$/.exec(family)?.[1];
  if (after) return after.split(/[-_.]/).filter(Boolean).map((w) => `${w[0]!.toUpperCase()}${w.slice(1)}`).join(' ');
  return newest ?? family.replace(/[-.]?#/, '');
}

/** A harness as this machine has it: installed, logged in, and the models it offers. */
export interface HarnessView {
  id: Harness;
  /** Installed and logged in: agents can run on it. */
  ready: boolean;
  /** Its version, once found. */
  version?: string;
  /** The models it offers to choose from: Claude Code's aliases; Codex's, of each family the newest. */
  models: HarnessModel[];
  /** Its update on this machine. */
  update?: HarnessUpdate;
  /** It on each other machine of the configuration (hosts) that answered with its version. */
  hosts?: HarnessHost[];
}

/**
 * A harness's update: the newer version that is out (`version`), the update under way
 * (`running`), or why the last one failed (`error`); absent while it is the newest.
 */
export interface HarnessUpdate {
  version: string;
  running?: true;
  error?: string;
}

/** A harness on a host: the version it is at there, and its update. */
export interface HarnessHost {
  name: string;
  version: string;
  update?: HarnessUpdate;
}

/** The harness, model and effort of each group of agents, as they apply (`settings.json` over `AGENT_DEFAULTS`). */
export interface AgentsView {
  file: string;
  agents: Record<AgentRole, AgentSetting>;
  harnesses: HarnessView[];
  /** What a group the owner chose nothing for runs on here: Claude Code, unless only Codex is ready. */
  preset: Harness;
}

/**
 * The cloud services Obeya's voice in can send recordings to instead, all with the OpenAI-style
 * `/audio/transcriptions` endpoint (`src/server/voice-cloud.ts`). `prompt`: it takes the card
 * titles as vocabulary. `openai` stands for any compatible endpoint: base URL and model can be changed.
 */
export const CLOUD_VOICES = {
  groq: { name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3-turbo', keys: 'https://console.groq.com/keys', prompt: true },
  mistral: { name: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', model: 'voxtral-mini-latest', keys: 'https://console.mistral.ai/api-keys', prompt: false },
  openai: { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini-transcribe', keys: 'https://platform.openai.com/api-keys', prompt: true },
} as const;
export type CloudPreset = keyof typeof CLOUD_VOICES;
export const CLOUD_PRESETS = Object.keys(CLOUD_VOICES) as CloudPreset[];

/** A cloud service as the owner set it up (its key stays on the server; the page only learns there is one). */
export interface CloudVoiceView {
  preset: CloudPreset;
  baseUrl: string;
  model: string;
  key: boolean;
  /** Recordings go to it rather than to the recognition on this machine. */
  used: boolean;
  /** How long it took for the check's sentence when it was last tested. */
  tested?: { seconds: number };
}

/**
 * How long the recognition on this machine took for the short sentence Obeya ships with
 * (`voice/check-de.ogg`), loaded and warm. `slow`: longer than the sentence itself.
 */
export interface VoiceSpeed {
  backend: ListenBackend;
  seconds: number;
  slow: boolean;
}

/** What Obeya's own voice in needs on this machine (`src/server/voice-setup.ts`). */
export type VoiceSetupId = 'recognition' | 'ffmpeg' | 'uv';
export type VoiceSetupItem = Omit<SetupItem, 'id'> & {
  id: VoiceSetupId;
  /** The recognition, which uv fetches: "Install" waits until uv is there. */
  waits?: 'uv';
} & VoiceRecognitionParts;

/** What the recognition's line carries besides its state: how fast it is here, and the cloud service. */
export interface VoiceRecognitionParts {
  /** Measured on this machine; `measuring` while it is. */
  speed?: VoiceSpeed | 'measuring';
  cloud?: CloudVoiceView;
}

export interface VoiceSetupView {
  platform: string;
  arch: string;
  listen: ListenBackend;
  items: VoiceSetupItem[];
  /** About how much "Install" fetches (the recognition and its model); 0: nothing to fetch. */
  fetch: { mb: number };
  /** The installation or measurement running or last run. */
  job?: { running: boolean; step: 'fetch' | 'measure'; error?: string };
}

/** The setup assistant's list (`src/server/machine.ts`): what Obeya needs on this machine, by what it is for. */
export type MachineSectionId = 'needed' | 'pr' | 'voice' | 'demos';
/** Claude Code or Codex with its login, git and git's name and e-mail for commits. */
export type NeededId = 'claude' | 'claudeLogin' | 'codex' | 'codexLogin' | 'git' | 'gitUser';
/** gh and its login. */
export type PrId = 'gh' | 'ghLogin';

/** A piece of the list, as a setup check gives it, and what Obeya does about it at a click. */
export type MachineItem = Omit<SetupItem, 'id'> & {
  id: NeededId | PrId | VoiceSetupId | SetupId;
  /**
   * `install`: Obeya installs it (no admin rights, or Homebrew or winget). `login`: Obeya opens a
   * terminal that logs in. `identity`: the owner gives git's name and e-mail, which Obeya sets.
   */
  act?: 'install' | 'login' | 'identity';
  /** What has to be installed first (uv, which brings the speech recognition). */
  waits?: 'uv';
  /** One harness's piece, not needed while the other harness is ready (or, while neither is, Claude Code is the one asked for). */
  or?: true;
} & VoiceRecognitionParts;

export interface MachineSection {
  id: MachineSectionId;
  items: MachineItem[];
  /** About this many megabytes still to download for what the section is for (voice, demos). */
  mb: number;
}

/** An installation, a login or a clone Obeya runs for the assistant, one at a time. */
export interface MachineJob {
  kind: 'install' | 'clone';
  section?: MachineSectionId;
  id?: MachineItem['id'];
  running: boolean;
  /** The last line of its output. */
  line: string;
  error?: string;
  /** A clone that became the first canvas: its id, opened once Obeya runs it. */
  canvas?: string;
  /** Its main branch. */
  branch?: string;
  /** Obeya runs it now, or starts again with it by itself; else the owner starts Obeya again. */
  opens?: boolean;
}

export interface MachineView {
  platform: string;
  arch: string;
  sections: MachineSection[];
  /** The Claude Code Obeya was checked with (the Agent SDK's); the machine's may be newer or older. */
  checkedClaude: string;
  job?: MachineJob;
  /** Where a clone goes by default: the owner's home directory. */
  cloneInto: string;
}

/** What choosing the first canvas did: it is saved, and Obeya runs it (`opens`), or the owner starts Obeya again. */
export interface FirstCanvas {
  canvas: string;
  /** The repository's main branch, as Obeya found it. */
  branch: string;
  opens: boolean;
}

/** A folder for the first canvas, looked at before it is saved: whether it holds a repository, and on which main branch. */
export interface SetupFolder {
  repo: boolean;
  branch?: string;
  /** A folder without a repository, in which git can be set up. */
  folder?: boolean;
}

/** From this size on a file is marked as large in the preview of a first commit. */
export const LARGE_FILE = 1_000_000;

/** What the first commit of a folder without git would hold, shown before the owner confirms it. */
export interface GitSetupPreview {
  path: string;
  /** The branch the repository starts on. */
  branch: string;
  /** The `.gitignore` Obeya writes, where the folder has none. */
  gitignore?: string;
  files: number;
  bytes: number;
  /** What goes in, by the folder's own entries: a directory with its files counted. */
  entries: { path: string; dir: boolean; files: number; bytes: number }[];
  /** Files of a size worth a second look, largest first. */
  large: { path: string; bytes: number }[];
  /** What stays out, as git lists it (an ignored directory once). */
  ignored: string[];
}

/**
 * Why Obeya starts again: new code on the checkout it runs from, a configuration the owner saved,
 * a repository's `.obeya/settings.json` changed on its default branch where its agents work, a
 * new version of the app the owner installs, or the Mac app taking over an Obeya that runs without
 * the app that started it (app/src/main.rs, `orphaned`); or why it stops for good (Ctrl-C, SIGTERM).
 */
export type RestartReason = 'code' | 'config' | 'repository' | 'update' | 'takeover' | 'stop';

/** A newer version of the app that its shell has downloaded (app/src/update.rs), shown in the bar. */
export interface AppUpdate {
  version: string;
  /** What changed, from the release. */
  notes?: string;
  /** When it was released (ms since the epoch). */
  date?: number;
  /** Where to get it, when the app cannot install it itself (a .deb). */
  download?: string;
}

/**
 * New commits on the upstream of the checkout Obeya runs from (`origin/main`, say) that change code,
 * shown in the bar for the owner to pull (src/server/source-update.ts).
 */
export interface SourceUpdate {
  /** The upstream, as git names it: `origin/main`. */
  upstream: string;
  /** The checkout's directory. */
  checkout: string;
  /** How many commits the upstream has that the checkout does not. */
  count: number;
  /** The newest of them (at most ten), newest first: subject and when it was committed (ms since the epoch). */
  commits: { subject: string; date: number }[];
  /**
   * Why Obeya cannot pull them itself, if it cannot: the checkout has commits of its own (`diverged`,
   * a fast-forward is not possible), or uncommitted changes to files the new commits change (`local`).
   */
  blocked?: { why: 'diverged' } | { why: 'local'; files: string[] };
  /** What git said when the owner's last pull failed. */
  error?: string;
}

/** What the owner does in an open page that a restart would cut off: watching a demo video, dictating. */
export type OwnerHold = 'video' | 'voice';

/** A restart that waits for workers to finish their turns, or for the owner, as one canvas sees it. */
export interface PendingRestart {
  reason: RestartReason;
  /** When it goes ahead however busy the workers are (ms since the epoch). */
  deadline: number;
  /** The cards on this canvas whose worker it waits for. */
  cards: string[];
  /** The workers on other canvases it waits for: each canvas (by name) with its cards' titles. */
  elsewhere: { canvas: string; cards: string[] }[];
  /** What the owner does in some open page that it waits for, past the deadline too. */
  owner: OwnerHold[];
  /** Only the agents of these repositories (by name) restart, for a change to their configuration; Obeya and the others work on. */
  repos?: string[];
  /** The canvas left the configuration: it stops once its agents paused. */
  leaving?: boolean;
}

/** UI → server over the WebSocket. */
export type ClientMessage =
  /** What the owner does in this page that a restart waits for (sent on every change). */
  | { type: 'hold'; hold: OwnerHold[] }
  /** The owner came back to this page (from GitHub, say): what Obeya polls is looked at now. */
  | { type: 'back' }
  /** The owner uses this page: it is in view and they moved, typed or scrolled in it (or a video plays) within the last half minute. */
  | { type: 'here' }
  /** This page went out of view (on a phone: locked, or another app in front). */
  | { type: 'away' }
  /**
   * What the owner has in view (sent on every change and when the page gets the focus back):
   * `place`, the middle of the canvas in view and its bounds (`placeParam`), where a new card goes
   * that a command without a place of its own makes.
   */
  | { type: 'focus'; place?: string }
  /** This page froze: the server logs it beside its own stalls. */
  | ({ type: 'stall' } & PageStall);

/**
 * A page that froze for `ms`: where the time went as far as the browser tells (the scripts of its
 * long frames, longest first, e.g. "WebSocket.onmessage (index.js:1204)"), what the page did
 * shortly before (the server's messages it took in), and what it ran in: the browser ("Safari 26",
 * "Obeya app on macOS"), whether its window was the one in use (had the focus as the stall began or
 * ended), and how long before it the owner last moved, typed or scrolled in it (absent where they
 * have not since it loaded).
 */
export interface PageStall {
  ms: number;
  scripts: { what: string; ms: number }[];
  before: string[];
  browser?: string;
  active?: boolean;
  usedMs?: number;
}

/** Server → UI over the WebSocket. */
export type ServerMessage =
  | { type: 'snapshot'; snapshot: CanvasSnapshot }
  | { type: 'event'; event: CardEvent }
  /** A line taken out of the card's log: a comment the owner deleted before it went to the worker. */
  | { type: 'eventGone'; cardId: string; id: number }
  /**
   * First on every connection: which server process this is, so a page from an earlier one
   * reloads; and the version of Bun it runs on when that is too old (`oldLinuxBun`), for the bar.
   */
  | { type: 'hello'; server: string; oldBun?: string }
  /** On connect and whenever it changes: the restart Obeya waits with, if any. */
  | { type: 'restart'; restart: PendingRestart | null }
  /** On connect and whenever it changes: the newer version of the app there is to install, if any. */
  | { type: 'update'; update: AppUpdate | null }
  /** On connect and whenever it changes: new commits on the upstream of the checkout Obeya runs from, if any. */
  | { type: 'source'; source: SourceUpdate | null }
  /** On connect and whenever it changes: how much of its usage limits the account Claude Code runs with here has used, while the bar shows it. */
  | { type: 'usage'; usage: Usage | null }
  /** On connect and whenever the owner changes it: whether the page shows what the agents cost (`CostsView`). */
  | { type: 'costs'; shown: boolean }
  /** On connect and whenever it changes: what waits for the owner on each canvas, by canvas id. */
  | { type: 'waiting'; waiting: Record<string, Waiting> }
  /** Whenever a canvas starts, stops, or changes its name or repositories while Obeya runs. */
  | { type: 'canvases'; canvases: CanvasInfo[] }
  /** A line for the owner above the microphone, wherever they are. */
  | ({ type: 'notice' } & Notice);

/**
 * What Obeya tells the owner above the microphone without a command of theirs to answer: an answer
 * the Coordinator looked up, or what it did with a request a card's agent passed on from the
 * owner's words (`to_obeya`), with `token` while those actions wait for "Undo".
 */
export interface Notice {
  /** The card it is about, named when another one is open. */
  cardId?: string;
  text: string;
  token?: string;
  undoMs?: number;
  /** The owner asked to tell Obeya's makers something: the page opens the draft for them with it. */
  wish?: Wish;
  /** The exchange of Obeya's sheet it answers, there in full: a page that shows the sheet needs no line above the microphone. */
  talk?: number;
  /** The project whose sheet shows that exchange in full too: a page with that sheet open needs no line either. */
  project?: string;
  /** The conversation of the card (`cardId`) shows it in full, as it came: a page with that conversation open needs no line. */
  inTalk?: true;
  /** The page opens the card (`cardId`), unless the owner has another one open: the one a review of its PR asked for. */
  open?: true;
  /** The card (`cardId`) moved to this canvas: a page that has it open follows it there. */
  movedTo?: string;
}

/** A skill (or command) of Claude Code the owner can ask a card's agent for by `/name` in their words. */
export interface Skill {
  name: string;
  /** What it does, as its file says. */
  description: string;
  /** What to write after the name (`<file>`), when it says. */
  hint?: string;
}
