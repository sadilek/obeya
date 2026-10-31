import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { launchChromium } from '../../../lib/chromium.ts';
import { paintTimes } from './director.ts';
import type { Frame } from './timeline.ts';

// The overlay in a real browser, on a page with iframes as a card's HTML artifact has them.
describe('the demo overlay', () => {
  let browser: Browser;
  let page: Page;
  let server: ReturnType<typeof Bun.serve>;

  // Chrome starts and closes slowly while the other test files run beside it.
  beforeAll(async () => {
    const html = (body: string) => new Response(`<!doctype html><body>${body}</body>`, { headers: { 'content-type': 'text/html' } });
    server = Bun.serve({
      port: 0,
      fetch: (req) =>
        new URL(req.url).pathname === '/frame'
          ? html('<p id="inside">inside</p>')
          : html('<p id="under">behind the sheet</p><div id="sheet" style="position:fixed;left:0;top:0;right:0;height:40px;background:#eee"></div><button id="b">Go</button><button id="edge" style="position:fixed;right:4px;top:2px">Send</button><iframe src="/frame"></iframe><iframe sandbox="allow-scripts" src="/frame"></iframe>'),
    });
    browser = await launchChromium();
    const ctx = await browser.newContext({ viewport: { width: 800, height: 600 } });
    await ctx.addInitScript({ path: path.join(import.meta.dirname, 'overlay.js') });
    page = await ctx.newPage();
    await page.goto(server.url.href);
    await page.frameLocator('iframe').first().locator('#inside').waitFor();
    await page.frameLocator('iframe').last().locator('#inside').waitFor();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    server?.stop();
  }, 30_000);

  test('paints its clock strip in the top page and in no iframe', async () => {
    await page.waitForFunction(() => document.querySelector('canvas')?.isConnected);
    expect(await page.evaluate(() => document.querySelectorAll('canvas').length)).toBe(1);
    const frames = page.frames().filter((f) => f !== page.mainFrame());
    expect(frames).toHaveLength(2);
    for (const f of frames) {
      expect(await f.evaluate(() => ({ canvases: document.querySelectorAll('canvas').length, demo: '__demo' in window }))).toEqual({
        canvases: 0,
        demo: false,
      });
    }
  });

  // Chrome's JPEGs are 4:2:0, which ffmpeg 6 cropped to even heights only: no frame read its time.
  test.skipIf(!Bun.which('ffmpeg'))('a frame as Chrome encodes it tells when it was painted', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clock-'));
    try {
      const file = path.join(dir, '000000.jpg');
      await page.screenshot({ path: file, type: 'jpeg', quality: 92 });
      const t = Date.now() / 1000;
      const [painted] = paintTimes([{ file, t, width: 800, height: 600 }], dir, { width: 800, height: 600 });
      expect(painted).not.toBeNull();
      expect(Math.abs(painted! - t)).toBeLessThan(5);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // A sharp take asks for two pixels per point; Chrome's screencast sent phone-sized frames at one
  // per point, read at the place of two, and every frame's clock was garbage.
  test.skipIf(!Bun.which('ffmpeg'))('a phone-sized frame tells when it was painted at one pixel per point and at two', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clock-'));
    const phone = { width: 393, height: 852 };
    try {
      const frames: Frame[] = [];
      for (const scale of [1, 2, 1]) {
        const ctx = await browser.newContext({ viewport: phone, deviceScaleFactor: scale });
        await ctx.addInitScript({ path: path.join(import.meta.dirname, 'overlay.js') });
        const shot = await ctx.newPage();
        await shot.goto(server.url.href);
        await shot.waitForFunction(() => document.querySelector('canvas')?.isConnected);
        const file = path.join(dir, `${String(frames.length).padStart(6, '0')}.jpg`);
        await shot.screenshot({ path: file, type: 'jpeg', quality: 92 });
        frames.push({ file, t: Date.now() / 1000, ...phone });
        await ctx.close();
      }
      const painted = paintTimes(frames, dir, phone);
      painted.forEach((p, i) => {
        expect(p).not.toBeNull();
        expect(Math.abs(p! - frames[i]!.t)).toBeLessThan(5);
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test('pointer, highlight and image stage still work in the top page', async () => {
    const button = await page.locator('#b').elementHandle();
    const shown = await page.evaluate((b) => {
      // biome-ignore lint: the overlay is untyped browser script
      const demo = (window as any).__demo;
      demo.moveTo(100, 100, true);
      demo.highlight([b], 'Here');
      demo.showImage('data:image/gif;base64,R0lGODlhAQABAAAAACw=', 0, 'An image');
      const text = document.documentElement.innerText;
      return { pointer: !!document.querySelector('svg path'), label: text.includes('Here'), caption: text.includes('An image'), image: !!document.querySelector('img') };
    }, button);
    expect(shown).toEqual({ pointer: true, label: true, caption: true, image: true });
  });

  test('tells an element hidden behind another part of the page from one that shows', async () => {
    const els = await Promise.all(['#under', '#b'].map((s) => page.locator(s).elementHandle()));
    // biome-ignore lint: the overlay is untyped browser script
    expect(await page.evaluate((e) => (window as any).__demo.hidden(e), els)).toEqual([true, false]);
  });

  test("a ring on what another ring of the scene has already is refused with that ring's label", async () => {
    const button = await page.locator('#b').elementHandle();
    const edge = await page.locator('#edge').elementHandle();
    const answers = await page.evaluate(
      ([b, e]) => {
        // biome-ignore lint: the overlay is untyped browser script
        const demo = (window as any).__demo;
        demo.clearHighlights();
        const first = demo.highlight([b], 'Interface');
        const again = demo.highlight([b], 'Conversation');
        // one element more is another ring
        const both = demo.highlight([b, e], 'Both');
        const rings = [...document.querySelectorAll('div')].filter((d) => ['Interface', 'Conversation', 'Both'].includes(d.textContent ?? '') && !d.children.length).map((d) => d.textContent);
        return { first, again, both, rings };
      },
      [button, edge] as const,
    );
    expect(answers).toEqual({ first: undefined, again: { same: 'Interface' }, both: undefined, rings: ['Interface', 'Both'] });
  });

  test('a label stays inside the window when its ring is at the edge', async () => {
    const button = await page.locator('#edge').elementHandle();
    const label = 'A label much longer than the button it belongs to';
    await page.evaluate(
      ([b, text]) => {
        // biome-ignore lint: the overlay is untyped browser script
        const demo = (window as any).__demo;
        demo.clearHighlights();
        demo.highlight([b], text);
      },
      [button, label] as const,
    );
    // the overlay places the label on the next frame
    await page.waitForTimeout(300);
    const tag = await page.evaluate((text) => {
      const el = [...document.querySelectorAll('div')].find((d) => d.textContent === text && !d.children.length);
      const r = el?.getBoundingClientRect();
      return r && { left: r.left, top: r.top, right: r.right, bottom: r.bottom, height: r.height };
    }, label);
    expect(tag).toBeTruthy();
    expect(tag!.left).toBeGreaterThanOrEqual(0);
    expect(tag!.right).toBeLessThanOrEqual(800);
    // the button sits at the top, so the label goes below it, on one line
    expect(tag!.top).toBeGreaterThanOrEqual(0);
    expect(tag!.height).toBeLessThan(40);
  });
});
