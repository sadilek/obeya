// „Vorschlagen lassen“ at a demo site's tags: a read-only session reads the repository (how the app
// is built: its areas, its users) and the cards of the canvases it is on (finished and open,
// archived ones too, with what their demos show), and proposes a vocabulary of tags, which the
// dialog puts into the field for the owner to change and save. It runs in the background, so the
// dialog may close meanwhile and take the proposal in when it opens again.

import { z } from 'zod';
import { LANGUAGE_NAMES, type Language } from '../core/locale';
import { dimensions, parseTagLines, tagLines } from '../core/page-tags';
import { messageOf } from '../core/text';
import { finished, type Item, type PageTags, type TagProposalJob } from '../core/types';
import { BadRequest } from './board';
import { readSession } from './koordinator';
import type { AgentRuntime } from './runtime';

/** A card as the session reads it. */
export interface TagCard {
  title: string;
  /** Finished (its work landed, or needed no change), at work or waiting, or not started. */
  status: 'done' | 'open' | 'planned';
  task: string;
  /** What its worker handed over, if it did. */
  summary?: string;
  /** Its demos, the latest first: each one's page title and text, else its chapters. */
  demos: string[];
}

/** What the session reads of a repository's cards, from one canvas. */
export function tagCards(items: Item[], summary: (id: string) => string | undefined): TagCard[] {
  return items
    .filter((i) => i.kind !== 'question')
    .map((i) => ({
      title: plainText(i.title),
      status: finished(i.state) ? 'done' : i.state === 'planned' || i.state === 'proposal' || i.state === 'idea' ? 'planned' : 'open',
      task: plainText(i.kind === 'project' ? (i.plan?.goal ?? i.body) : i.body),
      ...(i.kind === 'task' && summary(i.id) ? { summary: plainText(summary(i.id)!) } : {}),
      demos: [...(i.demo ? [i.demo] : []), ...[...(i.demos ?? [])].reverse()].map((d) =>
        d.page ? `${d.page.title}: ${d.page.text}` : d.kind === 'html' ? 'a page to look at' : d.chapters.map(([, t]) => t).join(' · '),
      ),
    }));
}

export interface TagRun {
  runtime: AgentRuntime;
  /** The repository's checkout, where the session reads. */
  cwd: string;
  /** The language of the site's pages, which the tags are in. */
  language: Language;
  /** The owner's language, for why. */
  owner: Language;
  /** The vocabulary the field holds now, if any. */
  current?: PageTags;
  cards: TagCard[];
}

/** The longest brief: the newest cards first, the rest left out. */
const BRIEF_MAX = 80_000;

/** The proposal of a read-only session; it settles with why it has none. */
export async function proposeTags(o: TagRun): Promise<{ tags: PageTags; why: string }> {
  let out: { tags: PageTags; why: string } | null = null;
  let tried = '';
  const error = await readSession(o.runtime, {
    cwd: o.cwd,
    role: 'chores',
    system: system(o.language, o.owner),
    tools: (finish) => [
      {
        name: 'tags',
        description: `The vocabulary of tags: its dimensions, each with its values, in ${LANGUAGE_NAMES[o.language]}; and why, in ${LANGUAGE_NAMES[o.owner]}.`,
        schema: {
          tags: z.record(z.string(), z.array(z.string())).describe('Each dimension with its values, in the order the overview shows them.'),
          why: z.string().describe('At most three short sentences on why these dimensions and values.'),
        },
        run: ({ tags, why }) => {
          if (out) return 'Already proposed.';
          const clean = cleaned(tags);
          if (!clean) return (tried = 'No dimension with values. Call tags again with two to four dimensions, each with its values.');
          out = { tags: clean, why: String(why ?? '').trim().slice(0, 600) };
          return finish('Recorded. End your turn now.');
        },
      },
    ],
    brief: brief(o),
  });
  if (out) return out;
  throw new Error(error ?? (tried ? 'the proposal had no dimension with values' : 'the agent proposed nothing'));
}

/** The tags as the field takes them: no colon in a dimension, no comma in a value, nothing empty; none where nothing is left. */
function cleaned(given: unknown): PageTags | undefined {
  const g = (given && typeof given === 'object' ? given : {}) as Record<string, unknown>;
  const raw: PageTags = Object.fromEntries(
    Object.entries(g).map(([d, v]) => [
      d.replace(/[:\n]/g, ' ').trim(),
      (Array.isArray(v) ? v : []).map((x) => String(x).replace(/[,\n]/g, ' ').trim()).filter(Boolean),
    ]),
  );
  const tags = parseTagLines(tagLines(raw));
  return tags && dimensions(tags).length ? tags : undefined;
}

const system = (language: Language, owner: Language) =>
  `You propose the tags by which colleagues find demos on a site where the changes to an app are shared, a page per change, more than a hundred of them in time. The overview filters by them: a few dimensions (two to four), each with its values (three to twelve), every page carrying per dimension the values that fit it. Workers choose from them when they hand over a change, so the values must be clear without explanation, distinct from each other, and cover what changes in this app now and in the coming months.

Read the repository first to learn how the app is built: its README and docs, its source tree (routes, screens, modules, packages), whom it serves. Then read the cards in the brief: the changes made and planned, and what their demos show. Base the dimensions on both: the parts of the app a colleague would look for (an area, a screen, a feature), and where the cards show it, another axis that tells the changes apart (who they are for, a platform, a kind of change). Name values as a user of the app would, not by file or module names. Where the brief names a vocabulary already in use, keep its dimensions and values that still fit, since pages carry them; change only what the app or the cards ask for.

Call the tool tags once: the dimensions and values in ${LANGUAGE_NAMES[language]}, and why in ${LANGUAGE_NAMES[owner]}: at most three short sentences for the owner, who decides on it. Then end your turn.`;

function brief(o: TagRun): string {
  const head = [
    o.current && dimensions(o.current).length
      ? `The vocabulary in use now, a dimension per line:\n${tagLines(o.current)}`
      : 'The site has no vocabulary yet.',
    o.cards.length ? `The cards of this repository (${o.cards.length}): those on the canvas, then the archive, the most recently archived first:` : 'There are no cards of this repository yet: propose from the repository alone.',
  ].join('\n\n');
  let size = head.length;
  const lines: string[] = [];
  for (const c of o.cards) {
    const line = [
      `- [${c.status}] ${c.title}`,
      c.task && `  Task: ${clip(c.task, 400)}`,
      ...c.demos.slice(0, 3).map((d) => `  Demo: ${clip(d, 400)}`),
      !c.demos.length && c.summary ? `  Handed over: ${clip(c.summary, 300)}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    if (size + line.length > BRIEF_MAX) {
      lines.push(`(${o.cards.length - lines.length} older cards left out)`);
      break;
    }
    size += line.length + 1;
    lines.push(line);
  }
  return [head, ...lines].join('\n');
}

const plainText = (s: string) => s.replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim();

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n).trimEnd()} …` : s);

/** The proposals, by a repository's checkout as the dialog names it. */
export class TagProposals {
  private jobs = new Map<string, TagProposalJob>();

  /** Starts one for the repository; the dialog follows it with `job`. */
  start(path: string, run: () => Promise<{ tags: PageTags; why: string }>): TagProposalJob {
    if (!path) throw new BadRequest('invalid', 'expected { path }');
    if (this.jobs.get(path)?.running) return this.jobs.get(path)!;
    const job: TagProposalJob = { running: true };
    this.jobs.set(path, job);
    run().then(
      ({ tags, why }) => this.jobs.set(path, { running: false, tags, why }),
      (e) => this.jobs.set(path, { running: false, error: messageOf(e) }),
    );
    return job;
  }

  /** The repository's proposal, as far as it got; null without one. */
  job(path: string): TagProposalJob | null {
    return this.jobs.get(path) ?? null;
  }

  /** The dialog took in a finished proposal. */
  doneWith(path: string) {
    if (!this.jobs.get(path)?.running) this.jobs.delete(path);
  }
}
