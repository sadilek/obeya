// The short reading sessions that write a shared demo page's words (share.ts): its title and text,
// where the worker gave none, and the tags a page lacks from its site's vocabulary.

import { z } from 'zod';
import { LANGUAGE_NAMES } from '../core/locale';
import { dimensions } from '../core/page-tags';
import { plainText } from '../core/text';
import type { Demo, DemoPage, Item, PageTags } from '../core/types';
import type { PageLanguage } from './demo-page';
import { type AgentRuntime, readSession } from './runtime';

/** What the session writing a page's words reads: the card, what its worker handed over, the demo, and where it reads code. */
export interface PageAsk {
  cwd: string;
  card: Pick<Item, 'title' | 'body'>;
  summary: string;
  demo: Demo;
  language: PageLanguage;
  /** The dimensions of the site's vocabulary the card's page lacks tags for, each with its values; it chooses those along with the words. */
  lacking: PageTags | null;
}

/** A page the session choosing tags reads: the title and text of its demos, and the dimensions it lacks, each with its values. */
export interface TagAsk {
  id: string;
  demos: { shown: { title: string; text: string } }[];
  lacking: PageTags;
}

/**
 * The page's text for a demo handed over without one (its repository did not share then): a short
 * session writes it from the worker's summary. Without one, the card's title and the summary's start stand in.
 */
export async function writePage(runtime: AgentRuntime, { cwd, card, summary, demo, language, lacking }: PageAsk): Promise<DemoPage> {
  const fallback: DemoPage = { title: plainText(card.title), text: plainText(summary).split(/(?<=[.!?])\s+/).slice(0, 4).join(' ') || plainText(card.title) };
  let page: DemoPage | null = null;
  await readSession(runtime, {
    cwd,
    role: 'chores',
    system: pageSystem(LANGUAGE_NAMES[language], lacking),
    tools: (finish) => [
      {
        name: 'page',
        description: `The page's title and text, in ${LANGUAGE_NAMES[language]}${lacking ? `, and its tags: ${TAGS_FIELD}` : ''}.`,
        schema: { title: z.string(), text: z.string(), ...(lacking ? { tags: tagsSchema(lacking) } : {}) },
        run: ({ title, text, tags }) => {
          if (page) return 'Already written.';
          page = {
            title: String(title).trim().slice(0, 200) || fallback.title,
            text: String(text).trim().slice(0, 2000) || fallback.text,
            ...(lacking ? { tags: picked(tags, lacking) } : {}),
          };
          return finish('Recorded. End your turn now.');
        },
      },
    ],
    brief: [
      `The card: “${plainText(card.title)}”.`,
      card.body.trim() ? `Its task:\n${card.body.trim().slice(0, 3000)}` : '',
      summary ? `What its worker handed over:\n${summary.slice(0, 4000)}` : '',
      demo.kind === 'html'
        ? 'The demo is a page to look at (an HTML artifact: charts, a comparison, an analysis), not a video.'
        : demo.chapters.length
          ? `The demo video's chapters: ${demo.chapters.map(([, t]) => t).join(' · ')}`
          : '',
    ]
      .filter(Boolean)
      .join('\n\n'),
  });
  return page ?? fallback;
}

/**
 * The tags the pages lack for the site's vocabulary (each such dimension with its values), chosen
 * by one short session from the title and text of their demos; it chooses only those, so what the
 * owner or a worker chose stays. A page it gave no answer for is missing from the result.
 */
export async function chooseTags(runtime: AgentRuntime, cwd: string, pages: TagAsk[]): Promise<Map<string, PageTags>> {
  const got = new Map<string, PageTags>();
  const all: PageTags = {};
  for (const p of pages) for (const [d, v] of dimensions(p.lacking)) all[d] = v;
  const asked = (p: TagAsk) => Object.keys(p.lacking);
  const left = () => pages.flatMap((p, i) => (got.has(p.id) ? [] : [i + 1]));
  await readSession(runtime, {
    cwd,
    role: 'chores',
    system: TAGS_SYSTEM,
    tools: (finish) => [
      {
        name: 'tags',
        description: `A page's tags: its number (\`page\`${pages.length === 1 ? ', 1' : ''}), and ${TAGS_FIELD}.`,
        schema: { page: z.number().int().optional(), tags: tagsSchema(all) },
        run: ({ page, tags }) => {
          const p = pages[(Number(page) || 1) - 1];
          if (!p) return `There is no page ${String(page)}.`;
          if (got.has(p.id)) return 'Already chosen.';
          got.set(p.id, picked(tags, p.lacking));
          return left().length ? `Recorded. Still to tag: page ${left().join(', ')}.` : finish('Recorded. End your turn now.');
        },
      },
    ],
    brief: [
      `The dimensions to choose for, each with its values:\n${dimensions(all)
        .map(([d, v]) => `- ${d}: ${v.join(', ')}`)
        .join('\n')}`,
      ...pages.map((p, i) => {
        const only = asked(p).length < Object.keys(all).length ? ` (only ${asked(p).join(', ')})` : '';
        const head = pages.length > 1 ? `Page ${i + 1}${only}:\n` : '';
        return head + p.demos.map((d, j) => `${j ? 'A later demo on the page' : 'The page'}: “${d.shown.title}”\n${d.shown.text}`).join('\n\n');
      }),
    ].join('\n\n'),
  });
  return got;
}

const pageSystem = (language: string, lacking: PageTags | null) => `You write the page on which the demo of a change (a video, or a page with charts or an analysis) is shared with colleagues of the team. They have never seen the tool the change was planned in, its cards or plan docs; they know the product. Read the card's task and its worker's summary, and call the tool page once with:
- title: what changes, for a user of the product, in a few words (not the card's internal wording).
- text: two to five sentences in ${language}: what changes for the user and why. No findings, no test details, no internal process (cards, workers, demos, reviews), no markdown.${
  lacking
    ? `
- tags: for each of these dimensions, the values that fit the change (an empty list where none does), from these alone:
${dimensions(lacking)
  .map(([d, v]) => `  - ${d}: ${v.join(', ')}`)
  .join('\n')}`
    : ''
}
Then end your turn. Read code only if the summary leaves unclear what the change does for the user.`;

const TAGS_SYSTEM = `You tag pages on which the demos of changes are shared with colleagues, so they find them among many by their tags. For each page the brief names, read its title and text, and call the tool tags once with its number: for each dimension the brief names (or the page's own, where it names some), the values that fit the change (an empty list where none does), from its values alone. Then end your turn.`;

const TAGS_FIELD = 'for each dimension, the values that fit (an empty list where none does), only from the values given for it';

const tagsSchema = (lacking: PageTags) =>
  z
    .record(z.string(), z.array(z.string()))
    .describe(
      dimensions(lacking)
        .map(([d, v]) => `${d}: ${v.join(', ')}`)
        .join('; '),
    );

/** The tags a session gave, kept to the dimensions and values asked for; a dimension it left out has none. */
function picked(given: unknown, lacking: PageTags): PageTags {
  const g = (given && typeof given === 'object' ? given : {}) as Record<string, unknown>;
  return Object.fromEntries(dimensions(lacking).map(([d, values]) => [d, values.filter((v) => Array.isArray(g[d]) && (g[d] as unknown[]).includes(v))]));
}
