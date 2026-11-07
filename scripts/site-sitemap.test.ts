import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitRepo } from '../src/server/testing';
import { lastChanged, sitemapXml, sitePages } from './site-sitemap';

let dir = '';
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test('lists every page of the site, each dated by the last commit that changed it', () => {
  dir = mkdtempSync(join(tmpdir(), 'obeya-sitemap-'));
  const repo = gitRepo(join(dir, 'repo'), {
    'site/index.html': 'home',
    'site/style.css': 'body {}',
    'site/code-signing/index.html': 'policy',
    'site/watch-the-demo/index.html': 'essay',
    'site/img/logo.svg': '<svg/>',
  });
  writeFileSync(join(repo, 'site/code-signing/index.html'), 'policy, changed');
  const env = { ...process.env, GIT_COMMITTER_DATE: '2031-02-03T04:05:06+01:00' };
  execFileSync('git', ['commit', '--quiet', '-am', 'policy'], { cwd: repo, env });

  const site = join(repo, 'site');
  expect(sitePages(site)).toEqual(['', 'code-signing/', 'watch-the-demo/']);
  expect(lastChanged(join(site, 'code-signing/index.html'))).toBe('2031-02-03T04:05:06+01:00');
  const home = lastChanged(join(site, 'index.html'));
  expect(new Date(home!).getTime()).toBeLessThan(new Date('2031-01-01').getTime());

  const pages = sitePages(site).map((path) => ({ path, lastmod: lastChanged(join(site, path, 'index.html')) }));
  expect(sitemapXml('https://example.dev', pages)).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>https://example.dev/</loc><lastmod>${home}</lastmod></url>
<url><loc>https://example.dev/code-signing/</loc><lastmod>2031-02-03T04:05:06+01:00</lastmod></url>
<url><loc>https://example.dev/watch-the-demo/</loc><lastmod>${pages[2]!.lastmod}</lastmod></url>
</urlset>
`);
});

test('a page git does not have yet goes in undated', () => {
  dir = mkdtempSync(join(tmpdir(), 'obeya-sitemap-'));
  const repo = gitRepo(join(dir, 'repo'), { 'site/index.html': 'home' });
  mkdirSync(join(repo, 'site/draft'));
  writeFileSync(join(repo, 'site/draft/index.html'), 'not committed');
  expect(lastChanged(join(repo, 'site/draft/index.html'))).toBeUndefined();
  expect(sitemapXml('https://example.dev/', [{ path: 'draft/' }])).toContain('<url><loc>https://example.dev/draft/</loc></url>');
});

test("obeya.si's robots.txt lets every crawler in and names the sitemap the workflow writes", () => {
  // with \r\n where git checks files out so (core.autocrlf on Windows)
  expect(readFileSync(join(import.meta.dirname, '../site/robots.txt'), 'utf8').replaceAll('\r\n', '\n')).toBe('User-agent: *\nAllow: /\n\nSitemap: https://obeya.si/sitemap.xml\n');
  expect(readFileSync(join(import.meta.dirname, '../.github/workflows/pages.yml'), 'utf8')).toContain('bun scripts/site-sitemap.ts site https://obeya.si/');
});
