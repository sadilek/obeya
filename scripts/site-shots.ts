// The screenshots on obeya.si (`site/img/`), taken again from a scratch Obeya in English: the Tipjar
// app of the hero video as the repository, cards in the states the page talks about, and a demo of
// a Tipjar change on the card whose demo the page shows, so that the picture is of a demo and not of
// Obeya itself. The same wall on a phone (`phone.png`, `phone-demo.png`) shows the phone view.
//
//   bun scripts/site-shots.ts [--demo <dir>] [--at <seconds>] [--keep | --stage-only]
//
// --demo names a Tipjar demo to put on that card (a directory with demo.mp4 and poster.jpg); without
// it the agent's first demo of splitting the bill from the newest render of the hero video is taken
// (tipjar-split-the-bill* in the demo directory; the render leaves a second, shorter one on the owner's comments a
// few minutes later); its chapters come from its chapters.vtt. --at names the moment of the demo the
// pictures show, where the one picked by its chapters shows the change badly. The scratch Obeya runs on port 4740 and is stopped
// at the end; --keep leaves it running for a look, --stage-only stages it and takes nothing. Needs
// Google Chrome.

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
const ROOT = join(import.meta.dirname, '..');
const IMG = join(ROOT, 'site', 'img');
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};

function newestDemo(): string {
  const demos = demoDirectory();
  const found = existsSync(demos)
    ? readdirSync(demos)
        .filter((n) => n.startsWith('tipjar-split-the-bill') && existsSync(join(demos, n, 'demo.mp4')))
        .map((n) => join(demos, n))
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    : [];
  if (!found[0]) throw new Error(`No Tipjar demo found in ${demos}: render the hero video first, or name one with --demo.`);
  // the newest render's demos lie within minutes of each other; the first of them shows the whole change
  const newest = statSync(found[0]).mtimeMs;
  return found.filter((d) => newest - statSync(d).mtimeMs < 10 * 60_000).at(-1)!;
}
const demo = arg('--demo') ?? newestDemo();

/** The demo's chapters from its `chapters.vtt`, as the card has them: [start in seconds, title]. */
function chaptersOf(dir: string): [number, string][] {
  const seconds = (t: string) => t.split(':').reduce((s, part) => s * 60 + Number(part), 0);
  return [...readFileSync(join(dir, 'chapters.vtt'), 'utf8').matchAll(/^([\d:.]+) --> [\d:.]+\n(.+)$/gm)].map((m) => [Math.round(seconds(m[1]!) * 10) / 10, m[2]!.trim()]);
}
const chapters = chaptersOf(demo);

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

const staged = JSON.parse(execFileSync('bun', [join(ROOT, 'scripts', 'scratch-obeya.ts'), stageFile], { encoding: 'utf8' }).trim().split('\n').at(-1)!);
const base = `http://127.0.0.1:${PORT}`;
await fetch(`${base}/api/language`, { method: 'PUT', headers: ownerHeaders(join(staged.dir, 'home')), body: JSON.stringify({ language: 'en' }) });
console.log('staged', staged.url);

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
} finally {
  await browser.close();
  if (!process.argv.includes('--keep')) execFileSync('bun', [join(ROOT, 'scripts', 'scratch-obeya.ts'), '--stop', String(PORT)]);
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
