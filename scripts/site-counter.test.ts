import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sitePages } from './site-sitemap';

const site = join(import.meta.dirname, '..', 'site');

test('every page of obeya.si counts its visits with the GoatCounter script the site serves itself', () => {
  for (const page of sitePages(site)) {
    // a Windows checkout has the pages with \r\n
    const html = readFileSync(join(site, page, 'index.html'), 'utf8');
    const tag = html.match(/<script data-goatcounter="https:\/\/obeya\.goatcounter\.com\/count" async src="([^"]+)"><\/script>\r?\n<\/head>/);
    expect(tag, `${page || '/'} has no counter`).not.toBeNull();
    const script = resolve(site, page, tag![1]!);
    expect(script).toBe(join(site, 'goatcounter.js'));
    expect(existsSync(script)).toBe(true);
  }
});
