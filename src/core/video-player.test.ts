import { expect, test } from 'bun:test';
import { demoPageHtml, sitePlayerScript, stackedPageHtml } from '../server/demo-page';
import { PLAYER_ICONS, PLAYER_KEYS } from './video-player';

/** The scripts of a page that run (not those holding captions or a video's bytes). */
const scripts = (html: string) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);

test('a shared page carries the player as source that parses, for a page alone and one with several versions', () => {
  const page = demoPageHtml({
    title: 'CSV export',
    text: '',
    chapters: [[0, 'Before'], [12.5, 'After „quoted“ </script>']],
    pr: null,
    when: '',
    tabTitle: '',
    language: 'en',
    video: { src: 'demo.mp4' },
    tracks: [{ language: 'en', src: 'captions.en.vtt' }],
  });
  const stacked = stackedPageHtml({
    when: '',
    tabTitle: '',
    language: 'en',
    pr: null,
    demos: [
      { kind: 'video', title: 'One', text: '', base: 'v1/', chapters: [[0, 'Start']], poster: true, tracks: [] },
      { kind: 'video', title: 'Two', text: '', base: 'v2/', chapters: [], poster: false, tracks: [], silent: true, at: '2026-11-08T10:00:00Z' },
    ],
  });
  for (const html of [page, stacked]) {
    const run = scripts(html);
    expect(run.some((s) => s.includes('figure.dp'))).toBe(true);
    // a chapter title cannot end the script, and every script is valid JavaScript
    for (const s of run) expect(() => new Function(s)).not.toThrow();
  }
  expect(page).toContain('<figure class="dp" data-chapters="[[0,&quot;Before&quot;],[12.5,&quot;After „quoted“ &lt;/script&gt;&quot;]]">');
});

test('a shared page hands its player the keys the walkthroughs read, and the icons they draw', () => {
  // a page has only the player's source, so `lib` carries them as data
  expect(sitePlayerScript()).toContain(`keys: ${JSON.stringify(PLAYER_KEYS)}, icons: ${JSON.stringify(PLAYER_ICONS)}`);
});

test("obeya.si's script of the player parses and defines obeyaPlayer, with its keys bound to the player", () => {
  const script = sitePlayerScript();
  const window: { obeyaPlayer?: unknown } = {};
  new Function('window', script)(window);
  expect(typeof window.obeyaPlayer).toBe('function');
  expect(script).toContain("keys: 'within'");
  // every helper the player takes from `lib`, as the shared pages pass them
  for (const helper of ['captionPages', 'pageOf', 'cueWords', 'spokenWord', 'preferredTrack']) expect(script).toContain(`${helper}: `);
});
