import { describe, expect, test } from 'bun:test';
import { matchCreatedCards } from './cardLink';

describe('matchCreatedCards', () => {
  test('links a created task title inline inside German or English quotes', () => {
    const de = matchCreatedCards(
      'Neue Aufgabe „Demo-Videos auf dem Handy: Buttons kaum sichtbar, zu wenig Kontrast“, der Agent startet.',
      [{ id: 'c1', title: 'Demo-Videos auf dem Handy: Buttons kaum sichtbar, zu wenig Kontrast' }],
    );
    expect(de.marked).toBe('Neue Aufgabe „\u00000\u0000“, der Agent startet.');
    expect(de.matches).toEqual([{ entry: { id: 'c1', title: 'Demo-Videos auf dem Handy: Buttons kaum sichtbar, zu wenig Kontrast' }, text: 'Demo-Videos auf dem Handy: Buttons kaum sichtbar, zu wenig Kontrast' }]);
    expect(de.unmatched).toEqual([]);

    const en = matchCreatedCards('New task “Meter readings as CSV”, the agent starts.', [{ id: 'c2', title: 'Meter readings as CSV' }]);
    expect(en.marked).toBe('New task “\u00000\u0000”, the agent starts.');
    expect(en.unmatched).toEqual([]);
  });

  test('matches longest titles first so overlapping titles never collide', () => {
    const r = matchCreatedCards('Neue Aufgaben „Export“ und „Export als PDF“, die Agenten starten.', [
      { id: 'c1', title: 'Export' },
      { id: 'c2', title: 'Export als PDF' },
    ]);
    expect(r.marked).toBe('Neue Aufgaben „\u00000\u0000“ und „\u00001\u0000“, die Agenten starten.');
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
    expect(parens.marked).toBe('Neue Aufgabe „\u00000\u0000“, der Agent startet.');
    expect(parens.unmatched).toEqual([]);

    const quotes = matchCreatedCards('Neue Aufgabe „Hinweis „unten“ korrigieren“, der Agent fängt an.', [
      { id: 'c2', title: 'Hinweis "unten" korrigieren' },
    ]);
    expect(quotes.marked).toBe('Neue Aufgabe „\u00000\u0000“, der Agent fängt an.');
    expect(quotes.matches[0]!.text).toBe('Hinweis „unten“ korrigieren');
    expect(quotes.unmatched).toEqual([]);
  });

  test('prefers the quoted occurrence over an earlier unquoted word', () => {
    const r = matchCreatedCards('Export: Neue Aufgabe „Export“ angelegt.', [{ id: 'c1', title: 'Export' }]);
    expect(r.marked).toBe('Export: Neue Aufgabe „\u00000\u0000“ angelegt.');
  });

  test('leaves cards whose title is not in the reply as unmatched for the footer', () => {
    const r = matchCreatedCards('Ich lege eine Review-Karte für PR #5 an, mit Blick auf Security.', [
      { id: 'c1', title: 'PR #5: Improve mobile demo contrast' },
    ]);
    expect(r.marked).toBe('Ich lege eine Review-Karte für PR #5 an, mit Blick auf Security.');
    expect(r.matches).toEqual([]);
    expect(r.unmatched).toEqual([{ id: 'c1', title: 'PR #5: Improve mobile demo contrast' }]);
  });

  test('does not match inside words, URLs, markdown links, or fenced code blocks', () => {
    const insideWord = matchCreatedCards('Ich starte das Update gleich.', [{ id: 'c1', title: 'Up' }]);
    expect(insideWord.matches).toEqual([]);
    expect(insideWord.unmatched).toEqual([{ id: 'c1', title: 'Up' }]);

    const inUrl = matchCreatedCards('Siehe https://example.com/Export und [Export](https://example.com)\n```\nExport\n```', [{ id: 'c2', title: 'Export' }]);
    expect(inUrl.matches).toEqual([]);
    expect(inUrl.unmatched).toEqual([{ id: 'c2', title: 'Export' }]);
  });

  test('matches titles whose markdown marks were omitted in the reply', () => {
    const r = matchCreatedCards('New task “Fix bun test hang”, the agent starts.', [{ id: 'c1', title: 'Fix `bun test` hang' }]);
    expect(r.marked).toBe('New task “\u00000\u0000”, the agent starts.');
    expect(r.matches[0]!.text).toBe('Fix bun test hang');
    expect(r.unmatched).toEqual([]);
  });
});
