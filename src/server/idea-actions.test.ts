import { describe, expect, test } from 'bun:test';
import type { Item } from '../core/types';
import { prototypeBuild, prototypeName } from './idea-actions';

const card = (over: Partial<Item>): Item => ({ id: 'x', number: 1, kind: 'task', state: 'planned', title: '', body: '', x: 0, y: 0, source: 'manual', repo: 'r', ...over });

describe('prototypeBuild', () => {
  const ws = (title: string, body = '') => ({ title, body });
  const film = card({ title: 'Prototype: Site – Film first', variant: 'Film first' });
  const manifest = card({ title: 'Prototype: Site – Manifest' });

  test('a prototype goes by its variant, else by the approach its title names after the idea', () => {
    expect([film, manifest, card({ title: 'Prototype: Site' })].map(prototypeName)).toEqual(['Film first', 'Manifest', 'Prototype: Site']);
    // a second prototype of the same variant by its own title's
    expect(prototypeName(card({ title: 'Prototype: Site – Film first (2)', variant: 'Film first' }))).toBe('Film first (2)');
  });

  test('the one workstream that names one prototype in quotes builds on it', () => {
    const [w1, w2] = [ws('Licence'), ws('Build the page', 'On the branch of the prototype „Film first“.')];
    expect(prototypeBuild([w1, w2], [film, manifest])).toEqual({ workstream: w2, prototype: film, also: [] });
    // a word that happens to be a prototype's name names none
    expect(prototypeBuild([w2, ws('Texts', 'Write manifest.json.')], [film, manifest])).toEqual({ workstream: w2, prototype: film, also: [] });
    expect(prototypeBuild([ws('Texts', 'Write the manifest.')], [film, manifest])).toEqual({ none: true });
    // another workstream that mentions prototypes all the same
    const w3 = ws('Clean up', 'Delete the other prototype.');
    expect(prototypeBuild([w2, w3], [film, manifest])).toEqual({ workstream: w2, prototype: film, also: [w3] });
    // a prototype alone needs no name
    expect(prototypeBuild([w1, ws('Build the page', 'On the prototype.')], [film])).toMatchObject({ prototype: film });
  });

  test('none where no workstream mentions a prototype; unclear where several name one, one names several, or one mentions one without naming which', () => {
    expect(prototypeBuild([ws('Licence'), ws('Page')], [film, manifest])).toEqual({ none: true });
    expect(prototypeBuild([ws('Page', 'Like “Film first”'), ws('Texts', 'As in “Manifest”')], [film, manifest])).toMatchObject({ unclear: 'several' });
    expect(prototypeBuild([ws('Page', '“Film first”, then “Manifest”')], [film, manifest])).toMatchObject({ unclear: 'many' });
    expect(prototypeBuild([ws('Page', 'On the chosen prototype')], [film, manifest])).toMatchObject({ unclear: 'unnamed' });
    expect(prototypeBuild([ws('Page', 'On the prototype'), ws('Clean up', 'Delete the prototypes')], [film])).toMatchObject({ unclear: 'several' });
    // two of the same variant are told apart by their titles
    const again = card({ title: 'Prototype: Site – Film first (2)', variant: 'Film first' });
    expect(prototypeBuild([ws('Page', 'On “Film first (2)”')], [film, again])).toMatchObject({ prototype: again });
  });
});
