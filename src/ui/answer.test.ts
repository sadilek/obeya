import { describe, expect, test } from 'bun:test';
import { answerText, toggle } from './answer';

const format = { text: 'Welches Format?', options: ['CSV', 'PDF', 'Excel'] };
const whom = { text: 'Für wen?\nKurz.', options: ['Vermieter', 'Verwalter'], multiple: true };

describe('an answer', () => {
  test('to one question is its pick, then the owner’s words', () => {
    expect(answerText([format], [['CSV']], '')).toBe('CSV');
    expect(answerText([format], [['CSV']], ' aber mit Kopfzeile ')).toBe('CSV\n\naber mit Kopfzeile');
    expect(answerText([format], [[]], 'Lieber JSON.')).toBe('Lieber JSON.');
    expect(answerText([format], [['CSV']], '', true)).toBe('**Welches Format?** CSV');
  });

  test('to several questions names each answered one', () => {
    expect(answerText([format, whom], [['PDF'], ['Vermieter', 'Verwalter']], 'Danke.')).toBe(
      '**Welches Format?** PDF\n**Für wen? Kurz.** Vermieter, Verwalter\n\nDanke.',
    );
    expect(answerText([format, whom], [[], ['Verwalter']], '')).toBe('**Für wen? Kurz.** Verwalter');
    expect(answerText([format, whom], [[], []], '')).toBe('');
  });

  test('picks one option of a single choice, several of a multiple choice in their order', () => {
    expect(toggle(format, ['CSV'], 'PDF')).toEqual(['PDF']);
    expect(toggle(format, ['CSV'], 'CSV')).toEqual([]);
    expect(toggle(whom, ['Verwalter'], 'Vermieter')).toEqual(['Vermieter', 'Verwalter']);
    expect(toggle(whom, ['Vermieter', 'Verwalter'], 'Vermieter')).toEqual(['Verwalter']);
  });
});
