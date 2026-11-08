import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pagePolicy } from '../core/frame';
import { artifactFiles, captionTracks, silentVideo, videoSize } from './demo-page';
import { checkPlugin, DEMO_SKILL, DEMO_SKILL_FILE, demoFiles, demoSkillName, OBEYA_PLUGIN, placeIn, readChapters, serveDemoFile, serveMockFrame, videoFacts } from './demo';
import { removeDir } from './testing';

const dir = mkdtempSync(join(tmpdir(), 'obeya-demo-'));
writeFileSync(join(dir, 'demo.mp4'), '0123456789');
writeFileSync(join(dir, 'captions.vtt'), 'WEBVTT\n\n00:00:00.351 --> 00:00:16.271\nEins.\n\n00:01:17.225 --> 00:01:30.025\nZwei.\n');
afterAll(() => removeDir(dir));

describe('readChapters', () => {
  test('takes scene starts from the captions, before the narration lead', () => {
    expect(readChapters(dir, ['Ausgangslage', 'Neu'])).toEqual([
      [0, 'Ausgangslage'],
      [76.88, 'Neu'],
    ]);
  });

  test('says what is wrong', () => {
    expect(readChapters(dir, ['Nur eins'])).toContain('2 cues but 1 chapter');
    expect(readChapters(join(dir, 'nope'), [])).toContain('demo.mp4 is missing');
  });
});

describe('a demo with a caption track per language', () => {
  const tracked = mkdtempSync(join(tmpdir(), 'obeya-demo-tracks-'));
  afterAll(() => rmSync(tracked, { recursive: true, force: true }));
  const en = 'WEBVTT\n\n00:00:00.350 --> 00:00:02.000\nOne.\n\n00:00:02.000 --> 00:00:04.000\nTwo.\n\n00:00:05.350 --> 00:00:07.000\nThree.\n';
  // an MP4's track list as the director writes it (`+faststart`): a video handler, and an audio one unless silent
  const box = (type: string) => `\0\0\0!${type}`;
  const mp4 = (sound: boolean) => Buffer.from(`${box('ftyp')}isom${box('moov')}${box('hdlr')}\0\0\0\0\0\0\0\0vide${sound ? `${box('hdlr')}\0\0\0\0\0\0\0\0soun` : ''}${box('mdat')}`, 'latin1');
  writeFileSync(join(tracked, 'demo.mp4'), mp4(false));
  // the narration's captions name the tracks, in the settings' order; the narration's own is not among them
  writeFileSync(join(tracked, 'captions.vtt'), en.replace('WEBVTT', 'WEBVTT - subtitles: pt-BR de'));
  writeFileSync(join(tracked, 'captions.de.vtt'), en.replace('One.', 'Eins.'));
  writeFileSync(join(tracked, 'captions.en.vtt'), en);
  writeFileSync(join(tracked, 'captions.pt-BR.vtt'), en.replace('One.', 'Um.'));
  writeFileSync(join(tracked, 'chapters.vtt'), 'WEBVTT\n\n00:00:00.000 --> 00:00:05.000\nBefore\n\n00:00:05.000 --> 00:00:08.000\nAfter\n');

  test('its chapters come from chapters.vtt: a scene has a cue per sentence in the captions', () => {
    expect(readChapters(tracked, ['Before', 'After'])).toEqual([
      [0, 'Before'],
      [5, 'After'],
    ]);
    expect(readChapters(tracked, ['Only'])).toContain('2 scenes but 1 chapter');
  });

  test('the tracks its captions.vtt names, in their order, are served, and the player learns whether it is silent', async () => {
    expect(captionTracks(tracked).map((t) => t.language)).toEqual(['pt-BR', 'de']);
    expect(captionTracks(dir)).toEqual([{ file: 'captions.vtt' }]);
    expect(videoFacts(tracked)).toEqual({ tracks: ['pt-BR', 'de'], silent: true });
    expect(videoFacts(dir)).toEqual({});
    expect(demoFiles(tracked).sort()).toEqual(['captions.de.vtt', 'captions.pt-BR.vtt', 'captions.vtt', 'demo.mp4']);
    const served = serveDemoFile({ dir: tracked, kind: 'video' }, 'captions.pt-BR.vtt', new Request('http://x/'));
    expect(await served.text()).toContain('Um.');
    expect(serveDemoFile({ dir: tracked, kind: 'video' }, 'chapters.vtt', new Request('http://x/')).status).toBe(404);
  });

  test('one whose captions.vtt names no tracks offers none, though it keeps the narration for placing comments', () => {
    const bare = mkdtempSync(join(tmpdir(), 'obeya-demo-bare-'));
    try {
      writeFileSync(join(bare, 'captions.vtt'), en.replace('WEBVTT', 'WEBVTT - subtitles: none'));
      expect(captionTracks(bare)).toEqual([]);
      expect(videoFacts(bare)).toEqual({ tracks: [] });
      expect(placeIn(bare, [[0, 'Before']], 1).narration).toBe('One.');
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  test('a video is silent without an audio handler in its track list; one whose list comes after the media counts as sounding', () => {
    const file = join(tracked, 'probe.mp4');
    writeFileSync(file, mp4(true));
    expect(silentVideo(file)).toBe(false);
    writeFileSync(file, mp4(false));
    expect(silentVideo(file)).toBe(true);
    writeFileSync(file, Buffer.from('\0\0\0 ftypisom\0\0\0\0mdat', 'latin1'));
    expect(silentVideo(file)).toBe(false);
  });

  test("a video's width and height come from the first track in its list with a picture, for the player's shape before it loads", () => {
    // a `tkhd` box: version and flags, times, track and duration (wider in version 1), then 52 bytes to width and height in 16.16
    const tkhd = (version: 0 | 1, w: number, h: number) => {
      const b = Buffer.alloc(4 + 4 + (version ? 32 : 20) + 52 + 8);
      b.write('tkhd', 0, 'latin1');
      b[4] = version;
      b.writeUInt32BE(w * 65536, b.length - 8);
      b.writeUInt32BE(h * 65536, b.length - 4);
      return b;
    };
    const file = join(tracked, 'sized.mp4');
    // the sound's track, without a picture, comes first
    writeFileSync(file, Buffer.concat([Buffer.from('\0\0\0 ftypisom\0\0\0\0moov', 'latin1'), tkhd(0, 0, 0), tkhd(0, 1440, 900)]));
    expect(videoSize(file)).toEqual([1440, 900]);
    writeFileSync(file, Buffer.concat([Buffer.from('\0\0\0 ftypisom\0\0\0\0moov', 'latin1'), tkhd(1, 860, 1640)]));
    expect(videoSize(file)).toEqual([860, 1640]);
    expect(videoFacts(tracked).size).toBeUndefined();
    writeFileSync(file, Buffer.from('\0\0\0 ftypisom\0\0\0\0mdat', 'latin1'));
    expect(videoSize(file)).toBeNull();
  });
});

describe('serveDemoFile', () => {
  const get = (name: string, range?: string) => serveDemoFile({ dir, kind: 'video' }, name, new Request('http://x/', range ? { headers: { range } } : {}));

  test('whole file, byte ranges, and nothing outside the demo files', async () => {
    const all = get('demo.mp4');
    expect(all.status).toBe(200);
    expect(all.headers.get('accept-ranges')).toBe('bytes');
    expect(await all.text()).toBe('0123456789');
    const part = get('demo.mp4', 'bytes=2-4');
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 2-4/10');
    expect(await part.text()).toBe('234');
    expect(await get('demo.mp4', 'bytes=7-').text()).toBe('789');
    expect(await get('demo.mp4', 'bytes=-3').text()).toBe('789');
    expect(get('demo.mp4', 'bytes=20-').status).toBe(416);
    expect(get('../secret').status).toBe(404);
    expect(get('demo.ts').status).toBe(404);
    expect(get('captions.vtt').headers.get('content-type')).toContain('text/vtt');
  });

  test('a range of a large video answers with a part of it at a time', async () => {
    const big = mkdtempSync(join(tmpdir(), 'obeya-demo-big-'));
    try {
      const bytes = Buffer.alloc(20 << 20).map((_, i) => (i * 7 + (i >> 16)) & 255);
      writeFileSync(join(big, 'demo.mp4'), bytes);
      const part = serveDemoFile({ dir: big, kind: 'video' }, 'demo.mp4', new Request('http://x/', { headers: { range: 'bytes=1000-' } }));
      expect(part.status).toBe(206);
      expect(part.headers.get('content-range')).toBe(`bytes 1000-${1000 + (8 << 20) - 1}/${20 << 20}`);
      expect(Buffer.from(await part.arrayBuffer()).equals(bytes.subarray(1000, 1000 + (8 << 20)))).toBe(true);
      const whole = serveDemoFile({ dir: big, kind: 'video' }, 'demo.mp4', new Request('http://x/'));
      expect(whole.status).toBe(200);
      expect(Buffer.from(await whole.arrayBuffer()).equals(bytes)).toBe(true);
    } finally {
      rmSync(big, { recursive: true, force: true });
    }
  });

  test('a file cut after its size was read answers with only what is left of it', async () => {
    const cut = mkdtempSync(join(tmpdir(), 'obeya-demo-cut-'));
    // its size as it was before a retake cut it
    const sized = (size: number) => (() => ({ size })) as unknown as typeof fs.fstatSync;
    const stat = spyOn(fs, 'fstatSync').mockImplementationOnce(sized(20 << 20));
    try {
      writeFileSync(join(cut, 'demo.mp4'), '0123456789');
      const part = serveDemoFile({ dir: cut, kind: 'video' }, 'demo.mp4', new Request('http://x/', { headers: { range: 'bytes=4-' } }));
      expect(part.status).toBe(206);
      expect(part.headers.get('content-range')).toBe('bytes 4-9/10');
      expect(part.headers.get('content-length')).toBe('6');
      expect(await part.text()).toBe('456789');
      expect(stat).toHaveBeenCalledTimes(2);
      stat.mockImplementationOnce(sized(20 << 20));
      expect(serveDemoFile({ dir: cut, kind: 'video' }, 'demo.mp4', new Request('http://x/', { headers: { range: 'bytes=100-' } })).status).toBe(416);
      stat.mockImplementationOnce(sized(1000));
      const whole = serveDemoFile({ dir: cut, kind: 'video' }, 'demo.mp4', new Request('http://x/'));
      expect(whole.headers.get('content-length')).toBe('10');
      expect(await whole.text()).toBe('0123456789');
    } finally {
      stat.mockRestore();
      rmSync(cut, { recursive: true, force: true });
    }
  });
});

describe('serveDemoFile for an HTML artifact', () => {
  const html = join(dir, 'logos');
  mkdirSync(join(html, 'img'), { recursive: true });
  writeFileSync(join(html, 'index.html'), '<img src="img/a.svg">');
  writeFileSync(join(html, 'img', 'a.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const base = 'http://127.0.0.1:4417/api/c/c1/cards/12/demo/';
  const ask = (url: string, headers: Record<string, string> = {}) =>
    serveDemoFile({ dir: html, kind: 'html' }, decodeURIComponent(url.slice(base.length)), new Request(url, { headers }));
  // as the browser does: on to the address with the directory's key
  const get = (name: string, headers: Record<string, string> = {}) => {
    const first = ask(base + name, headers);
    return first.status === 302 ? ask(new URL(first.headers.get('location')!, base).href, headers) : first;
  };

  test('the page and the files beside it, sandboxed and loading nothing from elsewhere; nothing outside its directory', async () => {
    const page = get('index.html', { 'sec-fetch-dest': 'iframe' });
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(page.headers.get('content-security-policy')).toBe(`sandbox allow-scripts; ${pagePolicy('http://127.0.0.1:4417')}`);
    expect(page.headers.get('connection-allowlist')).toBe('(response-origin)');
    expect(page.headers.get('x-dns-prefetch-control')).toBe('off');
    // behind `tailscale serve` the files are named by the address the browser sent the request to
    const proxied = get('index.html', { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'mac.tail1.ts.net' });
    expect(proxied.headers.get('content-security-policy')).toContain("default-src 'self' https://mac.tail1.ts.net data: blob:;");
    // an address no policy can name gives no files beside the page
    expect(get('index.html', { 'x-forwarded-proto': 'https; default-src *' }).headers.get('content-security-policy')).toBe(`sandbox allow-scripts; ${pagePolicy()}`);
    expect(await page.text()).toMatch(/^<img src="img\/a.svg"><script>[\s\S]*obeyaHeight[\s\S]*obeyaMarked/);
    expect(await get('img/a.svg').text()).toContain('<svg');
    expect(get('../demo.mp4').status).toBe(404);
    expect(get('img').status).toBe(404);
    expect(get('nope.html').status).toBe(404);
  });

  test('opened in a window of its own, a page or an SVG comes in a sandboxed frame of a page around it; an image as it is', async () => {
    const top = { 'sec-fetch-dest': 'document' };
    const page = get('index.html', top);
    expect(page.headers.get('content-security-policy')).toMatch(/^default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-[A-Za-z0-9+\/=]+'; frame-src 'self'$/);
    // the frame gets the page's own address, the part after # too, which never reaches the server
    expect(await page.text()).toContain(`<iframe sandbox="allow-scripts"></iframe><script>document.querySelector('iframe').src = location.pathname + location.search + location.hash;</script>`);
    expect(await get('img/a.svg', top).text()).toContain('<iframe sandbox="allow-scripts"');
    writeFileSync(join(html, 'a.png'), 'png');
    expect(await get('a.png', top).text()).toBe('png');
    rmSync(join(html, 'a.png'));
  });

  test("an idea's mock is written into an empty frame that connects to nothing", async () => {
    const frame = serveMockFrame();
    expect(frame.headers.get('content-security-policy')).toBe(`sandbox allow-scripts; ${pagePolicy()}`);
    expect(frame.headers.get('connection-allowlist')).toBe('()');
    expect(await frame.text()).toContain('document.write(e.data.obeyaPage)');
  });

  test('a link to a file outside the directory is no file of it, for the video or the artifact', async () => {
    const outside = join(dir, 'secret.txt');
    writeFileSync(outside, 'secret');
    symlinkSync(outside, join(html, 'k'));
    symlinkSync(dir, join(html, 'up'));
    symlinkSync(join(html, 'img', 'a.svg'), join(html, 'logo.svg'));
    expect(get('k').status).toBe(404);
    expect(get('up/secret.txt').status).toBe(404);
    // a link within the directory is one of its files
    expect(await get('logo.svg').text()).toContain('<svg');
    expect(artifactFiles(html)).toEqual(['img/a.svg', 'index.html', 'logo.svg']);
    const video = join(dir, 'linked');
    mkdirSync(video);
    symlinkSync(outside, join(video, 'demo.mp4'));
    expect(serveDemoFile({ dir: video, kind: 'video' }, 'demo.mp4', new Request('http://x/')).status).toBe(404);
  });

  test('its page and what that loads relative to itself may be read in CORS mode; without the key, nothing is', () => {
    // the frame's requests carry `Origin: null`, and any sandboxed page on any site sends the same
    const first = ask(`${base}index.html`, { origin: 'null' });
    expect(first.status).toBe(302);
    expect(first.headers.get('access-control-allow-origin')).toBeNull();
    const page = first.headers.get('location')!;
    expect(page).toMatch(/^\/api\/c\/c1\/cards\/12\/demo\/~[0-9a-f]{32}\/index\.html$/);
    const module = new URL('img/a.svg', new URL(page, base)).href;
    expect(ask(module, { origin: 'null' }).headers.get('access-control-allow-origin')).toBe('null');
    // another directory has another key; a wrong or old key is sent on to the right one
    const other = 'http://127.0.0.1:4417/api/c/c1/cards/13/demo/';
    expect(ask(module.replace(base, other)).status).toBe(302);
    expect(ask(`${base}~${'0'.repeat(32)}/img/a.svg`).headers.get('location')).toBe(new URL(module).pathname);
  });
});

describe('the plugin workers load', () => {
  test('has its manifest and the demo skill; a missing one is named', () => {
    expect(DEMO_SKILL_FILE).toBe(join(OBEYA_PLUGIN, 'skills', 'demo', 'SKILL.md'));
    expect(checkPlugin()).toBeNull();
    expect(checkPlugin(join(dir, 'no-plugin'))).toBe(`${join(dir, 'no-plugin', '.claude-plugin', 'plugin.json')} is missing: workers' sessions have no demo skill`);
  });

  test('the demo skill is obeya:demo, unless a user skill links to its file and takes its place', () => {
    const skills = join(dir, 'skills');
    expect(demoSkillName(skills)).toBe(DEMO_SKILL);
    mkdirSync(join(skills, 'other'), { recursive: true });
    writeFileSync(join(skills, 'other', 'SKILL.md'), '---\nname: other\n---\n');
    expect(demoSkillName(skills)).toBe(DEMO_SKILL);
    symlinkSync(join(OBEYA_PLUGIN, 'skills', 'demo'), join(skills, 'demo'));
    expect(demoSkillName(skills)).toBe('demo');
  });
});
