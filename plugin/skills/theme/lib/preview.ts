// Shows the repository's shared demo pages with its theme as the checkout has it (`.obeya/theme.css`,
// committed or not), put into them the way Obeya does once the theme is on the default branch: the
// files it names in `.obeya/` as `data:` URLs, everything else dropped. Writes a small site of sample
// pages, the overview at its root, twice: with the theme, and under `without-theme/` in Obeya's own
// look. Its words are in the demo language that applies here. Prints the pages to open.
//
//   bun preview.ts [<out>] [--video <mp4>]
//
// <out>: the directory to write (emptied first; default: a new one in the temp directory).
// --video: a video for the sample pages' player (say, a demo of the app); without one it stays black.

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parseShared, REPO_SETTINGS_FILE } from '../../../../src/adapters/index.ts';
import type { DemoSite } from '../../../../src/core/types.ts';
import type { PageLanguage } from '../../../../src/server/demo-page.ts';
import { type Meta, overviewHtml, pageHtml } from '../../../../src/server/site.ts';
import { THEME_DIR, THEME_FILE, workingTheme } from '../../../../src/server/theme.ts';
import { demoSettingsHere } from '../../demo/lib/settings.ts';

/** A sample page's words: its title, its text, its video's chapters. */
type Shown = { title: string; text: string; chapters: [number, string][] };

/** What the sample site says in a language: who shared its pages, its tags, its pages, a page's later version. */
interface Sample {
  by: string;
  tags: Record<string, string[]>;
  pages: [Shown, Shown, Shown];
  later: Shown;
}

const SAMPLE_EN: Sample = {
  by: 'Alex Example',
  tags: { Area: ['Billing', 'Reports', 'Onboarding'] },
  pages: [
    {
      title: 'Invoices export as PDF',
      text: 'An invoice can now be downloaded as a PDF from its page, with the company logo and the payment details.\n\nThe export keeps the layout of the printed invoice, so customers get the same document either way.',
      chapters: [[0, 'The invoice page'], [14, 'Exporting it'], [31, 'The PDF']],
    },
    {
      title: 'Reports filter by team',
      text: 'Every report has a team filter above its table. A filtered report keeps its filter in the address, so it can be passed on.',
      chapters: [[0, 'A report'], [12, 'Filtering it']],
    },
    {
      title: 'A shorter sign-up',
      text: 'Signing up asks for the email address alone; the rest comes later, in the first steps of the app.',
      chapters: [],
    },
  ],
  later: { title: 'The filter remembers the last team', text: 'Opened again, a report shows the team chosen last.', chapters: [[0, 'Back to the report']] },
};

const SAMPLE: Record<PageLanguage, Sample> = {
  en: SAMPLE_EN,
  de: {
    by: 'Alex Beispiel',
    tags: { Bereich: ['Abrechnung', 'Berichte', 'Einstieg'] },
    pages: [
      {
        title: 'Rechnungen als PDF exportieren',
        text: 'Eine Rechnung lässt sich jetzt auf ihrer Seite als PDF herunterladen, mit dem Logo der Firma und den Zahlungsdaten.\n\nDer Export behält das Layout der gedruckten Rechnung, so bekommen Kunden auf beiden Wegen dasselbe Dokument.',
        chapters: [[0, 'Die Rechnungsseite'], [14, 'Der Export'], [31, 'Das PDF']],
      },
      {
        title: 'Berichte nach Team filtern',
        text: 'Jeder Bericht hat über seiner Tabelle einen Filter nach Team. Ein gefilterter Bericht behält den Filter in der Adresse, so lässt er sich weitergeben.',
        chapters: [[0, 'Ein Bericht'], [12, 'Gefiltert']],
      },
      {
        title: 'Kürzere Registrierung',
        text: 'Die Registrierung fragt nur noch nach der E-Mail-Adresse; der Rest kommt später, in den ersten Schritten der App.',
        chapters: [],
      },
    ],
    later: { title: 'Der Filter merkt sich das letzte Team', text: 'Wieder geöffnet, zeigt ein Bericht das zuletzt gewählte Team.', chapters: [[0, 'Zurück im Bericht']] },
  },
};

const args = process.argv.slice(2);
const at = args.indexOf('--video');
const video = at >= 0 ? resolve(args[at + 1] ?? '') : undefined;
if (video && !existsSync(video)) fail(`no video at ${video}`);
const named = args.filter((a, i) => !a.startsWith('--') && (at < 0 || i !== at + 1));
const out = named[0] ? resolve(named[0]) : mkdtempSync(join(tmpdir(), 'obeya-theme-'));

function fail(why: string): never {
  console.error(`preview: ${why}`);
  process.exit(1);
}

const repo = process.cwd();
const theme = workingTheme(repo);
if (!theme) fail(`no ${THEME_DIR}/${THEME_FILE} in ${repo}: write the theme first`);
const settingsFile = join(repo, REPO_SETTINGS_FILE);
const own = existsSync(settingsFile) ? parseShared(readFileSync(settingsFile, 'utf8')).settings?.demo?.site : undefined;
const language: PageLanguage = demoSettingsHere().language === 'en' ? 'en' : 'de';
const site: DemoSite = {
  title: own?.title || `${basename(repo)} demos`,
  url: own?.url || 'https://demos.example',
  deploy: '',
  tags: own?.tags && Object.keys(own.tags).length ? own.tags : SAMPLE[language].tags,
};

const pages = sample(language, site);
for (const [dir, css] of [
  [out, theme.css],
  [join(out, 'without-theme'), undefined],
] as const) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), overviewHtml(site, pages, language, css));
  for (const p of pages) {
    mkdirSync(join(dir, p.slug));
    writeFileSync(join(dir, p.slug, 'index.html'), pageHtml(site, p, () => ({ poster: false, tracks: [] }), undefined, false, css));
    if (video) copyFileSync(video, join(dir, p.slug, 'demo.mp4'));
    writeFileSync(join(dir, p.slug, 'captions.vtt'), 'WEBVTT\n');
  }
}
const url = (path: string) => `file:///${path.replace(/\\/g, '/').replace(/^\/+/, '')}`;
console.log(
  [
    `With the theme (${THEME_DIR}/${THEME_FILE} as the checkout has it):`,
    `  overview: ${url(join(out, 'index.html'))}`,
    `  a page:   ${url(join(out, pages[0]!.slug, 'index.html'))}`,
    `  several versions on one page: ${url(join(out, pages[1]!.slug, 'index.html'))}`,
    `In Obeya's own look: ${url(join(out, 'without-theme', 'index.html'))}`,
    `Light and dark follow the browser's colour scheme (prefers-color-scheme).`,
  ].join('\n'),
);

/** The sample pages: one video with chapters, tags and a pull request; one with a later version below; one plain. */
function sample(language: PageLanguage, site: DemoSite): (Meta & { slug: string })[] {
  const w = SAMPLE[language];
  const [dimension, values = []] = Object.entries(site.tags ?? {})[0] ?? [];
  const tag = (i: number) => (dimension && values.length ? { tags: { [dimension]: [values[i % values.length]!] } } : {});
  const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
  const base = { pr: null, source: '', language, by: w.by };
  return [
    { slug: 'first', ...base, ...w.pages[0], ...tag(0), pr: `${site.url.replace(/\/+$/, '')}/pull/42`, first: day(1), at: day(1) },
    {
      slug: 'second',
      ...base,
      ...w.pages[1],
      ...tag(1),
      first: day(3),
      at: day(3),
      more: [{ ...w.later, dir: 'v2', handed: day(2), at: day(2), source: '' }],
    },
    { slug: 'third', ...base, ...w.pages[2], first: day(6), at: day(6) },
  ];
}
