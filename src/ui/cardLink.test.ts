import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Item } from '../core/types';
import { matchCreatedCards, ReplyBody } from './cardLink';

const card = (id: string, title: string, extra: Partial<Item> = {}): Item =>
  ({ id, short: id, number: 1, kind: 'task', state: 'working', title, body: '', x: 0, y: 0, source: 'manual', repo: 'r', ...extra }) as Item;

describe('matchCreatedCards', () => {
  test('links a created task title inline inside German or English quotes', () => {
    const de = matchCreatedCards(
      'Neue Aufgabe „Demo-Videos auf dem Handy: Buttons kaum sichtbar, zu wenig Kontrast“, der Agent startet.',
      [{ id: 'c1', title: 'Demo-Videos auf dem Handy: Buttons kaum sichtbar, zu wenig Kontrast' }],
    );
    expect(de.matches.map((m) => [m.entry.id, m.text])).toEqual([['c1', 'Demo-Videos auf dem Handy: Buttons kaum sichtbar, zu wenig Kontrast']]);
    expect(de.unmatched).toEqual([]);

    const en = matchCreatedCards('New task “Meter readings as CSV”, the agent starts.', [{ id: 'c2', title: 'Meter readings as CSV' }]);
    expect(en.matches.map((m) => [m.entry.id, m.text])).toEqual([['c2', 'Meter readings as CSV']]);
    expect(en.unmatched).toEqual([]);
  });

  test('matches longest titles first so overlapping titles never collide', () => {
    const r = matchCreatedCards('Neue Aufgaben „Export“ und „Export als PDF“, die Agenten starten.', [
      { id: 'c1', title: 'Export' },
      { id: 'c2', title: 'Export als PDF' },
    ]);
    expect(r.matches.map((m) => [m.entry.id, m.text])).toEqual([
      ['c1', 'Export'],
      ['c2', 'Export als PDF'],
    ]);
    expect(r.unmatched).toEqual([]);
  });

  test('handles titles with parentheses, inner quotes, and mismatched quote styles', () => {
    const parens = matchCreatedCards('Neue Aufgabe „Obeyas Antwort im Chat verlinkt neu angelegte Aufgaben (G)“, der Agent startet.', [
      { id: 'c1', title: 'Obeyas Antwort im Chat verlinkt neu angelegte Aufgaben (G)' },
    ]);
    expect(parens.matches.map((m) => m.text)).toEqual(['Obeyas Antwort im Chat verlinkt neu angelegte Aufgaben (G)']);
    expect(parens.unmatched).toEqual([]);

    const quotes = matchCreatedCards('Neue Aufgabe „Hinweis „unten“ korrigieren“, der Agent fängt an.', [
      { id: 'c2', title: 'Hinweis "unten" korrigieren' },
    ]);
    expect(quotes.matches.map((m) => m.text)).toEqual(['Hinweis „unten“ korrigieren']);
    expect(quotes.unmatched).toEqual([]);
  });

  test('prefers the quoted occurrence over an earlier unquoted word', () => {
    const r = matchCreatedCards('Export: Neue Aufgabe „Export“ angelegt.', [{ id: 'c1', title: 'Export' }]);
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0]!.start).toBe('Export: Neue Aufgabe „'.length);
  });

  test('leaves cards whose title is not in the reply as unmatched for the footer', () => {
    const r = matchCreatedCards('Ich lege eine Review-Karte für PR #5 an, mit Blick auf Security.', [
      { id: 'c1', title: 'PR #5: Improve mobile demo contrast' },
    ]);
    expect(r.matches).toEqual([]);
    expect(r.unmatched).toEqual([{ id: 'c1', title: 'PR #5: Improve mobile demo contrast' }]);
  });

  test('skips words, inline code, URLs, markdown links, HTML comments, and fenced or quoted code blocks', () => {
    const insideWord = matchCreatedCards('Ich starte das Update gleich.', [{ id: 'c1', title: 'Up' }]);
    expect(insideWord.matches).toEqual([]);
    expect(insideWord.unmatched).toEqual([{ id: 'c1', title: 'Up' }]);

    const inCode = matchCreatedCards('Neue Aufgabe `Export` angelegt.', [{ id: 'c2', title: 'Export' }]);
    expect(inCode.matches).toEqual([]);
    expect(inCode.unmatched).toEqual([{ id: 'c2', title: 'Export' }]);

    const inBlocks = matchCreatedCards(
      'Siehe https://example.com/Export und [Export](https://example.com) <!-- Export -->\n```\nExport\n```\n> ```\n> Export\n> ```',
      [{ id: 'c3', title: 'Export' }],
    );
    expect(inBlocks.matches).toEqual([]);
    expect(inBlocks.unmatched).toEqual([{ id: 'c3', title: 'Export' }]);
  });

  test('preserves exact indices with Unicode characters whose lowercase expands (Turkish İ)', () => {
    const r = matchCreatedCards('İstanbul: Neue Aufgabe „Export“, der Agent startet.', [{ id: 'c1', title: 'export' }]);
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0]!.text).toBe('Export');
    expect(r.unmatched).toEqual([]);
  });

  test('matches titles whose markdown marks were omitted in the reply', () => {
    const r = matchCreatedCards('New task “Fix bun test hang”, the agent starts.', [{ id: 'c1', title: 'Fix `bun test` hang' }]);
    expect(r.matches.map((m) => m.text)).toEqual(['Fix bun test hang']);
    expect(r.unmatched).toEqual([]);
  });
});

describe('ReplyBody rendering', () => {
  test('never corrupts inline code spans and falls back to a footer link', () => {
    const html = renderToStaticMarkup(
      createElement(ReplyBody, {
        md: 'Neue Aufgabe `Export` angelegt.',
        created: [{ id: 'c1', title: 'Export' }],
        items: [card('c1', 'Export')],
        onOpen: () => {},
      }),
    );
    expect(html).toContain('<code>Export</code>');
    expect(html).not.toContain('\u0000');
    expect(html).toContain('<div class="created-links">');
    expect(html).toContain('href="/c//card/c1"');
  });

  test('links titles inside bold formatting and after Turkish İ without shifting text', () => {
    const html = renderToStaticMarkup(
      createElement(ReplyBody, {
        md: 'İstanbul: **Neue Aufgabe „Export“**, der Agent startet.',
        created: [{ id: 'c1', title: 'export' }],
        items: [card('c1', 'Export')],
        onOpen: () => {},
      }),
    );
    expect(html).toContain('<b>Neue Aufgabe „<a class="link" href="/c//card/c1">Export</a>“</b>');
    expect(html).not.toContain('created-links');
  });

  test('uses short codes for live cross-canvas links and renders gone or archived cards as plain text', () => {
    const liveRemote = renderToStaticMarkup(
      createElement(ReplyBody, {
        md: 'New task “Landing” on Website.',
        created: [{ id: 'remote-uuid', title: 'Landing', canvas: 'website', short: 'abc123' }],
        items: [],
        onOpen: () => {},
      }),
    );
    expect(liveRemote).toContain('<a class="link" href="/c/website/card/abc123">Landing</a>');

    const goneRemote = renderToStaticMarkup(
      createElement(ReplyBody, {
        md: 'New task “Landing” on Website.',
        created: [{ id: 'remote-uuid', title: 'Landing', canvas: 'website', gone: true }],
        items: [],
        onOpen: () => {},
      }),
    );
    expect(goneRemote).not.toContain('<a ');
    expect(goneRemote).toContain('New task “Landing” on Website.');

    const goneUnmatched = renderToStaticMarkup(
      createElement(ReplyBody, {
        md: 'Starting review for PR #42.',
        created: [{ id: 'pr-1', title: 'PR #42: Fix', canvas: 'website', gone: true }],
        items: [],
        onOpen: () => {},
      }),
    );
    expect(goneUnmatched).not.toContain('<a ');
    expect(goneUnmatched).not.toContain('created-links');
  });
});
