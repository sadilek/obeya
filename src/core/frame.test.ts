import { expect, test } from 'bun:test';
import { mockPage, withHeightReport } from './frame';

test('a page reports its height at the end of its body, or of the page without one', () => {
  expect(withHeightReport('<html><body><h2>Graph</h2></body></html>')).toMatch(/<h2>Graph<\/h2><script>[\s\S]*obeyaHeight[\s\S]*<\/script><\/body><\/html>$/);
  expect(withHeightReport('<h2>Graph</h2>')).toMatch(/^<h2>Graph<\/h2><script>[\s\S]*obeyaHeight/);
});

test('a mock of a few lines becomes a page of its own; a whole page stays as it is', () => {
  const few = mockPage('<button>Export</button>');
  expect(few).toMatch(/^<!doctype html><html><head><meta charset="utf-8"><style>body\{[^}]*\}<\/style><\/head><body><button>Export<\/button><script>/);
  expect(few).toContain('obeyaHeight');
  const whole = '<!doctype html><html lang="de"><body style="margin:0"><p>Ganz</p></body></html>';
  expect(mockPage(whole)).toMatch(/^<!doctype html><html lang="de"><body style="margin:0"><p>Ganz<\/p><script>[\s\S]*<\/script><\/body><\/html>$/);
});
