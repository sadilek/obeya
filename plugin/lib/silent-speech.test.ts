import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Browser, Page } from 'playwright-core';
import { launchChromium, SILENT_SPEECH } from './chromium.ts';

// The silent speechSynthesis in a real browser, as the demo's contexts load it.
describe('silent speech', () => {
  let browser: Browser;
  let page: Page;

  // Chrome starts slowly while the other test files run beside it.
  beforeAll(async () => {
    browser = await launchChromium();
    const ctx = await browser.newContext();
    await ctx.addInitScript({ path: SILENT_SPEECH });
    page = await ctx.newPage();
    // goto, not setContent: Playwright writes that content as a user gesture
    await page.goto(`data:text/html,${encodeURIComponent(`<button>go</button><script>
      window.say = (text, rate = 1) => {
        const u = new SpeechSynthesisUtterance(text);
        u.rate = rate;
        const at = performance.now();
        for (const type of ['start', 'pause', 'resume', 'end', 'error'])
          u.addEventListener(type, (e) => log.push([text, type, e.error ?? e.charIndex, Math.round((performance.now() - at) / 10) * 10]));
        speechSynthesis.speak(u);
      };
      window.log = [];
      window.settled = () => new Promise((resolve) => { const check = () => speechSynthesis.speaking || speechSynthesis.pending ? setTimeout(check, 10) : resolve(log.splice(0)); setTimeout(check, 10); });
      say('Lena');
    </script>`)}`);
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  const events = async (script: string) => {
    await page.evaluate(script);
    return (await page.evaluate('settled()')) as [string, string, string | number, number][];
  };

  test('a page the user has not touched yet may not speak, as in Chrome', async () => {
    expect((await page.evaluate('settled()')) as unknown[]).toEqual([['Lena', 'error', 'not-allowed', expect.any(Number)]]);
  });

  test('after a click, utterances take turns and end after about as long as saying them takes', async () => {
    await page.click('button');
    const log = await events(`say('Lena'); say('Hallo Welt', 2)`);
    expect(log.map(([text, type, detail]) => [text, type, detail])).toEqual([
      ['Lena', 'start', 0],
      ['Lena', 'end', 4],
      ['Hallo Welt', 'start', 0],
      ['Hallo Welt', 'end', 10],
    ]);
    // 70 ms a character at rate 1: "Lena" ends after 280 ms, "Hallo Welt" at rate 2 after 350 ms
    const [, lenaEnd, , halloEnd] = log.map(([, , , ms]) => ms);
    expect(lenaEnd).toBeGreaterThanOrEqual(270);
    expect(lenaEnd).toBeLessThan(600);
    expect(halloEnd).toBeGreaterThanOrEqual(270 + 340);
  });

  test('pause holds the utterance and resume goes on with it; cancel ends them all', async () => {
    const paused = await events(`say('Lena'); setTimeout(() => speechSynthesis.pause(), 50); setTimeout(() => speechSynthesis.resume(), 450)`);
    expect(paused.map(([, type]) => type)).toEqual(['start', 'pause', 'resume', 'end']);
    // "Lena" takes its 280 ms of speaking, the pause not counted, however late a busy machine ran
    // the timers that paused and resumed it (each time rounded to 10 ms)
    const [start, pause, resume, end] = paused.map(([, , , ms]) => ms);
    expect(end! - start! - (resume! - pause!)).toBeGreaterThanOrEqual(260);

    const canceled = await events(`say('eins'); say('zwei'); setTimeout(() => speechSynthesis.cancel(), 50)`);
    expect(canceled.map(([text, type, detail]) => [text, type, detail])).toEqual([
      ['eins', 'start', 0],
      ['eins', 'error', 'interrupted'],
      ['zwei', 'error', 'canceled'],
    ]);
  });

  test('a start handler may pause or cancel, and an utterance from an iframe speaks too', async () => {
    const paused = await events(`(() => {
      const u = new SpeechSynthesisUtterance('Lena');
      for (const type of ['start', 'pause', 'resume', 'end']) u.addEventListener(type, () => log.push(['Lena', type, 0, 0]));
      u.onstart = () => { speechSynthesis.pause(); setTimeout(() => speechSynthesis.resume(), 500); };
      speechSynthesis.speak(u);
    })()`);
    expect(paused.map(([, type]) => type)).toEqual(['start', 'pause', 'resume', 'end']);
    const handled = await events(`(() => {
      const u = new SpeechSynthesisUtterance('eins');
      u.onstart = () => speechSynthesis.cancel();
      u.onerror = (e) => log.push(['eins', 'error', e.error, 0]);
      u.onend = () => log.push(['eins', 'end', 0, 0]);
      speechSynthesis.speak(u);
    })()`);
    expect(handled.map(([, type, detail]) => [type, detail])).toEqual([['error', 'interrupted']]);
    const fromFrame = await events(`(() => {
      const frame = document.body.appendChild(document.createElement('iframe'));
      const u = new frame.contentWindow.SpeechSynthesisUtterance('drei');
      u.onend = () => log.push(['drei', 'end', 0, 0]);
      speechSynthesis.speak(u);
    })()`);
    expect(fromFrame.map(([text, type]) => [text, type])).toEqual([['drei', 'end']]);
  });
});
