import { expect, test } from 'bun:test';
import { FAST_MS, quietText, RECENT_MS, tailnet, whyQuiet } from './reach';
import { setLanguage, t } from './strings';

const now = 1_000_000_000;
const why = (o: Partial<Parameters<typeof whyQuiet>[0]>) => whyQuiet({ online: true, pushedAt: null, probe: null, now, ...o });

test('until Obeya says so, an address looks like one in a tailnet by its MagicDNS name or a Tailscale address', () => {
  expect(tailnet('pc.tail1234.ts.net')).toBe(true);
  expect(tailnet('100.101.102.103')).toBe(true);
  expect(tailnet('[fd7a:115c:a1e0::1]')).toBe(true);
  expect(tailnet('100.63.1.1')).toBe(false);
  expect(tailnet('192.168.1.20')).toBe(false);
  expect(tailnet('[fd00::1]')).toBe(false);
  expect(tailnet('obeya.example.com')).toBe(false);
});

test('without network the phone says so, whatever else it saw', () => {
  expect(why({ online: false, probe: { failed: 10 }, pushedAt: now })).toBe('noNetwork');
});

test('an answer from the address: a gateway error means the computer runs without Obeya, any other that Obeya answers', () => {
  expect(why({ probe: { status: 502 } })).toBe('noObeya');
  expect(why({ probe: { status: 502 }, pushedAt: now })).toBe('noObeya');
  expect(why({ probe: { status: 404 } })).toBe('answers');
  // Obeya answering outweighs a push: the way to it is there
  expect(why({ probe: { status: 404 }, pushedAt: now - 1000 })).toBe('answers');
});

test('a push sent a moment ago says Obeya was running; an older one says nothing about now', () => {
  expect(why({ pushedAt: now - 1000, probe: { slow: true } })).toBe('pushed');
  expect(why({ pushedAt: now - 1000, probe: { failed: 10 } })).toBe('pushed');
  expect(why({ pushedAt: now - RECENT_MS - 1, probe: { slow: true } })).toBe('noAnswer');
  expect(why({ pushedAt: now - RECENT_MS - 1 })).toBe(null);
});

test('a request failing at once got no answer from Obeya; one hanging went where nobody answers', () => {
  expect(why({ probe: { failed: FAST_MS - 1 } })).toBe('unreachable');
  expect(why({ probe: { failed: FAST_MS + 1 } })).toBe('noAnswer');
  expect(why({ probe: { slow: true } })).toBe('noAnswer');
});

test('through Tailscale the line names it; Android, its app and how to keep it on come only on Android', () => {
  setLanguage('en', []);
  const w = t.phone.whyQuiet;
  const android = { tailnet: true, android: true, pushedAt: '14:07' };
  const iphone = { ...android, android: false };
  expect(quietText('unreachable', android)).toEqual({ line: w.unreachableTailscale, more: [w.moved, w.android], open: true });
  expect(quietText('pushed', android)).toEqual({ line: w.pushedTailscale('14:07'), more: [w.pushesStill, w.moved, w.android], open: true });
  expect(quietText('pushed', iphone)).toEqual({ line: w.pushedTailscale('14:07'), more: [w.pushesStill, w.moved], open: false });
  expect(quietText('noAnswer', iphone)).toEqual({ line: w.noAnswerTailscale, more: [w.moved], open: false });
  expect(quietText('noObeya', android)).toEqual({ line: w.noObeya, more: [], open: false });
  expect(quietText('answers', android)).toEqual({ line: w.answers, more: [], open: false });
  // no text says Android outside the part only Android gets
  for (const s of [w.tailnet, w.unreachableTailscale, w.noAnswerTailscale, w.pushedTailscale('14:07'), w.pushesStill, w.moved]) expect(s).not.toContain('Android');
});

test('elsewhere the line names no Tailscale, and a quick failure may be Obeya stopped', () => {
  setLanguage('en', []);
  const w = t.phone.whyQuiet;
  const lan = { tailnet: false, android: true, pushedAt: '14:07' };
  expect(quietText(null, lan)).toEqual({ line: t.phone.notAnsweringWhy, more: [], open: false });
  expect(quietText('unreachable', lan)).toEqual({ line: w.unreachable, more: [w.moved], open: false });
  expect(quietText('pushed', lan)).toEqual({ line: w.pushed('14:07'), more: [w.moved], open: false });
  for (const s of [w.unreachable, w.pushed('14:07'), w.noAnswer, t.phone.notAnsweringWhy]) expect(s).not.toContain('Tailscale');
  expect(w.unreachable).toContain('Obeya is not running');
  expect(w.unreachableTailscale).toContain('Obeya is not running');
});
