// The tools a card's worker reports, asks, proposes, hands over and snoozes with: each runs as the
// worker calls it, refuses what does not hold yet with why, and records what it changes on the card.

import { z } from 'zod';
import type { CardDiff } from '../core/diff';
import { LANGUAGE_NAMES } from '../core/locale';
import { existsSync } from 'node:fs';
import { realPath } from './path';
import { isAbsolute, join } from 'node:path';
import { type CardFile, normalPath } from '../core/files';
import { type AdoptedPr, AWAITED_STATES, type Demo, type DemoKind, type DemoPage, type HeldChanges, type Item, type Question, type RepoRef, type Snooze, type Superseded, type PageTags } from '../core/types';
import { answering, awaited, finished, formatQuestion, laterTime, started } from '../core/card';
import type { CardLanding } from '../core/config';
import { type Board, type Retracted, titleKey } from './board';
import { pathOfRef } from './plan-ref';
import { prototypeBuild, prototypeName } from './idea-actions';
import { fromJson, type PrState, type Json, type StoredContribution, type StoredDemo, toJson } from './row';
import { parsePlanDoc } from '../core/plan-doc';
import { type Asked, withPick } from './advisor';
import { checkArtifact, readChapters } from './demo';
import { artifactFiles, keepDemo, videoFacts } from './demo-files';
import { isPlanDoc, outsidePlanDir, remoteHost } from './repo';
import { textOf } from './workspaces';
import type { AgentTool } from './runtime';
import { toObeyaTool } from './to-obeya';
import { hostName, remote } from './hosts';
import { dimensions, outside, tagsOf } from '../core/page-tags';
import type { CardRow } from './db';
import { parsePrUrl, sameRepo } from './forge';
import { clip, messageOf, tooLong, oneLine } from '../core/text';
import type { OwnCommits, ReviewCards } from './review-cards';
import type { WorkerBriefing } from './worker-briefing';
import { PROPOSAL_QUESTIONS, proposalQuestions, proposalTask, retractedText } from './proposals';
import { AFTER_LANDING, SESSION_ENDED, snoozedUntil } from './worker-texts';
import { folderOf, sharesOf, type WorkerOptions } from './worker-options';
import { APP_URL, type Live } from './worker-live';

/** The question of a demo report as the demo keeps it: its text, options and the worker's pick, as `ask` takes them. */
function demoQuestion(q: { text: string } & Omit<Asked, 'question'>): Pick<Demo, 'question' | 'options' | 'multiple' | 'pick'> {
  const { text, options, multiple, pick } = withPick({ ...q, question: q.text });
  return { question: text, ...(options.length ? { options } : {}), ...(multiple ? { multiple } : {}), ...(pick ? { pick } : {}) };
}

/**
 * A demo the worker gives as the card keeps it: an HTML artifact checked (and whether it is its
 * index.html alone, which also goes out as one HTML file), a video's chapters read; or what is wrong
 * with it, and whether that is the artifact or the demo to fix.
 */
function checkedDemo(d: { kind?: DemoKind; dir: string; chapters?: string[] }): StoredDemo | { wrong: string; fix: 'artifact' | 'demo' } {
  if (d.kind === 'html') {
    const wrong = checkArtifact(d.dir);
    if (wrong) return { wrong, fix: 'artifact' };
    return { kind: 'html', dir: d.dir, chapters: [], ...(artifactFiles(d.dir).length === 1 ? { single: true as const } : {}) };
  }
  const chapters = readChapters(d.dir, d.chapters ?? []);
  if (typeof chapters === 'string') return { wrong: chapters, fix: 'demo' };
  return { kind: 'video', dir: d.dir, chapters };
}

/** A demo as the worker gives it at its handover. */
type GivenDemo = { kind?: DemoKind; dir: string; chapters?: string[]; question?: { text: string } & Omit<Asked, 'question'>; page?: DemoPage; follows?: 'replaces' | 'supplements' };

/** What the worker gives `ready_for_review`. */
interface HandOverArgs {
  summary: string;
  demo?: GivenDemo;
  files?: { path: string; caption: string }[];
  review?: { checks: { name: string; passed: boolean }[]; mergeable: boolean };
  pr_draft?: string;
  pull_requests?: string[];
}

/** What `ready_for_review` takes from the session's tools: the review card's pull request, the demo's page, and what each tool ends with. */
interface HandOverContext {
  review: StoredContribution | null;
  shares: boolean;
  vocabulary: [string, string[]][];
  /** Whether the session has ended (stopped, replaced): its calls change nothing. */
  ended: () => boolean;
  /** The worker hands the card to the owner in this turn. */
  handOver: () => void;
  /** The result of a call that ends the turn, with the owner's words that waited for it. */
  ending: (plain: string, stands: string, change?: string) => string;
}

/** What a handover found out before it records: what git tells, what is held for the PR, the new demo and the files named. */
interface HandedOver {
  work: boolean;
  own?: CardLanding;
  upstreamNew?: number;
  mine?: OwnCommits;
  held?: HeldChanges & { base: string };
  demo?: StoredDemo;
  kept: boolean;
  asked: boolean;
  approved: boolean;
  named?: CardFile[];
  shows: boolean;
  /** The pull requests open already that the work went onto instead of the branch, which the approval follows. */
  follows?: AdoptedPr[];
}

/** How many files a worker may name as its result at a handover. */
const MAX_RESULT_FILES = 12;

/**
 * Work that landed on the main branch (directly, or through its merged pull request in its own
 * repository) and whose worker is still at it after the landing: a pull request in another
 * repository that the work also needed is followed from then on (`PrState.onMain`).
 */
/** A pull request reported again, opened again after it was closed: watched again. */
const reopened = ({ closed: _, ...pr }: PrState): PrState => pr;

function landedOnMain(row: CardRow): boolean {
  const l = fromJson(row.landed);
  const s = fromJson(row.shipped);
  const pr = fromJson(row.pr);
  return row.state === 'live' && !!l && !l.unchanged && !l.followUp && !l.revoking && !l.resolve && !!s && !s.upstream && !row.contribution && !pr?.rollback && !pr?.adopted && !pr?.upstream;
}

const END_TURN = 'Recorded. End your turn now without further work; the reply arrives as your next message.';

/** What the worker's tools need of the workers. */
export interface ToolsHost {
  /** The card's session as the workers follow it now: a tool of a session since ended or replaced changes nothing. */
  liveOf(cardId: string): Live | undefined;
  unheardNow(cardId: string, live: Live): string | undefined;
  toOwner(cardId: string, q: Question): void;
  diff(cardId: string, full: boolean): Promise<CardDiff | null>;
  changedFiles(cardId: string): Promise<string[]>;
  showsFiles(cardId: string): Promise<boolean>;
  close(cardId: string, by: 'owner' | 'worker'): string;
  inWorktree(cardId: string): boolean;
  landingOf(cardId: string): Promise<{ land: 'main' | 'pr'; direct: boolean; own?: CardLanding }>;
  reviews: ReviewCards;
  brief: WorkerBriefing;
}

export class WorkerTools {
  constructor(
    private o: WorkerOptions,
    private w: ToolsHost,
  ) {}

  private get folder() {
    return folderOf(this.o);
  }

  private get shares() {
    return sharesOf(this.o);
  }

  for(cardId: string, live: Live, prototype: boolean): AgentTool[] {
    // the system prompt says which language that is (`ownersLanguage`)
    const language = "the owner's language";
    // the page goes to colleagues: in the language of the repository's demos where it names one
    const pageLanguage = LANGUAGE_NAMES[this.w.brief.demoLanguage()];
    // whether the repository shares, as the session's tools have it from their start on: the schema drops a page they do not
    // take, so the handover asks for one only where they take it (where sharing began since, the page is written once shared)
    const shares = this.shares;
    // the vocabulary the page's tags come from, where the repository's site names one
    const vocabulary = shares ? dimensions(this.o.adapter.demo?.site?.tags) : [];
    // a proposal may go to another repository than the card's: of this canvas, or of another canvas this Obeya runs
    const repos = this.o.board.canvas.repos;
    const ownRepo = this.o.repo ?? this.o.board.home;
    const others = this.otherBoards().filter((b) => b.canvas.repos.length);
    const anotherRepo = repos.length > 1 || others.length > 0;
    const handOver = () => {
      live.turn.handedOver = true;
      live.nudged = false;
      // a question or a handover after a snooze in the same turn: the card waits for the owner instead
      if (live.turn.snoozed) {
        live.turn.snoozed = false;
        this.o.board.work(cardId, { snoozed: null });
      }
    };
    /**
     * The result of a call that ends the worker's turn (`plain`). The owner's words that waited for
     * this step come with the result itself, with what to do about them, so that the worker takes
     * them in before its turn ends rather than ending it in silence: `stands` is what holds of the
     * call meanwhile, `change` what follows if their words change it.
     */
    const ending = (plain: string, stands: string, change?: string): string => {
      const words = this.w.unheardNow(cardId, live);
      if (!words) return plain;
      return `${stands} The owner wrote to you while you worked, and their words reach you only now, with this result: take them in as at any other step. Answer them with reply where they call for an answer, and do what they ask${change ? `; ${change}` : ''}. Then end your turn.\n\n${words}`;
    };
    // a session the owner stopped or replaced may still call its tools: those calls change nothing
    const ended = () => this.w.liveOf(cardId) !== live && !live.standIn;
    const current = (tools: AgentTool[]): AgentTool[] =>
      tools.map((t) => ({
        ...t,
        run: (args) => {
          if (ended()) return SESSION_ENDED;
          const heard = (text: string) => {
            if (/^Not [a-z ]+:/.test(text)) live.refused = { tool: t.name, text };
            else if (live.refused?.tool === t.name) live.refused = undefined;
            return text;
          };
          const result = t.run(args);
          return typeof result === 'string' ? heard(result) : result.then(heard);
        },
      }));
    // a review card's tools to the contributor's pull request
    const review = fromJson(this.o.board.row(cardId).contribution);
    return current([
      {
        name: 'report',
        description: `Show the owner one short status line on your card (in ${language}, at most ~80 characters). Use it at milestones, not for every step.`,
        schema: { status: z.string() },
        run: ({ status }) => {
          const s = clip(String(status), 200);
          this.o.board.work(cardId, { status_line: s });
          this.o.board.log(cardId, 'report', 'worker', s);
          return 'Shown on the card.';
        },
      },
      {
        name: 'reply',
        description: `Answer a note or feedback from the owner in your card's conversation: a sentence or two in ${language}, what you change because of it or why nothing. The reply does not end your turn: if work remains, carry on with it; if none does (your work is handed over and the note changes nothing), your turn ends with the reply, and the card goes on waiting for the owner's approval.`,
        schema: { text: z.string() },
        run: ({ text }) => {
          const s = String(text).trim();
          if (!s) return 'Not shown: the reply is empty.';
          const long = tooLong(s, 12000, 'reply');
          if (long) return long;
          // a reply may end the turn on a handover: what the owner chose for later is made before it
          const owed = this.w.reviews.owedTasks(cardId);
          if (owed) return `Not shown: first make the follow-up tasks the owner chose, for ${owed}; then reply.`;
          this.o.board.log(cardId, 'talk', 'worker', s);
          live.turn.answered = true;
          live.turn.spoke = true;
          return 'Shown to the owner.';
        },
      },
      {
        name: 'ask',
        description: `Ask for a decision you should not make yourself: product behaviour, trade-offs, anything irreversible or external. Write the question in ${language} for a reader who has not seen the code, and offer up to four short answer options when they exist; the owner picks one on the card (several when multiple is true) or writes their own. pick: the options you would choose yourself if you had to decide (one, or several when multiple), and pick_why: why, in one short sentence in ${language}; the card marks them for the owner. Then end your turn.`,
        schema: {
          question: z.string(),
          options: z.array(z.string()).max(4).optional(),
          multiple: z.boolean().optional(),
          pick: z.array(z.string()).optional(),
          pick_why: z.string().optional(),
          demo: z
            .object({
              kind: z.enum(['video', 'html']).optional().describe("'video' (the default): a recording made with the demo skill; 'html': a page to look at"),
              dir: z.string().describe('absolute path: a video holds demo.mp4 and captions.vtt, an HTML artifact holds index.html and the files it loads'),
              chapters: z.array(z.string()).optional().describe('video only: scene titles, in order'),
            })
            .optional()
            .describe(
              "what the owner is to look at to answer, when there is something to see (drafts or variants side by side, as an HTML artifact, say): the card shows it beside your question as it shows a handover's demo. It is no handover: the handover still brings its own demo.",
            ),
        },
        run: (args) => {
          // the question on the card, with the demo it shows; returns its event
          const asked = (shown?: StoredDemo): number => {
            handOver();
            const q = withPick(args as unknown as Asked);
            const e = this.o.board.log(cardId, 'question', 'worker', formatQuestion(q, this.o.board.language()));
            if (shown) {
              // the demo it replaces stays with the card, for the owner to go back to
              const row = this.o.board.row(cardId);
              this.o.board.work(cardId, { demo: toJson({ ...shown, asked: true, handover: e.id, at: e.at }), ...(row.demo ? { demos: this.earlier(cardId, row) } : {}) });
            }
            this.w.toOwner(cardId, q);
            return e.id;
          };
          const recorded = () =>
            ending(
              END_TURN,
              'Recorded: your question waits for the owner on the card, and their answer arrives as your next message.',
              'if they change your question, ask it anew (the card shows the earlier one as asked again further below)',
            );
          const given = args.demo as { kind?: DemoKind; dir: string; chapters?: string[] } | undefined;
          if (!given) {
            asked();
            return recorded();
          }
          // a demo made on another machine is shown from its copy here
          return this.demoHere(cardId, given.dir).then(async (here) => {
            if ('wrong' in here) return `Not asked: the demo could not be copied to the owner's machine (${here.wrong}). Check the directory, then ask again.`;
            // copying it takes a while, in which the owner may stop or replace the session
            if (ended()) return SESSION_ENDED;
            const shown = checkedDemo({ ...given, dir: here.dir });
            if ('wrong' in shown) return `Not asked: ${shown.wrong}. Fix the ${shown.fix}, then ask again.`;
            await this.keep(cardId, asked(shown));
            return recorded();
          });
        },
      },
      // a prototype makes no cards of its own: what it proposes is building its idea on it
      prototype
        ? {
            name: 'propose_build',
            description: `Propose that the idea be built on this prototype: a worker then goes on from your branch, takes over what carries and brings it to production quality, and the idea's other prototypes are discarded. Use it when your approach convinced (the owner said so, or it clearly settles the idea). It shows on your card, where the owner accepts it or not. reason: why, in ${language}, a sentence or two.`,
            schema: { reason: z.string() },
            run: ({ reason }) => {
              this.o.board.proposeBuild(cardId, clip(String(reason).trim(), 2000));
              this.o.board.log(cardId, 'activity', 'worker', this.o.board.t.worker.proposesBuild(clip(String(reason).trim(), 300)));
              return 'Shown on your card; the owner decides. Continue with your task.';
            },
          }
        : {
            name: 'propose_card',
            description: [
              `Propose a separate card for something you noticed that is outside your task, instead of doing it here, or for a follow-up to your own task that can only be done later (start_at); the owner decides on it.`,
              `idea: true for something to think through with the owner before anyone builds it (it becomes an idea, discussed with an agent of its own); leave it out for a task that is clear enough to build.`,
              proposalTask('your card nor your session'),
              `reason: for the owner only, why you propose it, a sentence or two; it does not go to that agent.`,
              `questions: what the owner has to decide first (product behaviour, a trade-off), each with up to four short options; keep them out of task. The owner may answer them on the proposal; what they decided and what stays open go to the agent with the task.`,
              `replaces: the title of an earlier proposal of yours this one takes the place of; Obeya takes that one off the canvas, or, if the owner has taken it on already, marks it as replaced and offers to remove it.`,
              `start_at: when the card is to start, ISO 8601 with your timezone's offset (2026-11-04T08:00:00+01:00), for a task that can only be done later (whether a bank has registered a form two weeks on, say): accepted, it waits until then and starts by itself. Its agent then checks what it can and asks the owner for what only they can see.`,
              ...(anotherRepo
                ? [
                    `repo: the repository the change is to be made in, by its id: ${repos.map((r) => `${r.id} (${r.path}${r.id === ownRepo ? ', yours' : ''})`).join(', ')}${others.length ? `; on other canvases, where the proposal then waits for the owner: ${others.map((b) => `on “${b.canvas.name}” ${b.canvas.repos.map((r) => `${r.id} (${r.path})`).join(', ')}`).join('; ')}` : ''}; yours when left out.`,
                  ]
                : []),
              `Everything in ${language}.`,
            ].join(' '),
            schema: {
              title: z.string(),
              task: z.string(),
              reason: z.string(),
              idea: z.boolean().optional(),
              questions: PROPOSAL_QUESTIONS.optional(),
              replaces: z.string().optional(),
              start_at: z.string().optional(),
              ...(anotherRepo ? { repo: z.string().optional() } : {}),
            },
            run: ({ title, task, reason, idea, questions, replaces, start_at, repo }) => {
              const wanted = typeof repo === 'string' && repo.trim() ? repo.trim() : undefined;
              const into = wanted ? this.proposalRepo(wanted) : undefined;
              if (typeof into === 'string') return into;
              const board = into?.board ?? this.o.board;
              const named = typeof start_at === 'string' && start_at.trim() ? start_at.trim() : undefined;
              const at = named ? Date.parse(named) : NaN;
              const when = named ? laterTime(at) : 'ok';
              if (when === 'none') return 'Not proposed: give start_at as ISO 8601 with your timezone offset (2026-11-04T08:00:00+01:00).';
              if (when === 'past') return `Not proposed: start_at has passed (it is ${new Date().toISOString()} now).`;
              if (when === 'far') return 'Not proposed: start_at lies more than a year ahead.';
              const p = board.propose(cardId, {
                title: String(title),
                task: String(task),
                reason: String(reason),
                idea: !!idea,
                questions: proposalQuestions(questions as z.infer<typeof PROPOSAL_QUESTIONS> | undefined),
                ...(named ? { startAt: new Date(at).toISOString() } : {}),
                ...(into ? { repo: into.repo } : {}),
              });
              const there = board === this.o.board ? undefined : board.canvas.name;
              this.o.board.log(cardId, 'activity', 'worker', idea ? this.o.board.t.worker.proposedIdea(p.title, there) : this.o.board.t.worker.proposedCard(p.title, there));
              const old = typeof replaces === 'string' && replaces.trim() ? replaces.trim() : undefined;
              return old ? `Proposed. ${this.retract(cardId, old, { by: p.id, title: p.title })}` : 'Proposed; the owner decides. Continue with your task.';
            },
          },
      // a prototype makes no cards, so it has none to take back
      ...(prototype
        ? []
        : [
            {
              name: 'withdraw_proposal',
              description: [
                `Take back a card you proposed earlier (propose_card) that turned out wrong or needless, by its title. Still open, it goes from the canvas at once; if the owner has taken it on already, Obeya marks it as withdrawn and offers to remove it.`,
                `replaced_by: the title of a proposal of yours that takes its place, when you made one already (a new one names the old with replaces instead).`,
                `why: for the owner, a sentence, in ${language}.`,
              ].join(' '),
              schema: { title: z.string(), why: z.string(), replaced_by: z.string().optional() },
              run: (args: Record<string, unknown>) => {
                const { title, why, replaced_by } = args as { title: string; why: string; replaced_by?: string };
                // the latest by that title, as retract takes the latest it replaces: of two alike, the newer replaces the older
                const by = replaced_by?.trim()
                  ? this.proposalBoards()
                      .map((b) => b.items().findLast((i) => i.from === cardId && (!!i.proposal || !!i.proposed) && titleKey(i.title) === titleKey(replaced_by)))
                      .find(Boolean)
                  : undefined;
                if (replaced_by?.trim() && !by) return `No card you proposed is called “${replaced_by.trim()}”. Nothing was withdrawn.`;
                return this.retract(cardId, String(title).trim(), { ...(by ? { by: by.id, title: by.title } : {}), ...(why?.trim() ? { why: clip(why.trim(), 1000) } : {}) });
              },
            },
          ]),
      ...(review
        ? ([
            {
              name: 'findings',
              description: `Record your review's findings for the owner, the whole list as it stands now (you keep it like a brief: call it after your review, and again whenever a finding changes, from the owner's words or a push). Each: a short title, a sentence or two in ${language}, whether it is about security, and its status: open; sent (to the contributor, with the review's url); fixed (by you, committed on your branch; Obeya pushes it with the owner's approval); resolved (a push of the contributor's fixed it, or it no longer applies); dropped (the owner does not pursue it); later (a follow-up task you made with follow_up_task, which Obeya keeps as it is). Give the id of a finding you had; a new one gets the next free number, in the order of the list. with: the ids of the other findings it would make one follow-up task with, should the owner choose that for them: only what one worker would sensibly do in one go (the same cause, the same files), else none. The card shows them beside the demo, bundles together, and the owner decides on each there.`,
              schema: {
                findings: z.array(
                  z.object({
                    id: z.number().int().positive().optional(),
                    title: z.string(),
                    text: z.string(),
                    security: z.boolean().optional(),
                    status: z.enum(['open', 'sent', 'fixed', 'resolved', 'dropped', 'later']).optional(),
                    url: z.string().optional(),
                    with: z.array(z.number().int()).optional(),
                  }),
                ),
              },
              run: ({ findings }) => this.w.reviews.setFindings(cardId, findings as Parameters<ReviewCards['setFindings']>[1]),
            },
            {
              name: 'follow_up_task',
              description: `Make findings the owner chose as follow-up tasks (or asked for in words) a task of its own, beside your card and following up on it, outside this PR; it waits in the queue behind your card and starts once the PR is merged. findings: the numbers of the findings it is made of, one or several that belong together; title: short and precise, in ${language}; task: what is to be done, in ${language}, written for the agent who will take it on and has seen neither this PR nor your review: what is wrong and why, the files concerned, what done looks like, and the PR's link (${review.url}). Obeya marks those findings later, linking the task.`,
              schema: { findings: z.array(z.number().int()), title: z.string(), task: z.string() },
              run: ({ findings, title, task }) => this.w.reviews.followUpTask(cardId, String(title).trim(), String(task).trim(), (findings as number[]) ?? []),
            },
            {
              name: 'request_changes',
              description: `Send change requests to ${review.author} as one review of the pull request that asks for changes, posted with the owner's account. body: in the PR's language, as the owner's words to the contributor; findings: the numbers of the findings it holds, which Obeya marks as sent. Then end your turn: the card waits for ${review.author}.`,
              schema: { body: z.string(), findings: z.array(z.number().int()).optional() },
              run: async ({ body, findings }) => {
                const owed = this.w.reviews.owedTasks(cardId);
                if (owed) return `Not sent: first make the follow-up tasks the owner chose, for ${owed}; then call request_changes again.`;
                const own = fromJson(this.o.board.row(cardId).contribution);
                if (own?.changing || own?.held)
                  return `Not sent: your own changes to the PR wait for the owner's approval, and a request to ${review.author} goes with them as one message. Write it into pr_draft with your handover (ready_for_review): Obeya posts it once the owner approves.`;
                const sent = await this.w.reviews.requestChanges(cardId, String(body), (findings as number[] | undefined) ?? []);
                if (sent) return sent;
                handOver();
                return ending(
                  `Sent. End your turn now: the card waits for ${review.author}, and Obeya passes you what they answer or push.`,
                  `Sent: the card waits for ${review.author}.`,
                  'a change request in them goes to the contributor the same way, or to you as their switch says',
                );
              },
            },
          ] satisfies AgentTool[])
        : []),
      {
        name: 'pr_opened',
        description:
          'After the owner approved: report the pull request you opened for this card (its URL); where the work also needed one in another repository, report that one too, a call for each, also once your work is on main. Then end your turn; Obeya watches them, and the card is live once all are merged.',
        schema: { url: z.string() },
        run: ({ url }) => {
          const row = this.o.board.row(cardId);
          // work just landed on main (or through its merged pull request), whose worker is still at it: one in another repository is followed from here on
          const afterMain = landedOnMain(row);
          if (!afterMain && (!row.pr || row.landed))
            return row.landed
              ? 'Not recorded: the card is finished (its work landed, or it closed without a change to the code), and Obeya follows no pull request for it any more.'
              : 'Not recorded: the owner has not approved this card yet. Do not open a pull request before that. One your work went onto already instead of your branch, name in ready_for_review (pull_requests): the approval then follows it.';
          const ref = parsePrUrl(String(url));
          if (!ref) return 'Not recorded: that is not the URL of a pull request (on GitHub or GitHub Enterprise https://<host>/<owner>/<repo>/pull/<number>, on Forgejo or Gitea such as Codeberg https://<host>/<owner>/<repo>/pulls/<number>).';
          const host = this.o.remote && remoteHost(this.o.remote)?.toLowerCase().replace(/^ssh\.github\.com$/, 'github.com');
          const named = `${ref.owner}/${ref.repo}`;
          const ownRepo = !!this.o.remote && sameRepo(this.o.remote, ref.owner, ref.repo) && (!host || host === ref.host.toLowerCase());
          if ((afterMain || fromJson(row.pr)?.onMain) && ownRepo)
            return "Not recorded: your work is on main already, and that pull request is in the card's own repository. After the landing, Obeya follows only one in another repository that the work also needed; a further change here becomes a card of its own (propose_card).";
          handOver();
          if (afterMain) {
            // its landing stands: the card is in the pull request until it is merged, and live again then
            const l = fromJson(row.landed)!;
            const onMain = { ...(l.page ? { page: true as const } : {}), ...(l.restarts ? { restarts: true as const } : {}), ...(l.waits ? { waits: true as const } : {}) };
            const pr: PrState = { url: ref.url, number: ref.number, repo: named, seen: [], reported: [], onMain };
            this.o.board.work(cardId, { state: 'inPr', need: null, detail: null, status_line: null, landed: null, pr: toJson(pr) });
            this.o.board.log(cardId, 'state', 'worker', this.o.board.t.worker.prOpenedAfterMain(`${ref.repo} #${ref.number}`));
            this.o.onPrOpened?.(cardId);
            return ending(
              'Recorded. Your work stays on main, and the card is in this pull request until it is merged: Obeya passes you its review comments, failed checks and conflicts. End your turn now.',
              'Recorded: Obeya watches the pull request, and the card is live again once it is merged.',
              'a change to the work goes onto the pull request',
            );
          }
          const root = fromJson(row.pr)!;
          // the card's own is the one in its repository, which the landing is about; one in another
          // repository is watched beside it, and reported again (opened again after it was closed) as before
          // a fork's pull request to the original is the card's own there, not one in origin's repository
          const up = root.upstream;
          const upUrl = up ? this.o.upstream?.()?.url : undefined;
          // the pull request the card's work went onto (a branch of the owner's) is its own, wherever it is, and its repository the card's there
          const theirs = root.adopted && root.repo ? root.repo : undefined;
          const elsewhere = parsePrUrl(root.url ?? '')?.url === ref.url ? false : theirs ? theirs.toLowerCase() !== named.toLowerCase() : up
            ? upUrl
              ? !sameRepo(upUrl, ref.owner, ref.repo)
              : `${ref.owner}/${ref.repo}`.toLowerCase() !== up.name.toLowerCase()
            : !!this.o.remote && (!sameRepo(this.o.remote, ref.owner, ref.repo) || (!!host && host !== ref.host.toLowerCase()));
          // one of the card's further pull requests reported again is that one, wherever it is
          const known = root.more?.find((m) => parsePrUrl(m.url ?? '')?.url === ref.url);
          let pr: PrState;
          // the card's own reported again keeps what was told of it; another in its place starts afresh
          if (!elsewhere && !known)
            pr =
              parsePrUrl(root.url ?? '')?.url === ref.url || !root.url
                ? { ...reopened(root), url: ref.url, number: ref.number, ...(up ? { repo: `${ref.owner}/${ref.repo}` } : {}) }
                : {
                    url: ref.url,
                    number: ref.number,
                    seen: [],
                    reported: [],
                    ...(root.more ? { more: root.more } : {}),
                    ...(up ? { upstream: up, repo: named } : {}),
                    // in its place in the original: its maintainers merge it, as they would have the one before
                    ...(theirs ? { repo: named } : {}),
                    ...(root.maintainers ? { maintainers: true as const } : {}),
                  };
          else if (known) pr = { ...root, more: root.more!.map((m) => (m === known ? { ...reopened(known), url: ref.url } : m)) };
          else pr = { ...root, more: [...(root.more ?? []), { url: ref.url, number: ref.number, repo: named, seen: [], reported: [] }] };
          this.o.board.work(cardId, { pr: toJson(pr) });
          this.o.board.log(cardId, 'state', 'worker', this.o.board.t.worker.prOpened(elsewhere || up || theirs ? `${(up || theirs) && !elsewhere ? named : ref.repo} #${ref.number}` : `#${ref.number}`));
          this.o.onPrOpened?.(cardId);
          return ending('Recorded. End your turn now; Obeya watches the pull request.', 'Recorded: Obeya watches the pull request.', 'a change to the work goes onto the pull request');
        },
      },
      {
        name: 'ready_for_review',
        description: `Hand the finished work to the owner, after committing it, running the checks and making the demo. The summary (in ${language}) is what this handover tells the owner beyond what the card's conversation already holds: on your first handover, what changed from the user's point of view and what they really need to know (something left open or not verified, a decision you took for them), in a few short paragraphs at most; on a later one, only what your last handover and your replies since have not said yet, often a sentence. Obeya keeps your handovers and replies together as the card's report for whoever reads it later. A problem you noticed outside the task goes to propose_card, not into the summary, as does a follow-up to your task that is due only later (start_at). The demo: a video's directory and chapter titles in scene order, or an HTML artifact's directory, with its report (in the language of its narration); without a new one, the demo already on the card stands. Then end your turn.`,
        schema: {
          summary: z.string(),
          demo: z
            .object({
              kind: z
                .enum(['video', 'html'])
                .optional()
                .describe("'video' (the default): a recording made with the demo skill; 'html': a page to look at, for results that are seen rather than watched happening"),
              dir: z.string().describe('absolute path of the demo: a video holds demo.mp4 and captions.vtt (and a captions.<language>.vtt per subtitle language), an HTML artifact holds index.html and the files it loads'),
              chapters: z.array(z.string()).optional().describe('video only: scene titles, in order'),
              question: z
                .object({
                  text: z.string(),
                  options: z.array(z.string()).max(4).optional(),
                  multiple: z.boolean().optional(),
                  pick: z.array(z.string()).optional(),
                  pick_why: z.string().optional(),
                })
                .optional()
                .describe(
                  `only when something needs the owner beyond approve or feedback${review ? ' or the choice on each finding, which the card offers beside it' : ''}; the owner can answer it on the card before approving. As with ask: up to four short answer options when they exist, which the owner picks with a click (several when multiple is true) or answers in their own words; pick and pick_why: the options you would choose and why, in one short sentence in ${language}`,
                ),
              ...(shares
                ? {
                    page: z
                      .object({
                        title: z.string(),
                        text: z.string(),
                        ...(vocabulary.length
                          ? {
                              tags: z
                                .record(z.string(), z.array(z.string()))
                                .optional()
                                .describe(
                                  `required: for each of these dimensions, the values that fit the change (an empty list where none does), only from those given, so colleagues find the page by them: ${vocabulary.map(([d, v]) => `${d}: ${v.join(', ')}`).join('; ')}`,
                                ),
                            }
                          : {}),
                      })
                      .optional()
                      .describe(
                        `required: the page on which the owner may share the demo (the video, or the HTML artifact below the text) with colleagues, in ${pageLanguage}. They know the product but have never seen Obeya, this card or the plan doc. title: what changes, in a few words; text: two to five sentences on what changes for the user and why, without findings, tests or internal process${vocabulary.length ? '; tags: see there' : ''}`,
                      ),
                    follows: z
                      .enum(['replaces', 'supplements'])
                      .optional()
                      .describe(
                        "when the card has a demo from an earlier handover: 'replaces' if this one shows the change afresh, so a shared page should show it instead; 'supplements' if it only shows what was corrected or explained since, to stand on the shared page beside the one before",
                      ),
                  }
                : {}),
            })
            .optional(),
          ...(review
            ? {
                review: z
                  .object({
                    checks: z.array(z.object({ name: z.string(), passed: z.boolean() })),
                    mergeable: z.boolean().describe('the PR merges into the current default branch without conflicts (your merge probe)'),
                  })
                  .optional()
                  .describe("required: the checks on the PR's head and your merge probe; the findings you record with findings"),
                pr_draft: z
                  .string()
                  .optional()
                  .describe(
                    "when your branch holds commits of your own that are not on the PR yet: the text Obeya posts on the PR once the owner approves, after pushing them onto its branch. What you changed and why, in the PR's language, as the owner's words to the contributor, without mentioning Obeya or agents; with findings the owner sends the contributor along with your changes, the request for them in the same text. The card shows it to the owner first, who may edit it there. Without it, the text on the card stands.",
                  ),
              }
            : {}),
          ...(review || this.folder
            ? {}
            : {
                pull_requests: z
                  .array(z.string())
                  .max(4)
                  .optional()
                  .describe(
                    'only when your work went onto pull requests that are open already instead of onto your branch (one you opened or pushed to in another repository, say), so your branch holds nothing to land: their URLs. Approved, the card then follows them until they are merged, and Obeya passes you their review comments, failed checks and conflicts, instead of closing the card as done. Leave it out to have the approval close the card.',
                  ),
              }),
          files: z
            .array(z.object({ path: z.string(), caption: z.string() }))
            .max(MAX_RESULT_FILES)
            .optional()
            .describe(
              `the files your card made or changed ${this.folder ? 'in the folder' : 'on your branch'} that are the result for the owner (a document, a report, a spreadsheet, a page; not the code or configuration behind it), each with its path and a one-line caption in ${language}. The card shows them beside the demo: Markdown formatted, a PDF in the browser's viewer, any other file to open on the owner's computer. Without them, the ones named at your last handover stand.`,
            ),
        },
        run: (args) => this.handOver(cardId, args as unknown as HandOverArgs, { review, shares, vocabulary, ended, handOver, ending }),
      },
      {
        name: 'close_unchanged',
        description: `After the owner approved: your work changed nothing in the repository (no commits, nothing uncommitted), because the task needed no change to the code (a demo, an analysis, an answer). Then nothing lands and there is no pull request to open: this closes the card as done instead. Then end your turn.`,
        schema: {},
        run: async () => {
          const row = this.o.board.row(cardId);
          if (row.landed) return 'Not recorded: the card is finished already.';
          // a review card whose pull request was closed lands nothing, whatever its branch holds
          if (fromJson(row.contribution)?.closed) return [`Recorded: the card is done.`, this.w.close(cardId, 'worker'), AFTER_LANDING].filter(Boolean).join(' ');
          const work = await this.o.workspaces.hasWork(cardId);
          const pr = fromJson(row.pr);
          if (!row.approved_at && !(pr && !pr.url)) return 'Not recorded: only work the owner approved can be closed, and only before its pull request is open. Hand it over with ready_for_review first.';
          if (work)
            return 'Not recorded: your branch holds commits or uncommitted changes. Work that changes the repository lands (or goes out as a pull request); throw away what is not meant to land first, if nothing is.';
          const page = this.w.close(cardId, 'worker');
          return [`Recorded: the card is done.`, page, AFTER_LANDING].filter(Boolean).join(' ');
        },
      },
      {
        name: 'after_restart',
        description: 'Only after your work has landed and Obeya said it starts again for it: what remains needs Obeya to run your change. Then end your turn; Obeya tells you once it runs your change.',
        schema: {},
        run: () => {
          const row = this.o.board.row(cardId);
          const l = fromJson(row.landed);
          // landed, and in a pull request in another repository since
          const elsewhere = fromJson(row.pr);
          if (!l && elsewhere?.onMain) {
            if (!elsewhere.onMain.restarts) return 'Not recorded: Obeya does not start again for this landing; what runs now is what you get.';
            this.o.board.work(cardId, { pr: toJson({ ...elsewhere, onMain: { ...elsewhere.onMain, waits: true } }) });
            this.o.board.log(cardId, 'activity', 'worker', this.o.board.t.worker.waitsForRestart);
            return ending('Recorded. End your turn now.', 'Recorded: Obeya tells you once it runs your change.');
          }
          if (!l) return 'Not recorded: your work has not landed.';
          if (!l.restarts) return 'Not recorded: Obeya does not start again for this landing; what runs now is what you get.';
          this.o.board.work(cardId, { landed: toJson({ ...l, waits: true }) });
          this.o.board.log(cardId, 'activity', 'worker', this.o.board.t.worker.waitsForRestart);
          return ending('Recorded. End your turn now.', 'Recorded: Obeya tells you once it runs your change.');
        },
      },
      {
        name: 'snooze',
        description: [
          `Snooze while there is nothing to do until a point in time further off than a background command can wait (a check at midnight, a test that runs for days, a report on the 31st), or until another card on this canvas gets somewhere (its fix is on main, its demo is ready).`,
          `until: that time, ISO 8601 with your timezone's offset (2026-10-31T08:00:00+01:00). card: the title of the card to wait on; state: what it is to reach, 'done' (its work is on main, or it closed without a change; the default) or 'waits_for_owner' (it asks the owner or hands its work over). Give until, card or both: Obeya wakes you at whichever comes first, and also when that card can no longer get there (stopped, archived, removed).`,
          `why: what you do then, in a few words in ${language}, shown on the card. Your session ends with your turn, and whatever you still run in the background with it; workspace and branch stay. Obeya resumes this session then, or earlier with a note from the owner or whatever else comes for you (a review, the landing). For checkpoints one after the other, snooze to the next one each time you wake. Then end your turn.`,
        ].join(' '),
        schema: { until: z.string().optional(), why: z.string(), card: z.string().optional(), state: z.enum(['done', 'waits_for_owner']).optional() },
        run: ({ until, why, card: title, state }) => {
          const card = this.o.board.item(cardId);
          if (!card) return 'Not snoozed: the card is gone.';
          if (live.turn.handedOver) return 'Not snoozed: you asked or handed over in this turn, so the card waits for the owner.';
          // taking in the owner's words on its handover, it may snooze as they ask (check again in three days): the handover stands meanwhile
          if (!(card.state === 'working' || card.state === 'inPr' || card.finishing || answering(card))) return 'Not snoozed: the card waits for the owner; their answer or approval comes as your next message.';
          if (card.pausing) return 'Not snoozed: the owner pauses you; end your turn, and once they let you go on, snooze then if it is still due.';
          const named = typeof until === 'string' && until.trim() !== '';
          const at = named ? Date.parse(String(until)) : NaN;
          const when = named ? laterTime(at) : 'ok';
          if (when === 'none') return 'Not snoozed: give the time as ISO 8601 with your timezone offset (2026-10-31T08:00:00+01:00).';
          if (when === 'past') return `Not snoozed: that time has passed (it is ${new Date().toISOString()} now).`;
          if (when === 'far') return 'Not snoozed: snooze for a year at most.';
          let on: Snooze['on'];
          if (typeof title === 'string' && title.trim()) {
            const found = this.cardTitled(cardId, title.trim());
            if (typeof found === 'string') return `Not snoozed: ${found}`;
            const awaits = state === 'waits_for_owner' ? 'waitsForOwner' : AWAITED_STATES[0];
            const now = awaited(found, awaits);
            if (now === 'reached') return `Not snoozed: the card “${found.title}” ${awaits === 'done' ? 'is done already' : 'waits for the owner already'}.`;
            if (now) return `Not snoozed: the card “${found.title}” cannot get there now (${now}).`;
            on = { card: found.id, title: found.title, state: awaits };
          } else if (!named) return 'Not snoozed: give until, card, or both.';
          live.turn.snoozed = true;
          live.nudged = false;
          const s: Snooze = { ...(named ? { until: new Date(at).toISOString() } : {}), ...(on ? { on } : {}), by: 'agent', ...(String(why).trim() ? { why: clip(String(why).trim(), 200) } : {}) };
          this.o.board.snooze(cardId, s);
          return ending(
            `Snoozed until ${snoozedUntil(s)}. End your turn now; Obeya resumes this session then.`,
            `Snoozed until ${snoozedUntil(s)}: Obeya resumes this session then.`,
            'if they change what you wait for, snooze anew',
          );
        },
      },
      {
        name: 'app_running',
        description: `The app runs in your workspace and opens in a browser: its address as you open it (http://localhost:5173, say), so the owner can open it from the card to try it by hand while it runs. Again each time you start it anew or its address changes; an empty url once you stop it.`,
        schema: { url: z.string() },
        run: ({ url }) => {
          const u = String(url).trim();
          if (!u) {
            this.o.board.work(cardId, { app: null });
            return 'Recorded: the card no longer offers the app.';
          }
          if (!APP_URL.test(u)) return 'Not recorded: give the address as http(s)://host:port/….';
          this.o.board.work(cardId, { app: u });
          return 'Recorded: the card offers the app to the owner while it answers there.';
        },
      },
      ...(this.w.inWorktree(cardId)
        ? [
            {
              name: 'need_clone',
              description: "Only in a follow-up in a temporary worktree: answering the owner needs a full clone (the repository's app or tooling, which may not run here). Then end your turn; Obeya resumes you in the next free clone.",
              schema: {},
              run: () => {
                const l = fromJson(this.o.board.row(cardId).landed);
                if (!l?.worktree) return 'Not recorded: you work in a full clone already.';
                this.o.board.work(cardId, { landed: toJson({ ...l, needsClone: true }) });
                this.o.board.log(cardId, 'activity', 'worker', this.o.board.t.worker.needsClone);
                return 'Recorded. Tell the owner with reply that you go on once a clone is free, then end your turn: Obeya resumes you in the next free clone.';
              },
            } satisfies AgentTool,
          ]
        : []),
      ...(this.o.toObeya
        ? [
            toObeyaTool((request) => {
              // what Obeya does or replies is shown to the owner as the answer to their words
              live.turn.spoke = true;
              return this.o.toObeya!(cardId, request);
            }),
          ]
        : []),
    ]);
  }

  /**
   * `ready_for_review`: the checks in the order the worker meets their refusals, then what the
   * handover records, then what the worker hears. What git and the demo's files tell is read first,
   * without blocking the server; the session may have ended meanwhile, and from that check on the
   * handover reads and writes the card at once. The copy of a new demo Obeya keeps is made last.
   */
  private async handOver(cardId: string, a: HandOverArgs, x: HandOverContext): Promise<string> {
    const long = tooLong(String(a.summary), 6000, 'ready_for_review');
    if (long) return long;
    // a stopped pull this worker resolved lands as it hands it over, without the owner
    const resolving = fromJson(this.o.board.row(cardId).landed)?.resolve;
    if (resolving) return this.w.reviews.landResolved(cardId, resolving);
    // a plan doc for an idea with prototypes says clearly which one it builds on, before it goes to the owner
    const unclear = await this.prototypesUnclear(cardId);
    if (unclear) return unclear;
    // the files named as the result, checked against what the card changed before anything is handed over
    const { named, left } = a.files !== undefined ? await this.namedFiles(cardId, a.files) : {};
    const result = await this.handOverWith(cardId, a, x, named);
    return left && !result.startsWith('Not ') ? `${result}\n\n${left}` : result;
  }

  /** `handOver` with the files named as the result checked (`namedFiles`). */
  private async handOverWith(cardId: string, a: HandOverArgs, x: HandOverContext, named: CardFile[] | undefined): Promise<string> {
    const { review } = x;
    let d = a.demo;
    if (d) {
      // a demo made on another machine is served and shared from its copy here
      const here = await this.demoHere(cardId, d.dir);
      if ('wrong' in here) return `Not handed over: the demo could not be copied to the owner's machine (${here.wrong}). Check the directory, then call ready_for_review again.`;
      d = { ...d, dir: here.dir };
    }
    // what a video's player needs to know of it
    const facts = d && (d.kind ?? 'video') === 'video' ? await videoFacts(d.dir) : {};
    // in a folder, what the change has to show decides whether a handover without a demo shows it beside the conversation
    const shows = !!this.folder && !d && (await this.w.showsFiles(cardId));
    // whether the branch holds work and decides where it lands; a review card hands over the PR's head
    // it reviewed, which is all Obeya ever merges, with the commits of its own on top, which Obeya
    // pushes on the owner's approval
    let git: { work: boolean; own?: CardLanding; mine?: OwnCommits; changed?: string[]; upstreamNew?: number; follows?: AdoptedPr[] };
    if (review) {
      const mine = await this.w.reviews.ownCommits(cardId, review);
      if (typeof mine === 'string') return mine;
      git = { work: true, mine };
    } else {
      const [work, { own, land }] = await Promise.all([this.o.workspaces.hasWork(cardId), this.w.landingOf(cardId)]);
      git = { work, ...(own ? { own } : {}), ...(work && !this.folder ? { changed: await this.o.workspaces.changedFiles(cardId) } : {}) };
      if (a.pull_requests?.length && !this.folder) {
        const prs = await this.followed(a.pull_requests, work, land);
        if (typeof prs === 'string') return prs;
        git.follows = prs;
      }
      // in a fork: what of the original the main branch would get with the work, should it go there as a pull request too
      const up = work ? this.o.upstream?.() : undefined;
      if (up) {
        const ws = this.o.workspaces;
        const n = (await ws.upstreamBased?.(cardId, up.ref)) ? (await ws.upstreamBase?.(cardId, up.ref))?.brings : await ws.upstreamAhead?.(up.ref);
        if (n) git.upstreamNew = n;
      }
    }
    // reading what the change shows takes a while, in which the owner may stop or replace the session
    if (x.ended()) return SESSION_ENDED;
    const row = this.o.board.row(cardId);
    const refused = this.handOverRefused(cardId, row, a, review);
    if (refused) return refused;
    // what goes onto the PR with the owner's approval: the worker's own commits and their text, with the requests to the contributor decided meanwhile
    const held = review && git.mine ? this.w.reviews.heldAt(cardId, git.mine, typeof a.pr_draft === 'string' ? a.pr_draft : undefined) : undefined;
    if (typeof held === 'string') return held;
    // approved work that could not land comes back to be landed, not reviewed: its demo stands
    const approved = !!row.approved_at;
    // without a new demo, the one on the card stands, unless it only came with a question
    const asked = !!row.demo && !!fromJson(row.demo).asked;
    const kept = !d && !!row.demo && !asked;
    // in a folder without git the card's change list shows what changed, where often nothing can be shown on screen
    if (!d && !kept && !approved && !this.folder)
      return `Not handed over: every handover brings a demo${row.demo ? ' (the one you showed with your question is not one)' : ''}. Record it with ${this.w.brief.demoSkill(cardId)}, or make an HTML artifact when the result is something to look at, then call ready_for_review again with it.`;
    const demo = d && this.demoOf(d, row, x, facts);
    if (typeof demo === 'string') return demo;
    x.handOver();
    const handover = this.record(cardId, row, a, x, { ...git, held, demo, kept, asked, approved, named, shows });
    if (demo) await this.keep(cardId, handover);
    if (approved)
      return review
        ? x.ending(
            'Recorded. End your turn now; once it has ended, Obeya pushes your commits onto the pull request and merges it.',
            'Recorded: once your turn has ended, Obeya pushes your commits onto the pull request and merges it.',
            'a change to the work is to be committed by then',
          )
        : x.ending('Recorded. End your turn now; once it has ended, Obeya lands your work on main.', 'Recorded: once your turn has ended, Obeya lands your work on main.', 'a change to the work is to be committed by then');
    // what the owner's button does, as Obeya sees the branch: the worker may know of no commit on it but its own
    const { changed } = git;
    const lands =
      review || this.folder
        ? ''
        : !git.work
          ? git.follows
            ? ` Obeya sees no change on your branch: approving follows ${git.follows.map((p) => `pull request ${p.url}`).join(' and ')} until ${git.follows.length > 1 ? 'they are' : 'it is'} merged, and nothing lands from your branch.`
            : ' Obeya sees no change on your branch: approving closes the card, and nothing lands.'
          : changed?.length
            ? ` Approving lands your branch's change to ${changed.length === 1 ? '1 file' : `${changed.length} files`}: ${changed.slice(0, 8).join(', ')}${changed.length > 8 ? ', …' : ''}.`
            : '';
    return x.ending(`${END_TURN}${lands}`, `Recorded: your handover waits for the owner's approval.${lands}`, 'if they change what you handed over, hand it over again');
  }

  /**
   * The pull requests a handover names as where its work went instead of onto the branch
   * (`pull_requests`), as the approval follows them: each with its repository where that is another
   * than `origin`'s, and whether its maintainers merge it rather than the owner's account (also where
   * the forge cannot tell). Refused where a URL is no pull request's, or where the branch holds work,
   * which lands with the approval instead.
   */
  private async followed(urls: string[], work: boolean, land: 'main' | 'pr'): Promise<AdoptedPr[] | string> {
    const refs: NonNullable<ReturnType<typeof parsePrUrl>>[] = [];
    for (const url of urls) {
      const ref = parsePrUrl(String(url));
      if (!ref) return `Not handed over: ${clip(oneLine(String(url)), 200)} is not the URL of a pull request (on GitHub or GitHub Enterprise https://<host>/<owner>/<repo>/pull/<number>, on Forgejo or Gitea such as Codeberg https://<host>/<owner>/<repo>/pulls/<number>). Call ready_for_review again with pull_requests corrected.`;
      if (!refs.some((r) => r.url === ref.url)) refs.push(ref);
    }
    if (work)
      return `Not handed over: your branch holds commits or uncommitted changes, which land with the approval${land === 'pr' ? ' as a pull request of their own' : ''}; pull_requests is only for work that went onto pull requests instead of your branch. Throw away what is not meant to land, or hand over without pull_requests${land === 'pr' ? ': a pull request in another repository that the work also needs, you report after the approval with pr_opened' : ''}.`;
    const cwd = this.o.repoPath ?? '.';
    const host = this.o.remote && remoteHost(this.o.remote)?.toLowerCase().replace(/^ssh\.github\.com$/, 'github.com');
    return Promise.all(
      refs.map(async (ref): Promise<AdoptedPr> => {
        const ours = !!this.o.remote && sameRepo(this.o.remote, ref.owner, ref.repo) && (!host || host === ref.host.toLowerCase());
        let may: boolean | null = null;
        try {
          may = (await this.o.forge?.mayMerge?.(cwd, ref.url)) ?? null;
        } catch (e) {
          console.error(`permissions for ${ref.url}:`, messageOf(e));
        }
        return { url: ref.url, number: ref.number, ...(ours ? {} : { repo: `${ref.owner}/${ref.repo}` }), ...(may === true ? {} : { maintainers: true as const }) };
      }),
    );
  }

  /** Why the card cannot be handed over as it stands, before its demo is looked at; nothing where it can. */
  private handOverRefused(cardId: string, row: CardRow, a: HandOverArgs, review: StoredContribution | null): string | undefined {
    if (row.landed) return 'Not handed over: your work is on main already.';
    if (row.pr && !review) return 'Not handed over: the work is in its pull request, where Obeya follows it.';
    if (review && !a.review) return "Not handed over: a review card's handover says what the checks and the merge probe found (review). Call ready_for_review again with it.";
    if (review && !fromJson(row.contribution)?.findings) return 'Not handed over: record your findings first (findings; an empty list where your review found nothing), then call ready_for_review again.';
    const owed = review && this.w.reviews.owedTasks(cardId);
    if (owed) return `Not handed over: first make the follow-up tasks the owner chose, for ${owed}; then call ready_for_review again.`;
    return undefined;
  }

  /** The new demo `d` as the card keeps it, with its report and its page for colleagues; or why it is not handed over. */
  private demoOf(d: GivenDemo, row: CardRow, x: HandOverContext, facts: Awaited<ReturnType<typeof videoFacts>>): StoredDemo | string {
    const { vocabulary } = x;
    // what the worker says of it beside the demo before, for the owner's buttons when the page shows that one
    const report = { ...(d.question?.text.trim() ? demoQuestion(d.question) : {}), ...(row.demo && (d.follows === 'replaces' || d.follows === 'supplements') ? { follows: d.follows } : {}) };
    const tags = vocabulary.length && d.page?.tags && typeof d.page.tags === 'object' ? (d.page.tags as PageTags) : undefined;
    const page = d.page && d.page.title.trim() && d.page.text.trim() ? { title: clip(d.page.title.trim(), 200), text: clip(d.page.text.trim(), 2000), ...(tags ? { tags: tagsOf(tags, Object.fromEntries(vocabulary)) } : {}) } : undefined;
    if (x.shares && !page) return 'Not handed over: a demo here needs its page (title and text) for colleagues, in case the owner shares it. Call ready_for_review again with demo.page.';
    if (vocabulary.length) {
      const wrong = tags ? outside(tags, Object.fromEntries(vocabulary)) : [];
      const lacking = vocabulary.filter(([dim]) => !tags?.[dim]).map(([dim]) => dim);
      if (wrong.length) return `Not handed over: the page's tags come from the site's alone, and these are not among them: ${wrong.join(', ')}. Call ready_for_review again with demo.page.tags from those its description gives.`;
      if (lacking.length) return `Not handed over: the page's tags lack ${lacking.join(', ')}. Give each dimension its values (an empty list where none fits), then call ready_for_review again.`;
    }
    const shown = checkedDemo(d);
    if ('wrong' in shown) return `Not handed over: ${shown.wrong}. Fix the ${shown.fix}, then call ready_for_review again.`;
    return { ...shown, ...(shown.kind === 'video' ? facts : {}), ...report, ...(page ? { page } : {}) };
  }

  /**
   * What a handover records on the card: a review card's results, the handover in the conversation
   * with the card's report, the demo (the one it replaces kept with the card), the files named, and
   * the card waiting for the owner, or approved work staying with Obeya. Returns the handover's event.
   */
  private record(cardId: string, row: CardRow, a: HandOverArgs, x: HandOverContext, h: HandedOver): number {
    const { review } = x;
    const { demo, kept, asked, approved, named, held, mine, work, own, follows } = h;
    const checked = a.review;
    if (review && checked) {
      const now = fromJson(this.o.board.row(cardId).contribution) ?? review;
      const { requested: _, held: __, changing: ___, ...rest } = now;
      const results = { checks: checked.checks.slice(0, 20).map((c) => ({ name: clip(c.name, 60), passed: !!c.passed })), mergeable: !!checked.mergeable };
      const findings = held && rest.findings?.map((f) => (held.asks.includes(f.id) ? { ...f, withChanges: true as const } : f));
      this.o.board.work(cardId, {
        contribution: toJson({ ...rest, reviewed: mine?.head, results, ...(held ? { held, ...(findings ? { findings } : {}) } : {}) }),
        ...(row.state === 'inPr' ? { state: 'working' } : {}),
      });
      // what the pull after the merge would run into on the local main, for the owner to see before approving
      void this.w.reviews.probeClash(cardId);
    }
    const s = String(a.summary);
    const report = this.report(cardId, s);
    const e = this.o.board.log(cardId, 'review', 'worker', s);
    // the demo report's question goes with the handover it came with, also once a later one keeps the demo
    const newDemo = demo && { ...demo, handover: e.id, at: e.at };
    // the demo it replaces stays with the card, for the owner to go back to; so do a question's drafts, which are no handover's result
    const demos = (newDemo || asked) && row.demo ? this.earlier(cardId, row) : undefined;
    // a handover in answer to the owner's words that brings no new demo is an answer to them, not a demo to watch
    const answered = !demo && !!row.detail && !!fromJson(row.detail).answering;
    // approved work does not wait for the owner again: it stays with Obeya until its turn has ended
    this.o.board.work(cardId, {
      // the worker's last status line is about the work it hands over: it would show again once the card is at work
      ...(approved ? { status_line: review ? this.o.board.t.worker.mergingPr(review.number) : this.o.board.t.worker.landing } : { state: 'waiting', need: demo || kept ? 'demo' : 'review', status_line: null }),
      // approving work that changes nothing makes the card done, which the owner sees before approving; where work
      // lands that its own branch decides, likewise
      detail: toJson({ summary: report, ...(work ? (own ? { lands: own } : {}) : { noChange: true, ...(follows ? { followsPrs: follows } : {}) }), ...(h.upstreamNew ? { upstreamNew: h.upstreamNew } : {}), ...(answered && !approved ? { answered: true } : {}) }),
      ...(newDemo ? { demo: toJson(newDemo) } : asked ? { demo: null } : {}),
      ...(demos ? { demos } : {}),
      // the files named stand until a later handover names others (an empty list named clears them); a folder's card handed
      // over without a demo shows what it changed, while there are files of it to show
      ...(named?.length ? { files: toJson(named) } : this.folder && !demo && !kept && (named || !row.files || row.files === '[]') ? { files: h.shows ? '[]' : null } : named ? { files: null } : {}),
    });
    // the size of the change handed over, for the page to lay out its change list from the first time it opens the card
    void this.w.diff(cardId, false).catch(() => {});
    const card = this.o.board.item(cardId);
    if (card?.prototypeOf) this.o.onPrototype?.(card, report, newDemo);
    return e.id;
  }

  proposalBoards(): Board[] {
    return [this.o.board, ...this.otherBoards()];
  }

  private otherBoards(): Board[] {
    return (this.o.otherBoards?.() ?? []).filter((b) => b !== this.o.board);
  }

  /**
   * The repository a worker names for its proposal (by id, name or path) and the board of its
   * canvas: this canvas's first, then another canvas's; or why there is none.
   */
  private proposalRepo(wanted: string): { board: Board; repo: string } | string {
    const w = wanted.toLowerCase();
    const dir = (path: string) => path.replace(/[/\\]+$/, '');
    const named = (r: RepoRef) => r.id.toLowerCase() === w || r.name.toLowerCase() === w || dir(r.path) === dir(wanted);
    const here = this.o.board.canvas.repos.find(named);
    if (here) return { board: this.o.board, repo: here.id };
    const found = this.otherBoards().flatMap((board) => board.canvas.repos.filter(named).map((r) => ({ board, repo: r.id, path: r.path })));
    if (found.length === 1) return found[0]!;
    if (found.length > 1) return `Not proposed: several canvases have a repository ${wanted}; give its path instead: ${found.map((f) => f.path).join(', ')}.`;
    const all = this.proposalBoards().flatMap((b) => b.canvas.repos.map((r) => r.id));
    return `Not proposed: Obeya has no repository ${wanted}; give one of ${all.join(', ')}.`;
  }

  /** The worker takes back one of its proposals by title, or marks it replaced (`s.by`): what became of it, as the tool's result. */
  private retract(cardId: string, title: string, s: Superseded): string {
    // the proposal may be on another canvas: where none of this card's has the title, the next one is asked
    const mine: Extract<Retracted, { kind: 'unknown' }>['mine'] = [];
    let r: Retracted = { kind: 'unknown', mine };
    for (const b of this.proposalBoards()) {
      const there = b.retract(cardId, title, s);
      if (there.kind !== 'unknown') {
        r = there;
        break;
      }
      mine.push(...there.mine);
    }
    if (r.kind === 'gone' || r.kind === 'marked') this.o.board.log(cardId, 'activity', 'worker', this.o.board.t.worker.withdrewProposal(r.title, s.why, s.title));
    return retractedText(r, !!s.by);
  }

  /**
   * The card of the canvas a worker means by `title`, to wait on: the one by that title (the open
   * one, of several), else the one whose title holds it, if only one does; else why there is none.
   */
  private cardTitled(cardId: string, title: string): Item | string {
    const items = this.o.board.items().filter((i) => i.id !== cardId && i.kind !== 'project');
    const key = titleKey(title);
    const exact = items.filter((i) => titleKey(i.title) === key);
    const pick = (of: Item[]) => of.findLast((i) => !i.archivedAt && !finished(i.state)) ?? of.at(-1)!;
    if (exact.length) return pick(exact);
    const near = items.filter((i) => !i.archivedAt && !finished(i.state) && titleKey(i.title).includes(key));
    if (near.length === 1) return near[0]!;
    if (near.length > 1) return `several cards have “${title}” in their title (${near.map((i) => `“${i.title}”`).join(', ')}); give one's full title.`;
    return `no card on the canvas is called “${title}”.`;
  }

  /**
   * Obeya keeps a copy of the card's demo just handed over with the event `handover` (`keepDemo`),
   * where it keeps demos: the card names it once made, unless another demo took its place meanwhile.
   */
  private async keep(cardId: string, handover: number) {
    const demo = fromJson(this.o.board.row(cardId).demo);
    if (!this.o.keptDemos || demo?.handover !== handover) return;
    const kept = join(this.o.keptDemos, cardId, String(handover));
    if (!(await keepDemo(demo, kept))) return;
    // another demo may have taken its place while the copy was made: the card's earlier demos are then served from it
    const row = this.o.board.row(cardId);
    const now = fromJson(row.demo);
    if (now?.handover === handover) return this.o.board.work(cardId, { demo: toJson({ ...now, kept }) });
    const earlier = fromJson(row.demos) ?? [];
    if (earlier.some((d) => d.handover === handover)) this.o.board.work(cardId, { demos: toJson(earlier.map((d) => (d.handover === handover ? { ...d, dir: kept } : d))) });
  }

  /**
   * The card's earlier demos with the one a new handover replaces added, as `CardRow.demos` keeps
   * them. A demo from before handovers named theirs gets the last one before now: its time, and the
   * places in it the owner's comments are about.
   */
  private earlier(cardId: string, row: CardRow): Json<StoredDemo[]> {
    const { kept, ...replaced } = fromJson(row.demo!);
    const e = replaced.handover === undefined ? this.o.board.events(cardId).findLast((e) => e.kind === 'review') : undefined;
    // from its copy: the new demo may have been rendered over its files
    const dir = kept && existsSync(kept) ? kept : replaced.dir;
    return toJson([...(fromJson(row.demos) ?? []), { ...replaced, dir, ...(e ? { handover: e.id, at: e.at } : {}) }]);
  }

  /**
   * A demo directory as the server reads it: the worker's own on this machine; from a worker on
   * another machine, its copy here (design: Hosts), taken afresh at each handover.
   */
  private async demoHere(cardId: string, dir: string): Promise<{ dir: string } | { wrong: string }> {
    try {
      const there = remote(this.o.board.row(cardId).workspace);
      if (!there) return { dir };
      const copy = there.host.localCopy(dir);
      await there.host.copyFrom(dir, copy);
      return { dir: copy };
    } catch (e) {
      return { wrong: messageOf(e) };
    }
  }

  /**
   * The card's report for whoever reads it beyond its conversation (a follow-up's worker, the
   * Coordinator, a shared page): a later handover holds only what changed, so the first one since
   * the worker started comes with what it said in the conversation after it, its replies and later
   * handovers, `latest` last.
   */
  private report(cardId: string, latest: string): string {
    const events = this.o.board.events(cardId);
    const since = events.slice(events.findLastIndex(started) + 1).filter((e) => e.author === 'worker' && (e.kind === 'review' || e.kind === 'talk'));
    const first = since.findIndex((e) => e.kind === 'review');
    if (first < 0) return latest;
    return [since[first]!.text, this.o.board.t.worker.laterInConversation, ...since.slice(first + 1).map((e) => e.text), latest].join('\n\n');
  }

  /**
   * The files a worker names as its result at its handover, as paths of its change relative to the
   * workspace (or folder), and what the worker hears of those it named outside its change, which
   * are left out: refusing the handover for them held back the rest of it, also from a worker that
   * never read the refusal (Codex's code mode drops a result its script does not print).
   * `named` is undefined where none of them is of the change, so that earlier ones stand.
   */
  private async namedFiles(cardId: string, files: { path: string; caption: string }[]): Promise<{ named?: CardFile[]; left?: string }> {
    const ws = (this.o.board.row(cardId).workspace ?? '').replace(/^ssh:\/\/[^/]+/, '');
    const roots = [ws, ...(ws && !hostName(this.o.board.row(cardId).workspace) ? [realPath(ws)] : [])].filter(Boolean);
    const changed = await this.w.changedFiles(cardId);
    const out: CardFile[] = [];
    const outside: string[] = [];
    for (const f of files) {
      let given = String(f.path).trim();
      // a path of the workspace, with backslashes where it is one of Windows
      const root = roots.find((r) => given.startsWith(r) && /^[\\/]/.test(given.slice(r.length)));
      if (root) given = given.slice(root.length + 1);
      const path = isAbsolute(given) ? null : normalPath(given);
      if (!path || !changed.includes(path)) outside.push(String(f.path));
      else if (!out.some((o) => o.path === path)) out.push({ path, caption: clip(oneLine(String(f.caption ?? '')), 200) });
    }
    if (!outside.length) return { named: out };
    const list = changed.length ? `(${changed.slice(0, 30).join(', ')}${changed.length > 30 ? ', …' : ''})` : '(none)';
    const left = `${outside.join(', ')} ${outside.length === 1 ? 'is' : 'are'} not among the files your card made or changed ${list}, so the card does not show ${outside.length === 1 ? 'it' : 'them'}.`;
    return { named: out.length ? out : files.length ? undefined : out, left };
  }

  /**
   * Why the plan doc an idea's card writes does not say clearly which of the idea's prototypes the
   * project builds on (`prototypeBuild`), as the worker reads it at its handover; undefined where it
   * does, or the card writes no plan doc for an idea with prototypes.
   */
  private prototypesUnclear(cardId: string): Promise<string | undefined> | undefined {
    const row = this.o.board.row(cardId);
    const prototypes = this.o.board.items().filter((i) => i.prototypeOf === cardId);
    if (!row.becomes_project || !row.idea || !prototypes.length) return undefined;
    return this.planDocsWritten(cardId).then((docs) => {
      const workstreams = docs.flatMap((d) => {
        const doc = parsePlanDoc(d.file, d.markdown);
        return 'workstreams' in doc ? doc.workstreams.filter((w) => !w.done) : [];
      });
      const build = prototypeBuild(workstreams, prototypes);
      const label = (ws: typeof workstreams) => ws.map((w) => w.label ?? `“${w.title}”`).join(', ');
      if ('none' in build || ('also' in build && !build.also.length)) return undefined;
      const what =
        'also' in build
          ? `the workstreams ${label([build.workstream, ...build.also])} each name or mention a prototype`
          : { several: `the workstreams ${label(build.workstreams)} each name or mention a prototype`, many: `the workstream ${label(build.workstreams)} names several prototypes`, unnamed: `the workstream ${label(build.workstreams)} mentions a prototype without naming which` }[build.unclear];
      return `Not handed over: in your plan doc, ${what}. Once the project stands, Obeya gives the chosen prototype's branch to the one workstream that names it by its name in quotes (${prototypes.map((p) => `“${prototypeName(p)}”`).join(', ')}), and discards the other prototypes; no other workstream names or mentions a prototype, and where the plan builds on none, none mentions one. If it is not clear which prototype the plan builds on, ask the owner. Then call ready_for_review again.`;
    });
  }

  /** The plan docs the card writes, as its branch holds them now (or the folder outside the repository). */
  private async planDocsWritten(cardId: string): Promise<{ file: string; markdown: string }[]> {
    const row = this.o.board.row(cardId);
    const { dir, exclude } = this.o.adapter.planDocs;
    const outside = outsidePlanDir(dir);
    const files = outside
      ? (fromJson(row.plan_docs) ?? []).map(pathOfRef)
      : (await this.o.workspaces.addedFiles(cardId, dir)).filter((f) => isPlanDoc(f, exclude));
    const read = async (file: string): Promise<string | null> => {
      if (outside) return Bun.file(file).text().catch(() => null);
      const at = await this.o.workspaces.fileOf(cardId, file, row.branch ?? undefined);
      return at && textOf(at);
    };
    const docs = await Promise.all(files.map(async (file) => ({ file, markdown: await read(file) })));
    return docs.flatMap((d) => (d.markdown === null ? [] : [{ file: d.file, markdown: d.markdown }]));
  }
}
