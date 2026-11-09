import { expect, test } from 'bun:test';
import { FAST_MS, quietText, RECENT_MS, tailnet, whyQuiet } from './reach';
import { setLanguage, t } from './strings';

const since = 1_000_000;
const now = since + 60_000;
const why = (o: Partial<Parameters<typeof whyQuiet>[0]>) => whyQuiet({ online: true, since, pushedAt: null, probe: null, now, ...o });

test('an address in a tailnet is a MagicDNS name or a Tailscale address', () => {
  expect(tailnet('pc.tail1234.ts.net')).toBe(true);
  expect(tailnet('100.101.102.103')).toBe(true);
  expect(tailnet('100.63.1.1')).toBe(false);
  expect(tailnet('192.168.1.20')).toBe(false);
  expect(tailnet('obeya.example.com')).toBe(false);
});

test('without network the phone says so, whatever else it saw', () => {
  expect(why({ online: false, probe: { failed: 10 }, pushedAt: now })).toBe('noNetwork');
});

test('the gateway answering with an error means the computer runs without Obeya', () => {
  expect(why({ probe: { status: 502 } })).toBe('noObeya');
  expect(why({ probe: { status: 502 }, pushedAt: now })).toBe('noObeya');
  // Obeya itself answered: the connection comes back by itself
  expect(why({ probe: { status: 404 } })).toBe(null);
});

test('a push since the page lost Obeya says Obeya runs and the way to it is down', () => {
  expect(why({ pushedAt: since + 1, probe: { slow: true } })).toBe('pushed');
  // one from before, as the push the owner tapped to open the app, while it is recent
  expect(why({ pushedAt: since - 1000 })).toBe('pushed');
  expect(why({ pushedAt: now - RECENT_MS - 1 })).toBe(null);
});

test('a request failing at once never left the phone; one hanging went where nobody answers', () => {
  expect(why({ probe: { failed: FAST_MS - 1 } })).toBe('unreachable');
  expect(why({ probe: { failed: FAST_MS + 1 } })).toBe('noAnswer');
  expect(why({ probe: { slow: true } })).toBe('noAnswer');
  expect(why({ probe: { slow: true }, pushedAt: since - 1000 })).toBe('pushed');
});

test('in a tailnet on Android the line names Tailscale and offers its app', () => {
  setLanguage('en', []);
  const w = t.phone.whyQuiet;
  const on = { tailnet: true, android: true, pushedAt: '14:07' };
  expect(quietText('unreachable', on)).toEqual({ lines: [w.unreachable, w.tailscaleOff, w.moved(true)], open: true, keepOn: true });
  expect(quietText('pushed', on).lines).toEqual([w.pushed('14:07'), w.tailscaleOff, w.pushesStill]);
  expect(quietText('noObeya', on)).toEqual({ lines: [w.noObeya], open: false, keepOn: false });
  expect(quietText('noAnswer', { ...on, android: false })).toEqual({ lines: [w.noAnswer, w.tailscaleToo], open: false, keepOn: false });
  // elsewhere nothing of Tailscale
  expect(quietText(null, { tailnet: false, android: true, pushedAt: null })).toEqual({ lines: [t.phone.notAnsweringWhy], open: false, keepOn: false });
});
