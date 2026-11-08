import { expect, test } from 'bun:test';
import { demoPageHtml, stackedPageHtml } from '../server/demo-page';
import { CAPTIONS_CHANGED, CAPTIONS_KEY_KNOWN, CAPTIONS_OFF, SEEK_KEYS_KNOWN, videoPlayer } from './video-player';

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
    video: { src: 'demo.mp4' },
    tracks: [{ language: 'en', src: 'captions.en.vtt' }],
  });
  const stacked = stackedPageHtml({
    when: '',
    tabTitle: '',
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

test('the player keeps the browser settings under the keys the walkthroughs read', () => {
  // the function carries its own copy of each, since a page has only its source
  const source = videoPlayer.toString();
  for (const key of [CAPTIONS_OFF, CAPTIONS_KEY_KNOWN, SEEK_KEYS_KNOWN, CAPTIONS_CHANGED]) expect(source).toContain(JSON.stringify(key));
});
