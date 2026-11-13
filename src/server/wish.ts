// The draft of a wish or a bug for Obeya's makers: a small job writes what the owner wrote or said
// (and, for a request Obeya could not do, its answer) up as a GitHub issue in English, the
// repository's language, with a line about the Obeya it came from. The owner checks and edits it,
// then opens it on GitHub (`src/core/wish.ts`); nothing goes out from here.

import { tmpdir } from 'node:os';
import { z } from 'zod';
import { issueFooter, ISSUES_REPO, withoutFooter } from '../core/wish';
import type { AgentRuntime } from './runtime';
import { oneLine } from '../core/text';

export interface WishInput {
  /** What the owner wrote or said now. */
  said: string;
  /** Obeya's answer that it cannot do what they asked, when the draft starts from one. */
  answer?: string;
  /** The draft so far, as the owner may have edited it: the new words rework it. */
  title?: string;
  body?: string;
}

export interface WishDraft {
  title: string;
  body: string;
  /** The job wrote nothing (not logged in, say): the owner's own words stand in the draft. */
  raw?: true;
  /** With `raw`: the account's usage limit kept the job from writing, until then (ISO time); it can write the draft after. */
  limitedUntil?: string;
}

/** How long the job may take before the owner's words stand as they are. */
const WRITE_MS = 90_000;

const SYSTEM = `
You write a GitHub issue for the makers of Obeya, an open-source app in which one directs coding agents on a canvas, from what one of its users told you. It appears publicly on github.com/${ISSUES_REPO}.
Write it in English, whatever language the user used. title: a short summary, at most about 70 characters. body: what the user wants or what is broken, in markdown, plainly and briefly, in their meaning; add nothing they did not say. Spoken words come through speech recognition and may be misheard: read them for what was most likely meant.
Call issue once, then end your turn.
`.trim();

function brief(w: WishInput, shots: number): string {
  const parts: string[] = [];
  if (w.title?.trim() || w.body?.trim())
    parts.push(`The draft so far, which the user may have edited (keep it, and rework it only where the new words change or add something):\nTitle: ${w.title?.trim() ?? ''}\n\n${withoutFooter(w.body ?? '')}`);
  if (w.answer) parts.push(`The user asked Obeya: “${w.said}”\nObeya answered that it cannot do this: “${w.answer}”\nThe issue is the user's wish for what they asked; Obeya's answer only shows that Obeya lacks it.`);
  else parts.push(`${parts.length ? 'The user adds' : 'The user wrote'}: “${w.said}”`);
  if (shots) parts.push(`The user attached ${shots === 1 ? 'a screenshot' : `${shots} screenshots`} (below); they paste ${shots === 1 ? 'it' : 'them'} into the issue themselves, so describe only what the text needs.`);
  return parts.join('\n\n');
}

/** The issue's title and body, the body ending with `footer`. */
export function writeWish(runtime: AgentRuntime, w: WishInput, footer: string, images: string[] = []): Promise<WishDraft> {
  const said = w.said.trim();
  const fallback = (): WishDraft => {
    const own = [withoutFooter(w.body ?? '').trim(), w.answer ? `> ${said}\n\n${w.answer}` : said].filter(Boolean).join('\n\n');
    const title = w.title?.trim() || said.replace(/\s+/g, ' ').slice(0, 70);
    return { title, body: `${own}\n\n${footer}`, raw: true };
  };
  return new Promise((resolve) => {
    let done = false;
    const end = (d: WishDraft) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      session.close();
      resolve(d);
    };
    const timer = setTimeout(() => end(fallback()), WRITE_MS);
    const session = runtime.start(
      {
        cwd: tmpdir(),
        readOnly: true,
        role: 'chores',
        system: SYSTEM,
        // the owner is waiting for the draft: their words stand in it, and the draft says when the job can write it
        onLimit: (until) => {
          if (until !== undefined) end({ ...fallback(), limitedUntil: new Date(until).toISOString() });
        },
        tools: [
          {
            name: 'issue',
            description: 'The issue: its title and its body (markdown), in English.',
            schema: { title: z.string(), body: z.string() },
            run: (a) => {
              const title = oneLine(String(a.title)).slice(0, 200);
              const body = withoutFooter(String(a.body).trim());
              if (!title || !body) return 'Both title and body, please.';
              end({ title, body: `${body}\n\n${footer}` });
              return 'Recorded. End your turn now.';
            },
          },
        ],
        onEvent: (e) => {
          if (e.type === 'idle' || e.type === 'error') end(fallback());
        },
      },
      brief({ ...w, said }, images.length),
      images,
    );
  });
}

/** The system Obeya runs on, as the issue names it. */
export const osName = (platform: string = process.platform) =>
  platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : platform === 'linux' ? 'Linux' : platform;

/** The footer of an issue from this Obeya: in the app, from a checkout (its commit), or the binary on its own. */
export const footerOf = (version: string, commit: string | null, app: boolean) =>
  issueFooter(version, osName(), app ? 'app' : commit ? `checkout ${commit.slice(0, 7)}` : 'binary');
