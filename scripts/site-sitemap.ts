#!/usr/bin/env bun
// Writes obeya.si's sitemap into the site before it goes out: every page of the site (each
// `index.html` under it), dated by the last commit that changed that file, so a page added or
// changed by hand is in it without anyone keeping a list. The Pages workflow runs it on a checkout
// with its history (`fetch-depth: 0`); without one every page would carry the date of the last
// commit. The file stays out of git (.gitignore).
//
//   bun scripts/site-sitemap.ts [site dir] [base URL]   (defaults: site, https://obeya.si/)

import { execFileSync } from 'node:child_process';
import { readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';

/** A page's path under the site (`''` for the root, `code-signing/`) and the date it last changed, if git knows one. */
export interface SitePage {
  path: string;
  lastmod?: string;
}

/** The directories under `root` holding an `index.html`, as paths of the site, the root first. */
export function sitePages(root: string): string[] {
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((f) => f === 'index.html' || f.endsWith(`${sep}index.html`))
    .map((f) => f.slice(0, -'index.html'.length).split(sep).join('/'))
    .sort();
}

/** When the last commit changing `file` was made (ISO 8601), undefined for a file git does not have. */
export function lastChanged(file: string): string | undefined {
  const at = execFileSync('git', ['log', '-1', '--format=%cI', '--', basename(file)], { cwd: dirname(file), encoding: 'utf8' }).trim();
  return at || undefined;
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function sitemapXml(base: string, pages: SitePage[]): string {
  const root = base.replace(/\/+$/, '') + '/';
  const urls = pages.map((p) => `<url><loc>${xml(root + p.path)}</loc>${p.lastmod ? `<lastmod>${p.lastmod}</lastmod>` : ''}</url>\n`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join('')}</urlset>
`;
}

if (import.meta.main) {
  const [root = 'site', base = 'https://obeya.si/'] = process.argv.slice(2);
  const pages = sitePages(root).map((path) => ({ path, lastmod: lastChanged(join(root, path, 'index.html')) }));
  writeFileSync(join(root, 'sitemap.xml'), sitemapXml(base, pages));
  for (const p of pages) console.log(`${p.lastmod ?? 'undated'}  ${base.replace(/\/+$/, '')}/${p.path}`);
  console.log(`wrote ${relative(process.cwd(), join(root, 'sitemap.xml'))}`);
}
