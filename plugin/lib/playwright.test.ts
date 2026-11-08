import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import type { Browser } from 'playwright-core';
import { chromium, webkit } from './playwright.mjs';

// Half a second of silence as a WAV: should the muting fail, the test still plays nothing audible.
function silentWav(): string {
  const samples = 4000;
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(8000, 24);
  buf.writeUInt32LE(16000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples * 2, 40);
  return `data:audio/wav;base64,${buf.toString('base64')}`;
}

const open: Browser[] = [];
afterAll(() => Promise.all(open.map((b) => b.close())), 30_000);

// WebKit has no switch that mutes it: its pages' media play muted, which WebKit's `:muted` shows
// whatever the page reads back from `muted`.
describe.skipIf(!existsSync(webkit.executablePath()))('WebKit through the plugin’s Playwright', () => {
  test('every way a page plays sound plays it muted, while the page reads back what it set', async () => {
    const browser = await webkit.launch();
    open.push(browser);
    const page = await browser.newPage();
    const wav = silentWav();
    await page.goto(`data:text/html,<audio id=parsed autoplay src="${wav}"></audio><iframe srcdoc="<p>frame</p>"></iframe>`);
    const seen = await page.evaluate(async (wav) => {
      const parsed = document.querySelector('audio')!;
      const made = new Audio(wav);
      made.muted = false;
      await made.play();
      const created = document.createElement('video');
      const controls = document.createElement('div');
      controls.innerHTML = `<audio controls src="${wav}"></audio>`;
      document.body.append(made, controls);
      await new Promise((r) => setTimeout(r, 300));
      const unmuted = document.createElement('audio');
      unmuted.muted = true;
      unmuted.muted = false;
      return {
        played: !made.paused,
        pageReads: [made.muted, unmuted.muted],
        muted: [parsed, made, created, controls.firstElementChild!, unmuted].map((el) => el.matches(':muted')),
      };
    }, wav);
    expect(seen).toEqual({ played: true, pageReads: [false, false], muted: [true, true, true, true, true] });
    // a frame of the page and a later document are silenced too
    expect(await page.frames()[1]!.evaluate(() => [!!(HTMLMediaElement.prototype as any).__silent, !!(speechSynthesis as any).__silent])).toEqual([true, true]);
    // WebKit hands out a fresh speechSynthesis once the page holds none: it stays silent
    expect(await page.evaluate(async () => {
      (globalThis as any).gc?.();
      await new Promise((r) => setTimeout(r, 1500));
      return !!(speechSynthesis as any).__silent && speechSynthesis.speak.toString().includes('SpeechSynthesisUtterance');
    })).toBe(true);
    await page.goto('data:text/html,<p>next</p>');
    expect(await page.evaluate(() => !!(HTMLMediaElement.prototype as any).__silent)).toBe(true);
  }, 60_000);
});

describe('Chromium through the plugin’s Playwright', () => {
  test('starts muted, and Web Audio reaches the speakers only through a gain of zero', async () => {
    const browser = await chromium.launch().catch(() => chromium.launch({ channel: 'chrome' }));
    open.push(browser);
    if (process.platform !== 'win32') {
      const cdp = await browser.newBrowserCDPSession();
      const { processInfo } = (await cdp.send('SystemInfo.getProcessInfo')) as { processInfo: { type: string; id: number }[] };
      const pid = processInfo.find((p) => p.type === 'browser')!.id;
      expect(Bun.spawnSync(['ps', '-o', 'args=', '-p', String(pid)]).stdout.toString()).toContain('--mute-audio');
    }
    const page = await browser.newPage();
    await page.goto('data:text/html,<p>audio</p>');
    // the page's audio graph as Chrome sees it, whatever the page's own objects say
    const session = await page.context().newCDPSession(page);
    const nodes = new Map<string, string>();
    const edges: [string, string][] = [];
    session.on('WebAudio.audioNodeCreated', ({ node }: any) => nodes.set(node.nodeId, node.nodeType));
    session.on('WebAudio.nodesConnected', ({ sourceId, destinationId }: any) => edges.push([sourceId, destinationId]));
    await session.send('WebAudio.enable');
    const page_ = await page.evaluate(async () => {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const chained = osc.connect(ctx.destination) === ctx.destination;
      osc.start();
      const at = ctx.currentTime;
      await new Promise((r) => setTimeout(r, 300));
      osc.disconnect(ctx.destination);
      osc.connect(ctx.destination);
      return { chained, running: ctx.state === 'running' && ctx.currentTime > at };
    });
    expect(page_).toEqual({ chained: true, running: true });
    const named = edges.map(([from, to]) => `${nodes.get(from)} → ${nodes.get(to)}`);
    expect(named).toContain('Oscillator → Gain');
    expect(named).toContain('Gain → AudioDestination');
    expect(named).not.toContain('Oscillator → AudioDestination');
  }, 60_000);
});
