import { expect, test } from 'bun:test';
import { appended, cardDraft, pathWord, wordsOf, draftOf, draftsHome, dropDraft, giveBack, insert, insertFiles, keepDrafts, MIC_DRAFT, markupOf, moveFiles, moveImages, OBEYA_DRAFT, setMarkup, updateDraft, updateDraftAt, withoutWords } from './draft';

const store = () => {
  const m = new Map<string, string>();
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};

// `keepDrafts` holds its store for the rest of the page
const s = store();

test("a card's draft outlives the page: written down per canvas as it changes, taken back by the next page", () => {
  const picks = { of: '[{"text":"Farbe?"}]', picks: [['Blau']] };
  s.setItem('obeya-drafts-shop', JSON.stringify({ [cardDraft('c9')]: { text: 'vom letzten Mal', images: ['img1'] }, [cardDraft('c5')]: { text: '', images: [], picks } }));
  const markup = { original: 'img0', marks: [{ kind: 'frame', x: 1, y: 2, w: 30, h: 40 }] };
  s.setItem('obeya-markups-shop', JSON.stringify({ img1: markup }));
  keepDrafts(s, 'shop');
  expect(draftOf(cardDraft('c9'))).toMatchObject({ text: 'vom letzten Mal', images: ['img1'], uploading: 0, dictation: '' });
  // the marks on its screenshot come back too, apart from the original
  expect(markupOf('img1')).toEqual(markup as never);
  setMarkup('img1', null);
  // the options picked come back too, also without words beside them
  expect(draftOf(cardDraft('c5')).picks).toEqual(picks);
  updateDraft(cardDraft('c5'), { picks: { of: picks.of, picks: [[]] } });

  updateDraft(cardDraft('c1'), { text: 'Bitte den Knopf blau' });
  updateDraft('field:x', { text: 'ein Feld für sich' });
  updateDraft(cardDraft('c2'), { text: '   ' });
  expect(JSON.parse(s.getItem('obeya-drafts-shop')!)).toEqual({
    [cardDraft('c9')]: { text: 'vom letzten Mal', images: ['img1'] },
    [cardDraft('c1')]: { text: 'Bitte den Knopf blau', images: [] },
  });

  // sent: the field is empty again, and nothing is kept
  updateDraft(cardDraft('c1'), { text: '' });
  dropDraft(cardDraft('c9'));
  expect(s.getItem('obeya-drafts-shop')).toBeNull();
});

test('the options picked for a card\'s questions are written down with its draft, and go once nothing is picked', () => {
  updateDraft(cardDraft('p1'), { picks: { of: 'q', picks: [['Ja'], []] } });
  expect(JSON.parse(s.getItem('obeya-drafts-shop')!)).toEqual({ [cardDraft('p1')]: { text: '', images: [], picks: { of: 'q', picks: [['Ja'], []] } } });
  updateDraft(cardDraft('p1'), { picks: undefined });
  expect(s.getItem('obeya-drafts-shop')).toBeNull();
});

test('the marks on a screenshot are kept beside its original by the marked image, and go when taken back', () => {
  const marks = [{ kind: 'pin' as const, x: 4, y: 5 }];
  setMarkup('marked1', { original: 'orig1', marks });
  expect(markupOf('marked1')).toEqual({ original: 'orig1', marks });
  expect(JSON.parse(s.getItem('obeya-markups-shop')!)).toEqual({ marked1: { original: 'orig1', marks } });
  setMarkup('marked1', null);
  expect(markupOf('marked1')).toBeUndefined();
  expect(s.getItem('obeya-markups-shop')).toBeNull();
});

test('words taken back go into an empty field with their screenshots; a field with newer words keeps those', () => {
  const key = cardDraft('back');
  giveBack(key, 'Bitte auch Excel.', ['shot.png']);
  expect(draftOf(key)).toMatchObject({ text: 'Bitte auch Excel.', images: ['shot.png'] });
  updateDraft(key, { text: 'Etwas anderes.', images: [] });
  giveBack(key, 'Und PDF.');
  expect(draftOf(key)).toMatchObject({ text: 'Etwas anderes.', images: [] });
  dropDraft(key);
});

test("the screenshots beside the microphone go into Obeya's field after those it has, the field's words untouched", () => {
  updateDraft(MIC_DRAFT, { images: ['a.png', 'b.png'] });
  updateDraft(OBEYA_DRAFT, { text: 'Schau mal', images: ['b.png', 'c.png'] });
  moveImages(MIC_DRAFT, OBEYA_DRAFT);
  expect(draftOf(OBEYA_DRAFT)).toMatchObject({ text: 'Schau mal', images: ['b.png', 'c.png', 'a.png'] });
  expect(draftOf(MIC_DRAFT).images).toEqual([]);
  dropDraft(MIC_DRAFT);
  dropDraft(OBEYA_DRAFT);
});

test("a dropped file's path goes after the draft's words without a field on the page, parted by a space", () => {
  insert(MIC_DRAFT, '/o/files/a/Rechnung.pdf');
  expect(draftOf(MIC_DRAFT).text).toBe('/o/files/a/Rechnung.pdf');
  insert(MIC_DRAFT, '/o/files/b/log.txt');
  expect(draftOf(MIC_DRAFT).text).toBe('/o/files/a/Rechnung.pdf /o/files/b/log.txt');
  updateDraft(MIC_DRAFT, { text: '' });
  expect(appended('Schau hier: ', '/x.pdf')).toBe('Schau hier: /x.pdf');
  expect(appended('Schau hier:', '/x.pdf')).toBe('Schau hier: /x.pdf');
  expect(appended('', '/x.pdf')).toBe('/x.pdf');
});

test('a path with a space goes in quotes and stays one word', () => {
  expect(pathWord('/home/o/.obeya/files/a/x.pdf')).toBe('/home/o/.obeya/files/a/x.pdf');
  const spaced = pathWord('C:\\Users\\John Doe\\.obeya\\files\\a\\x.pdf');
  expect(spaced).toBe('"C:\\Users\\John Doe\\.obeya\\files\\a\\x.pdf"');
  expect(wordsOf(`/o/a.pdf ${spaced}`)).toEqual(['/o/a.pdf', spaced]);
});

test("the paths of dropped files go back beside the microphone when Obeya's field closes, the words around them stay", () => {
  const spaced = pathWord('/o/John Doe/Plan.pdf');
  // dropped on the microphone, then the sidebar opened
  updateDraft(MIC_DRAFT, { text: `/o/a/Rechnung.pdf ${spaced}` });
  updateDraft(OBEYA_DRAFT, { text: 'Schau mal' });
  insertFiles(OBEYA_DRAFT, wordsOf(draftOf(MIC_DRAFT).text));
  updateDraft(MIC_DRAFT, { text: '' });
  expect(draftOf(OBEYA_DRAFT).text).toBe(`Schau mal /o/a/Rechnung.pdf ${spaced}`);
  // the owner writes on and takes one path out by hand: it stays gone
  updateDraft(OBEYA_DRAFT, (d) => ({ text: `${d.text.replace('/o/a/Rechnung.pdf ', '')} und sag was dazu` }));
  // the written-down draft keeps only the path still in it, so it goes back after a reload too
  expect(JSON.parse(s.getItem('obeya-drafts-shop')!)[OBEYA_DRAFT].files).toEqual([spaced]);
  moveFiles(OBEYA_DRAFT, MIC_DRAFT);
  expect(draftOf(OBEYA_DRAFT)).toMatchObject({ text: 'Schau mal und sag was dazu', files: [] });
  expect(draftOf(MIC_DRAFT).text).toBe(spaced);
  dropDraft(MIC_DRAFT);
  dropDraft(OBEYA_DRAFT);
});

test('a word taken out of a text takes the space after it, or at the end of a line the one before', () => {
  expect(withoutWords('/a.pdf', ['/a.pdf'])).toBe('');
  expect(withoutWords('Schau /a.pdf an', ['/a.pdf'])).toBe('Schau an');
  expect(withoutWords('Schau an /a.pdf', ['/a.pdf'])).toBe('Schau an');
  expect(withoutWords('Schau /a.pdf\nund das', ['/a.pdf'])).toBe('Schau\nund das');
  // only as a word of its own
  expect(withoutWords('/a.pdfx /a.pdf', ['/a.pdf'])).toBe('/a.pdfx');
});

test("another canvas in the same page brings its drafts in place of the ones before, which stay written down", () => {
  updateDraft(cardDraft('s1'), { text: 'auf dem Shop' });
  updateDraft(OBEYA_DRAFT, { text: 'an Obeya im Shop' });
  s.setItem('obeya-drafts-web', JSON.stringify({ [OBEYA_DRAFT]: { text: 'an Obeya auf der Website', images: [] } }));
  keepDrafts(s, 'web');
  expect(draftOf(OBEYA_DRAFT).text).toBe('an Obeya auf der Website');
  expect(draftOf(cardDraft('s1')).text).toBe('');
  // what the owner writes now goes to this canvas's drafts; the other canvas's stay as they were
  updateDraft(OBEYA_DRAFT, { text: 'neu auf der Website' });
  expect(JSON.parse(s.getItem('obeya-drafts-web')!)[OBEYA_DRAFT].text).toBe('neu auf der Website');
  expect(JSON.parse(s.getItem('obeya-drafts-shop')!)[OBEYA_DRAFT].text).toBe('an Obeya im Shop');
  // and back: the first canvas's drafts again
  keepDrafts(s, 'shop');
  expect(draftOf(OBEYA_DRAFT).text).toBe('an Obeya im Shop');
  expect(draftOf(cardDraft('s1')).text).toBe('auf dem Shop');
  dropDraft(OBEYA_DRAFT);
  dropDraft(cardDraft('s1'));
  expect(s.getItem('obeya-drafts-shop')).toBeNull();
});

test('a screenshot that arrives after a switch of canvas goes into the draft it was pasted into, not the one shown now', () => {
  updateDraft(OBEYA_DRAFT, { text: 'mit Bild' });
  const home = draftsHome();
  keepDrafts(s, 'web');
  updateDraftAt(home, OBEYA_DRAFT, (d) => ({ images: [...d.images, 'late'] }));
  expect(draftOf(OBEYA_DRAFT).images).toEqual([]);
  expect(JSON.parse(s.getItem('obeya-drafts-shop')!)[OBEYA_DRAFT]).toEqual({ text: 'mit Bild', images: ['late'] });
  keepDrafts(s, 'shop');
  expect(draftOf(OBEYA_DRAFT).images).toEqual(['late']);
  dropDraft(OBEYA_DRAFT);
  dropDraft(OBEYA_DRAFT);
  s.removeItem('obeya-drafts-web');
});
