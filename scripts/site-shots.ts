// The screenshots on obeya.si (`site/img/`), taken again from a scratch Obeya in English: the Tipjar
// app of the hero video as the repository, cards in the states the page talks about, and a demo of
// a Tipjar change on the card whose demo the page shows, so that the picture is of a demo and not of
// Obeya itself. The same wall on a phone (`phone.png`, `phone-demo.png`) shows the phone view.
//
//   bun scripts/site-shots.ts [--demo <dir>] [--at <seconds>] [--review-demo <dir>] [--keep | --stage-only]
//
// --demo names a Tipjar demo to put on that card (a directory with demo.mp4 and poster.jpg); without
// it the agent's first demo of splitting the bill from the newest render of the hero video is taken
// (tipjar-split-the-bill* in the demo directory; the render leaves a second, shorter one on the owner's comments a
// few minutes later); its chapters come from its chapters.vtt. --at names the moment of the demo the
// pictures show, where the one picked by its chapters shows the change badly. The scratch Obeya runs on port 4740 and is stopped
// at the end; --keep leaves it running for a look, --stage-only stages it and takes nothing.
//
// The review card (`review.png`) is a contributor's pull request on Tipjar, on a canvas of its own
// on port 4741 so that it stays out of the other pictures: its findings, its demo and the text for
// the PR, with one finding left for the owner to choose. Its demo is the render's of a comma as the
// decimal point, the hero video's comment on the first demo (the newest tipjar-*comma* in the demo
// directory, else the newest tipjar-split-the-bill*), or the one --review-demo names. Needs Google
// Chrome.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright-core';
import { demoDirectory } from '../plugin/skills/demo/lib/settings.ts';
import { ownerHeaders } from '../src/server/owner';
import { scratchDir } from './common';
import { writeStage } from './hero-video/stage';

const PORT = 4740;
const REVIEW_PORT = 4741;
const ROOT = join(import.meta.dirname, '..');
const IMG = join(ROOT, 'site', 'img');
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};

/** The demos in the demo directory whose names `match`, newest first. */
function demosOf(match: (name: string) => boolean): string[] {
  const demos = demoDirectory();
  return existsSync(demos)
    ? readdirSync(demos)
        .filter((n) => match(n) && existsSync(join(demos, n, 'demo.mp4')) && existsSync(join(demos, n, 'chapters.vtt')))
        .map((n) => join(demos, n))
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    : [];
}

function newestDemo(): string {
  const found = demosOf((n) => n.startsWith('tipjar-split-the-bill'));
  if (!found[0]) throw new Error(`No Tipjar demo found in ${demoDirectory()}: render the hero video first, or name one with --demo.`);
  // the newest render's demos lie within minutes of each other; the first of them shows the whole change
  const newest = statSync(found[0]).mtimeMs;
  return found.filter((d) => newest - statSync(d).mtimeMs < 10 * 60_000).at(-1)!;
}
const demo = arg('--demo') ?? newestDemo();
// the render's demo of the owner's comment, a comma as the decimal point, under whatever name its agent gave it
const reviewDemo = arg('--review-demo') ?? demosOf((n) => n.startsWith('tipjar-') && n.includes('comma'))[0] ?? demosOf((n) => n.startsWith('tipjar-split-the-bill'))[0]!;

/** The demo's chapters from its `chapters.vtt`, as the card has them: [start in seconds, title]. */
function chaptersOf(dir: string): [number, string][] {
  const seconds = (t: string) => t.split(':').reduce((s, part) => s * 60 + Number(part), 0);
  return [...readFileSync(join(dir, 'chapters.vtt'), 'utf8').matchAll(/^([\d:.]+) --> [\d:.]+\n(.+)$/gm)].map((m) => [Math.round(seconds(m[1]!) * 10) / 10, m[2]!.trim()]);
}
const chapters = chaptersOf(demo);
const reviewChapters = chaptersOf(reviewDemo);

// the hero video's repository and plan doc, with cards of our own
const dir = mkdtempSync(join(tmpdir(), 'site-shots-'));
const stageFile = join(dir, 'stage.json');
writeStage(stageFile);
const stage = JSON.parse(readFileSync(stageFile, 'utf8'));
stage.port = PORT;
stage.dir = scratchDir(PORT);
stage.cards = [
  { key: 'P', project: 'docs/plan/tipjar-2.md', x: 40, y: 100 },
  { key: 'W2', workstream: 'W2', state: 'working', statusLine: 'Reading the receipt photo', branch: 'obeya/scan-receipt' },
  { key: 'W3', workstream: 'W3', queue: { behind: ['W2'], reason: 'The link shares the bill that W2 fills in from the receipt.' } },
  { key: 'S', title: 'Split the bill', body: 'Tipjar shows what each person at the table pays.', state: 'waiting', need: 'demo', x: 780, y: 100,
    branch: 'obeya/split-the-bill',
    events: [
      { kind: 'state', author: 'obeya', text: 'Agent started on obeya/split-the-bill.', ago: '25m' },
      { kind: 'review', author: 'worker', text: 'Below the tip there is a People field now, and the result says what each person pays, rounded up to the cent so the shares always cover the bill.', ago: '3m' },
    ],
    summary: 'Below the tip there is a People field now, and the result says what each person pays, rounded up to the cent so the shares always cover the bill.',
    demo: { dir: demo, chapters } },
  { key: 'C', title: 'Run the tests on every push', body: 'A GitHub Actions workflow runs bun test on every push.', state: 'working', statusLine: 'Writing the workflow', branch: 'obeya/ci', x: 1100, y: 100 },
  { key: 'I', title: 'App icon', body: 'An icon for the home screen.', state: 'waiting', need: 'question', x: 780, y: 260,
    branch: 'obeya/app-icon',
    events: [{ kind: 'state', author: 'obeya', text: 'Agent started on obeya/app-icon.', ago: '12m' }],
    question: { text: 'Which of the three drafts should become the icon?', options: ['The jar', 'The coin', 'The receipt'] } },
  { key: 'R', title: 'Round to whole dollars', body: 'A switch rounds each share up to the dollar.', state: 'approved', branch: 'obeya/round-up', x: 1100, y: 260 },
  { key: 'D', title: 'Dark mode', body: 'Tipjar follows the system’s dark mode.', state: 'live', createdAgo: '1d', x: 780, y: 420 },
  { key: 'T', title: 'Settle up after a trip', body: 'Several bills over a weekend, several people: who owes whom at the end.', state: 'idea', x: 1100, y: 420,
    row: { idea: { status: 'open', brief: 'Settle a whole trip, not one bill.', thinking: false, yourTurn: true, questions: [], next: { step: 'planDoc', why: 'Several parts that build on each other.' }, variants: [], mocks: [] } } },
];
stage.groups = [];
writeFileSync(stageFile, JSON.stringify(stage, null, 1));

// the review card on a canvas of its own: a contributor's PR, reviewed, two findings changed by the
// agent and held for the approval with the text for the PR, one left for the owner to choose
const reviewFile = join(dir, 'review.json');
const fix = 'Accept a comma as the decimal point';
const pull = 'https://github.com/tipjar-app/tipjar/pull/14';
const handover = 'Lena’s change works: 84,50 now gives the same tip as 84.50. I changed findings 1 and 3 myself; finding 2 is yours to decide.';
const review = {
  ...stage,
  port: REVIEW_PORT,
  dir: scratchDir(REVIEW_PORT),
  plans: {},
  groups: [],
  preferences: [],
  forgeRepo: 'tipjar-app/tipjar',
  pulls: [{ number: 14, title: fix, author: 'lena-k', canModify: true, files: { 'calc.js': `${stage.files['calc.js']}\n// a comma as the decimal point\n` }, checks: [{ name: 'CI', state: 'success' }] }],
  cards: [
    { key: 'R', title: fix, body: 'Review PR #14', state: 'waiting', need: 'demo', x: 200, y: 200, branch: 'obeya/review-pr-14', workspace: true,
      branchFiles: { 'calc.js': `${stage.files['calc.js']}\n// the bill read without a package\n` },
      summary: handover,
      events: [
        { kind: 'review', author: 'worker', text: 'The comma works, and the checks are green. Before anything of it ran I read the diff: it adds the package number-parse, which runs a postinstall script. Three findings.', ago: '20m' },
        { kind: 'talk', author: 'owner', text: 'Change 1 and 3 yourself.', ago: '15m' },
        { kind: 'review', author: 'worker', text: handover, ago: '2m' },
      ],
      row: {
        pr: { url: pull, number: 14, checks: [{ name: 'CI', state: 'success' }], conflict: false, seen: [], reported: [] },
        contribution: { url: pull, number: 14, author: 'lena-k', title: fix, canModify: true, headRepo: 'https://github.com/lena-k/tipjar.git', headRef: 'comma',
          results: { checks: [{ name: 'bun test', passed: true }], mergeable: true },
          held: { commits: 2, asks: [], base: '0000000',
            body: 'Thanks, Lena! Two changes on top of yours: calc.js reads the bill now, without the number-parse package, and calc.test.js covers bills with a comma.' },
          findings: [
            { id: 1, security: true, title: 'A new package for eight lines', text: 'The PR adds number-parse, which runs a postinstall script, to read the bill. calc.js does the same in eight lines.', status: 'fixed' },
            { id: 2, title: 'A space as the thousands mark reads as zero', text: '1 234,50, as French bills write it, still gives $0.00.', status: 'open' },
            { id: 3, title: 'No test for the comma', text: 'calc.test.js covers bills with a dot only.', status: 'fixed' },
          ] } },
      demo: { dir: reviewDemo, chapters: reviewChapters } },
  ],
};
writeFileSync(reviewFile, JSON.stringify(review, null, 1));

const scratch = (file: string) => JSON.parse(execFileSync('bun', [join(ROOT, 'scripts', 'scratch-obeya.ts'), file], { encoding: 'utf8' }).trim().split('\n').at(-1)!);
const staged = scratch(stageFile);
const reviewing = scratch(reviewFile);
const base = `http://127.0.0.1:${PORT}`;
for (const [at, home] of [[base, staged.dir], [`http://127.0.0.1:${REVIEW_PORT}`, reviewing.dir]])
  await fetch(`${at}/api/language`, { method: 'PUT', headers: ownerHeaders(join(home, 'home')), body: JSON.stringify({ language: 'en' }) });
console.log('staged', staged.url, reviewing.url);

// the Koordinator reads the new project's plan doc for what builds on what and arranges it: until
// then its head says "Arranging …", which a shot taken at once showed
const settled = Date.now() + 3 * 60_000;
while (Date.now() < settled) {
  const snap = (await (await fetch(`${base}/api/c/tipjar/canvas`, { headers: ownerHeaders(join(staged.dir, 'home')) })).json()) as { items: { kind: string; arranging?: true }[] };
  if (!snap.items.some((i) => i.kind === 'project' && i.arranging)) break;
  await new Promise((r) => setTimeout(r, 1000));
}

if (process.argv.includes('--stage-only')) process.exit(0);

// a fake microphone, so that holding Space lights it as it does for the owner
const browser = await chromium.launch({ channel: 'chrome', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 813 }, deviceScaleFactor: 1 });
  await page.context().grantPermissions(['microphone'], { origin: base });
  await page.goto(staged.url);
  await page.locator('.card').first().waitFor();
  await page.waitForTimeout(1000);
  // the phone first: the voice shot's held Space sends what the fake microphone hears to App icon's agent, and the card no longer waits
  await phoneShots(staged.url);
  await shots(page, staged.cards as Record<string, string>);
  await reviewShot(reviewing.url, reviewing.cards.R);
} finally {
  await browser.close();
  if (!process.argv.includes('--keep')) for (const port of [PORT, REVIEW_PORT]) execFileSync('bun', [join(ROOT, 'scripts', 'scratch-obeya.ts'), '--stop', String(port)]);
}

type Box = { x: number; y: number; width: number; height: number };
function around(boxes: Box[], pad: number, padX = pad): Box {
  const x = Math.min(...boxes.map((b) => b.x)) - padX, y = Math.min(...boxes.map((b) => b.y)) - pad;
  const r = Math.max(...boxes.map((b) => b.x + b.width)) + padX, b = Math.max(...boxes.map((b) => b.y + b.height)) + pad;
  return { x: Math.round(x), y: Math.round(y), width: Math.round(r - x), height: Math.round(b - y) };
}
async function boxOf(page: Page, selector: string) {
  return (await page.locator(selector).first().boundingBox())!;
}
function card(id: string | undefined) {
  if (!id) throw new Error('a card the stage names was not staged');
  return `[data-id="${id}"]`;
}

/** Pauses the demo video at `--at`, else in its second chapter (the change at work). */
async function still(page: Page, video: string) {
  await page.locator(video).evaluate(async (v: HTMLVideoElement, at: number) => {
    v.pause();
    v.currentTime = at;
    await new Promise((r) => v.addEventListener('seeked', r, { once: true }));
  }, arg('--at') ? Number(arg('--at')) : chapters[1] ? chapters[1][0] + ((chapters[2]?.[0] ?? chapters[1][0] + 4) - chapters[1][0]) * 0.8 : 3);
}

async function shots(page: Page, cards: Record<string, string>) {
  // the whole canvas, for the link preview (og:image)
  await page.screenshot({ path: join(IMG, 'canvas.png') });
  console.log('canvas.png');

  // taller, so that the minimap and the microphone stay below the cards
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  await page.locator('.card').first().waitFor();
  await page.waitForTimeout(1000);

  // the cards in their states
  const all = await Promise.all((await page.locator('.card, .project').all()).map((l) => l.boundingBox()));
  await page.screenshot({ path: join(IMG, 'cards.png'), clip: around(all.filter((b): b is Box => !!b && b.y > 60), 20) });
  console.log('cards.png');

  // the order: the pointer on a queued workstream shows what it waits for
  await page.hover(card(cards.W3));
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(IMG, 'order.png'), clip: around([await boxOf(page, '.project')], 24) });
  await page.mouse.move(5, 500);
  console.log('order.png');

  // a demo to approve: the card unfolded, its video paused in its second chapter (the change at work), tall enough for all its chapters
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.click(card(cards.S));
  await page.locator('#panel video').waitFor();
  await page.waitForTimeout(1500);
  await still(page, '#panel video');
  await page.hover('#panel video');
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(IMG, 'demo.png'), clip: around([await boxOf(page, '#panel')], 0) });
  console.log('demo.png');
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.waitForTimeout(1200);

  // voice: an agent's question, answered by holding Space
  await page.click(card(cards.I));
  await page.waitForTimeout(1500);
  await page.mouse.move(5, 500);
  await page.keyboard.down('Space');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(IMG, 'voice.png'), clip: around([await boxOf(page, '#panel'), (await page.locator('.ptt-row').locator('..').boundingBox())!], 24, 150) });
  await page.keyboard.up('Space');
  console.log('voice.png');
}

// the phone view, at an iPhone's size: what waits for the owner, and the demo opened from there
async function phoneShots(url: string) {
  const phone = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  // granted, so the offer to turn notifications on stays off the list
  await phone.grantPermissions(['notifications'], { origin: base });
  const page = await phone.newPage();
  await page.goto(url);
  await page.locator('.ph-card').first().waitFor();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(IMG, 'phone.png') });
  console.log('phone.png');

  await page.locator('.ph-card', { hasText: 'Split the bill' }).tap();
  await page.locator('#ph-card video').waitFor();
  await page.waitForTimeout(1500);
  await still(page, '#ph-card video');
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(IMG, 'phone-demo.png') });
  console.log('phone-demo.png');
  await phone.close();
}

// a contributor's pull request reviewed: the findings, the demo of the change and the text for the PR,
// tall enough for all of them, with the owner's choice for the finding left open
async function reviewShot(url: string, id: string) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1640 }, deviceScaleFactor: 1 });
  await page.goto(url);
  await page.locator('.card').first().waitFor();
  await page.waitForTimeout(1000);
  await page.click(card(id));
  await page.locator('#panel video').waitFor();
  await page.waitForTimeout(1500);
  // the change at work, without pausing it: a pause would start a comment on that moment
  await page.locator('#panel video').evaluate(async (v: HTMLVideoElement, at: number) => {
    v.currentTime = at;
    await new Promise((r) => v.addEventListener('seeked', r, { once: true }));
  }, reviewChapters[1] ? reviewChapters[1][0] + ((reviewChapters[2]?.[0] ?? reviewChapters[1][0] + 4) - reviewChapters[1][0]) * 0.6 : 3);
  await page.getByRole('button', { name: 'As a follow-up task' }).first().click();
  await page.mouse.move(5, 5);
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(IMG, 'review.png'), clip: around([await boxOf(page, '#panel')], 0) });
  console.log('review.png');
  await page.close();
}
