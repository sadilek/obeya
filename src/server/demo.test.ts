import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readChapters, serveDemoFile } from './demo';

const dir = mkdtempSync(join(tmpdir(), 'obeya-demo-'));
writeFileSync(join(dir, 'demo.mp4'), '0123456789');
writeFileSync(join(dir, 'captions.vtt'), 'WEBVTT\n\n00:00:00.351 --> 00:00:16.271\nEins.\n\n00:01:17.225 --> 00:01:30.025\nZwei.\n');
afterAll(() => rmSync(dir, { recursive: true, force: true }));

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
});

describe('serveDemoFile for an HTML artifact', () => {
  const html = join(dir, 'logos');
  mkdirSync(join(html, 'img'), { recursive: true });
  writeFileSync(join(html, 'index.html'), '<img src="img/a.svg">');
  writeFileSync(join(html, 'img', 'a.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const get = (name: string) => serveDemoFile({ dir: html, kind: 'html' }, name, new Request('http://x/'));

  test('the page and the files beside it, sandboxed; nothing outside its directory', async () => {
    const page = get('index.html');
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(page.headers.get('content-security-policy')).toBe('sandbox allow-scripts');
    expect(await page.text()).toMatch(/^<img src="img\/a.svg"><script>[\s\S]*obeyaHeight/);
    expect(await get('img/a.svg').text()).toContain('<svg');
    expect(get('../demo.mp4').status).toBe(404);
    expect(get('img').status).toBe(404);
    expect(get('nope.html').status).toBe(404);
  });
});
