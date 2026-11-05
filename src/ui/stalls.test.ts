import { expect, test } from 'bun:test';
import { beforeOf, browserOf, framesWithin, type LongFrame, scriptsOf, stallOf } from './stalls';

const script = (invoker: string, fn: string, duration: number) => ({ invoker, sourceURL: 'http://127.0.0.1:4417/_bun/client/index-a1b2.js?v=3', sourceFunctionName: fn, sourceCharPosition: 1204, duration });

test('a stall’s time goes to the scripts and the style and layout of the long frames within it, longest first', () => {
  const frames: LongFrame[] = [
    { startTime: 1000, duration: 900, styleAndLayoutStart: 1700, scripts: [script('WebSocket.onmessage', '', 600), script('MessagePort.onmessage', 'performWorkUntilDeadline', 100)] },
    { startTime: 1900, duration: 300, styleAndLayoutStart: 0, scripts: [script('MessagePort.onmessage', 'performWorkUntilDeadline', 250)] },
    // before the stall
    { startTime: 100, duration: 80, styleAndLayoutStart: 0, scripts: [script('DOMWindow.onclick', 'approve', 80)] },
  ];
  expect(scriptsOf(framesWithin(frames, 950, 2300))).toEqual([
    { what: 'WebSocket.onmessage: (anonymous) (index-a1b2.js@1204)', ms: 600 },
    { what: 'MessagePort.onmessage: performWorkUntilDeadline (index-a1b2.js@1204)', ms: 350 },
    { what: 'style and layout', ms: 200 },
  ]);
  // a part too short to matter is left out
  expect(scriptsOf([{ startTime: 0, duration: 600, styleAndLayoutStart: 590, scripts: [script('WebSocket.onmessage', 'x', 580)] }])).toEqual([{ what: 'WebSocket.onmessage: x (index-a1b2.js@1204)', ms: 580 }]);
  expect(framesWithin(frames, 5000, 6000)).toEqual([]);
});

test('what the page took in within the three seconds before a stall goes with it, and the message whose handling began it', () => {
  const noted = [
    { at: 1000, what: 'event' },
    { at: 9800, what: 'snapshot (412 KB)' },
    { at: 10_020, what: 'snapshot (2 MB, read in 900 ms)' },
    { at: 11_200, what: 'usage' },
  ];
  expect(beforeOf(noted, 10_000, 11_000)).toEqual(['snapshot (412 KB) 0.2 s before', 'snapshot (2 MB, read in 900 ms) 0.0 s before']);
});

test('a heartbeat the page takes in half a second late tells of a stall, and the beats queued behind it of none', () => {
  // taken in on time, as the beats of a page whose own timers the browser holds back
  expect(stallOf(20, 1020, 900)).toBeNull();
  expect(stallOf(490, 1490, 900)).toBeNull();
  // the thread was busy from the beat on
  expect(stallOf(800, 1800, 900)).toEqual({ from: 1000, to: 1800 });
  // the next beat waited behind the same stall
  expect(stallOf(700, 1800.1, 1800)).toBeNull();
  // and one that waited behind it and another after it tells of the other
  expect(stallOf(1500, 2600, 1800)).toEqual({ from: 1800, to: 2600 });
  // where the long frames tell the length, a beat a tick short of a stall may tell of one
  expect(stallOf(451, 1551, 1000, 400)).toEqual({ from: 1100, to: 1551 });
});

test('a stall names the browser the page ran in by its name and major version, and the Obeya app by its platform', () => {
  const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';
  expect(browserOf(`${mac} Version/26.1 Safari/605.1.15`)).toBe('Safari 26');
  expect(browserOf('Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1')).toBe('Safari 18');
  expect(browserOf(`${mac} Chrome/142.0.0.0 Safari/537.36`)).toBe('Chrome 142');
  expect(browserOf(`${mac} Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0`)).toBe('Edge 142');
  expect(browserOf('Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0')).toBe('Firefox 144');
  // the app's webview and another app's tell no browser
  expect(browserOf(mac, 'macos')).toBe('Obeya app on macOS');
  expect(browserOf(mac)).toBe('WebKit');
  expect(browserOf('curl/8')).toBe('an unknown browser');
});
