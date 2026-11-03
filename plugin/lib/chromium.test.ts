import { afterAll, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import type { Browser } from 'playwright-core';
import { CLOSE_GRACE_MS, launchChromium } from './chromium.ts';

let browser: Browser | undefined;
afterAll(() => browser?.close());

// A box that scrolls shows its scrollbar in a screenshot: classic on Windows and Linux, on a Mac
// with overlay scrollbars while it scrolls (hence the wheel just before).
test('a scrolling box shows its scrollbar', async () => {
  browser = await launchChromium();
  const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
  await page.setContent('<body style="margin:0"><div style="height:200px;width:200px;overflow:auto;background:#fff"><div style="height:2000px"></div></div>');
  await page.mouse.move(100, 100);
  await page.mouse.wheel(0, 200);
  await page.waitForTimeout(150);
  // the box's right edge, where the scrollbar stands, rendered and read back as pixels
  const shot = await page.screenshot({ clip: { x: 180, y: 10, width: 20, height: 180 } });
  const dark = await page.evaluate(async (png) => {
    const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
    const ctx = new OffscreenCanvas(img.width, img.height).getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, img.width, img.height);
    let n = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i]! < 200) n++;
    return n;
  }, shot.toString('base64'));
  expect(dark).toBeGreaterThan(50);
}, 60_000);

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// a frozen browser stands in for one whose orderly shutdown hangs, as on a busy machine
test.skipIf(process.platform === 'win32')('a browser that does not close in time is killed, its profile with it', async () => {
  const frozen = await launchChromium();
  const cdp = await frozen.newBrowserCDPSession();
  const { processInfo } = (await cdp.send('SystemInfo.getProcessInfo')) as { processInfo: { type: string; id: number }[] };
  await cdp.detach();
  const pid = processInfo.find((p) => p.type === 'browser')!.id;
  const ps = Bun.spawnSync(['ps', '-o', 'args=', '-p', String(pid)]).stdout.toString();
  const profile = ps.match(/--user-data-dir=(\S+)/)![1]!;
  expect(existsSync(profile)).toBe(true);
  process.kill(pid, 'SIGSTOP');
  const start = performance.now();
  await frozen.close();
  expect(performance.now() - start).toBeLessThan(CLOSE_GRACE_MS + 2000);
  expect(alive(pid)).toBe(false);
  expect(existsSync(profile)).toBe(false);
}, 30_000);
