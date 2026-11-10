import { describe, expect, test } from 'bun:test';
import { CLONES, cardAgentOf, codexFamily, codexFamilyName, modelFits, type FilledClones, type HarnessView, type Item, modelChoices, modelName, modelVersion, nearestEffort, newestOfFamilies, resolveCodexModel, openPerGroup, type ResolvedCanvas, stoppedArchivable, type Talk, unreadPerProject, withClones, withSupplemented, prototypeBuild, prototypeName } from './types';

const card = (over: Partial<Item>): Item => ({ id: 'x', number: 1, kind: 'task', state: 'planned', title: '', body: '', x: 0, y: 0, source: 'manual', repo: 'r', ...over });

describe('openPerGroup', () => {
  test('counts the cards still to be done, a project by its workstreams', () => {
    const open = openPerGroup([
      card({ group: 'a', state: 'working' }),
      card({ group: 'a', state: 'waiting' }),
      card({ group: 'a', state: 'live' }),
      card({ group: 'a', state: 'done' }),
      card({ group: 'a', archivedAt: '2026-10-01' }),
      card({ group: 'a', state: 'idea', idea: { status: 'dropped', brief: '', thinking: false, yourTurn: false, questions: [], variants: [], mocks: [] } }),
      card({ group: 'b', kind: 'project' }),
      card({ group: 'b', parent: 'p', state: 'planned' }),
      card({ group: 'c', state: 'live' }),
      card({ state: 'working' }),
    ]);
    expect([...open]).toEqual([
      ['a', 2],
      ['b', 1],
    ]);
    // a group whose cards are all done has none open
    expect(open.get('c')).toBeUndefined();
  });
});

test("a project's card counts its agent's answers that wait unread, asked in its sheet", () => {
  const talk = (over: Partial<Talk>): Talk => ({ id: 1, at: '2026-10-29T09:00:00Z', said: '', ...over });
  const unread = unreadPerProject([
    talk({ askedIn: 'p', answer: 'W2 first.', unread: true }),
    talk({ askedIn: 'p', answer: 'Yes.', unread: true }),
    talk({ askedIn: 'q', answer: 'Read already.' }),
    // asked of Obeya: its button counts it, not the project's card
    talk({ question: 'What is left?', answer: 'W3.', unread: true }),
  ]);
  expect([...unread]).toEqual([['p', 2]]);
});

describe('withClones', () => {
  const at = (...workspaces: ('clones' | 'worktrees')[]): ResolvedCanvas => ({ id: 'c', name: 'c', repos: workspaces.map((w) => ({ id: 'r', workspaces: w, values: {} as never, shareTo: 'main' })) });

  test('fills in a repository added in clones, once per path', () => {
    const saved = [{ repos: [{ path: '/a' }] }];
    const filled = new Map() as FilledClones;
    const draft = [{ repos: [{ path: '/a' }, { path: '/b' }] }];
    const next = withClones(draft, saved, [at('clones', 'clones')], filled);
    expect(next).toEqual([{ repos: [{ path: '/a' }, { path: '/b', clones: CLONES }] }]);
    // emptied again, it stays empty
    expect(withClones([{ repos: [{ path: '/a' }, { path: '/b' }] }], saved, [at('clones', 'clones')], filled)).toBeNull();
  });

  test('takes its own count out again once existing clones are listed, and brings it back when they go', () => {
    const filled = new Map() as FilledClones;
    const resolved = [at('clones')];
    const added = withClones([{ repos: [{ path: '/b' }] }], [], resolved, filled)!;
    expect(added[0]!.repos[0]!.clones).toBe(CLONES);
    // two existing clones beside it would make four: the dialog's 2 goes
    const listed = withClones([{ repos: [{ path: '/b', clones: CLONES, workspaces: ['/b2', '/b3'] }] }], [], resolved, filled);
    expect(listed).toEqual([{ repos: [{ path: '/b', workspaces: ['/b2', '/b3'] }] }]);
    // a blank line lists none
    expect(withClones([{ repos: [{ path: '/b', workspaces: ['/b2'] }] }], [], resolved, filled)).toBeNull();
    expect(withClones([{ repos: [{ path: '/b', workspaces: [' '] }] }], [], resolved, filled)).toEqual([{ repos: [{ path: '/b', workspaces: [' '], clones: CLONES }] }]);
  });

  test('never touches a count the owner typed or changed', () => {
    const resolved = [at('clones')];
    // typed before listing existing ones
    const typed = new Map() as FilledClones;
    withClones([{ repos: [{ path: '/b' }] }], [], resolved, typed);
    expect(withClones([{ repos: [{ path: '/b', clones: 3 }] }], [], resolved, typed)).toBeNull();
    expect(withClones([{ repos: [{ path: '/b', clones: 3, workspaces: ['/b2'] }] }], [], resolved, typed)).toBeNull();
    // typed while the dialog's count was out for existing clones
    const back = new Map() as FilledClones;
    withClones([{ repos: [{ path: '/b' }] }], [], resolved, back);
    withClones([{ repos: [{ path: '/b', clones: CLONES, workspaces: ['/b2'] }] }], [], resolved, back);
    expect(withClones([{ repos: [{ path: '/b', clones: 1, workspaces: ['/b2'] }] }], [], resolved, back)).toBeNull();
    expect(withClones([{ repos: [{ path: '/b', clones: 1 }] }], [], resolved, back)).toBeNull();
    // listed before the path was checked: nothing is filled in, and emptying the list fills it in
    const first = new Map() as FilledClones;
    expect(withClones([{ repos: [{ path: '/b', workspaces: ['/b2'] }] }], [], resolved, first)).toBeNull();
    expect(withClones([{ repos: [{ path: '/b', workspaces: [] }] }], [], resolved, first)).toEqual([{ repos: [{ path: '/b', workspaces: [], clones: CLONES }] }]);
  });

  test('leaves worktrees, counts of its own and repositories not checked yet', () => {
    const draft = [{ repos: [{ path: '/w' }, { path: '/n', clones: 0 }, { path: '/l', workspaces: ['/x'] }, { path: '' }] }, { repos: [{ path: '/u' }] }];
    expect(withClones(draft, [], [at('worktrees', 'clones', 'clones', 'clones'), null], new Map())).toBeNull();
  });
});

test('a stopped task goes into the archive while nothing waits to start it and its workspace holds no work', () => {
  const stoppedTask = { kind: 'task', state: 'planned', branch: 'obeya/x', source: 'manual' } as const;
  expect(stoppedArchivable(stoppedTask)).toBe(true);
  expect(stoppedArchivable({ ...stoppedTask, branch: undefined })).toBe(false);
  expect(stoppedArchivable({ ...stoppedTask, workspace: '/clones/1' })).toBe(false);
  expect(stoppedArchivable({ ...stoppedTask, queue: { checking: true, since: '' } })).toBe(false);
  expect(stoppedArchivable({ ...stoppedTask, source: 'plan' })).toBe(false);
  expect(stoppedArchivable({ ...stoppedTask, prototypeOf: 'idea' })).toBe(false);
});

describe('withSupplemented', () => {
  const demos = [{ n: 1 }, { n: 2, follows: 'supplements' as const }, { n: 3, follows: 'replaces' as const }, { n: 4, follows: 'supplements' as const }, { n: 5, follows: 'supplements' as const }, { n: 6 }];
  const along = (i: number) => withSupplemented(demos, i).map((d) => d.n);
  test('a demo takes along the ones it supplements, back to one recorded afresh', () => {
    expect(along(1)).toEqual([1, 2]);
    expect(along(4)).toEqual([3, 4, 5]);
  });
  test('a demo that supplements nothing goes alone', () => {
    expect(along(0)).toEqual([1]);
    expect(along(2)).toEqual([3]);
    expect(along(5)).toEqual([6]);
  });
});

test('modelName names Claude models by family and version, any other as its harness does', () => {
  expect(modelName('claude-opus-5-5')).toBe('Opus 5.5');
  expect(modelName('claude-sonnet-4-5-20250929')).toBe('Sonnet 4.5');
  expect(modelName('claude-opus-4-20250514')).toBe('Opus 4');
  expect(modelName('claude-3-5-haiku-20241022')).toBe('Haiku 3.5');
  expect(modelName('claude-fable-5-1[1m]')).toBe('Fable 5.1');
  expect(modelName('gpt-5.5')).toBe('gpt-5.5');
  expect(modelName('claude-next')).toBe('claude-next');
});

test("a Codex setting names a family: a model id is read as its family, `default` as the preset's (Sol)", () => {
  expect(codexFamily('gpt-6.1-sol')).toBe('gpt-#-sol');
  expect(codexFamily('gpt-#-sol')).toBe('gpt-#-sol');
  expect(codexFamily('gpt-5.1-codex-max')).toBe('gpt-#-codex-max');
  expect(codexFamily('o3')).toBe('o#');
  expect(codexFamily('codex-mini-latest')).toBe('codex-mini-latest');
  expect(codexFamily('default')).toBe('gpt-#-sol');
  // a family has one `#` where the version was, and is no Claude Code alias
  expect(['gpt-#-sol', 'gpt-6.1-sol', 'o#', 'default'].every((m) => modelFits('codex', m))).toBe(true);
  expect(['#', 'gpt-##-sol', 'gpt-#-#', 'opus', 'gpt 6 sol'].some((m) => modelFits('codex', m))).toBe(false);
  // a card's own choice stored with a model id or the default reads as the family; Claude Code's alias stays
  expect(cardAgentOf('{"harness":"codex","model":"gpt-6.1-terra","effort":"high"}')).toEqual({ harness: 'codex', model: 'gpt-#-terra', effort: 'high' });
  expect(cardAgentOf('{"harness":"codex","model":"default"}')).toEqual({ harness: 'codex', model: 'gpt-#-sol' });
  expect(cardAgentOf('{"harness":"claude","model":"default"}')).toEqual({ harness: 'claude', model: 'default' });
  expect(cardAgentOf('{"effort":"low"}')).toEqual({ effort: 'low' });
});

test("of each family of Codex's models only the newest version stands for it", () => {
  const ids = ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6.1-terra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.10-codex', 'gpt-5.9-codex', 'gpt-5.1-codex-max', 'o3'];
  expect(newestOfFamilies(ids.map((id) => ({ id }))).map((m) => m.id)).toEqual(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6.1-terra', 'gpt-6-luna', 'gpt-5.10-codex', 'gpt-5.1-codex-max', 'o3']);
  // the default is no entry of its own: an older version marked so goes too
  expect(newestOfFamilies([{ id: 'gpt-6.1-sol' }, { id: 'gpt-5.6-sol', isDefault: true as const }]).map((m) => m.id)).toEqual(['gpt-6.1-sol']);
});

test('a family runs on its newest model in the catalog, else on the default; on none in a catalog without either', () => {
  const catalog = [{ id: 'gpt-5.6-sol' }, { id: 'gpt-6.2-sol' }, { id: 'gpt-6.1-sol' }, { id: 'gpt-6-luna', isDefault: true as const }];
  expect(resolveCodexModel(catalog, 'gpt-#-sol')?.id).toBe('gpt-6.2-sol');
  // a model id stored before resolves as its family
  expect(resolveCodexModel(catalog, 'gpt-6.1-sol')?.id).toBe('gpt-6.2-sol');
  expect(resolveCodexModel(catalog, 'gpt-#-terra')?.id).toBe('gpt-6-luna');
  expect(resolveCodexModel([{ id: 'gpt-6-luna' }], 'gpt-#-terra')).toBeUndefined();
  expect(resolveCodexModel([], 'gpt-#-sol')).toBeUndefined();
});

test('an effort the model does not take becomes the nearest it takes, the higher of two as near', () => {
  expect(nearestEffort('max', ['low', 'medium', 'high', 'xhigh'])).toBe('xhigh');
  expect(nearestEffort('medium', ['low', 'high'])).toBe('high');
  expect(nearestEffort('low', ['medium', 'high'])).toBe('medium');
  expect(nearestEffort('high', ['low', 'high'])).toBe('high');
  expect(nearestEffort('max', undefined)).toBe('max');
});

test("both pickers offer Codex's families by name, the version apart, as Claude Code's aliases, with the efforts of the newest model, and a family no longer listed as chosen", () => {
  const codex: HarnessView = {
    id: 'codex',
    ready: true,
    models: [
      { id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', efforts: ['low', 'high'], isDefault: true },
      { id: 'gpt-6-luna', name: 'GPT-6-Luna' },
    ],
  };
  expect(modelChoices(codex, 'gpt-#-sol')).toEqual([
    { value: 'gpt-#-sol', name: 'Sol', version: '6.1', efforts: ['low', 'high'] },
    { value: 'gpt-#-luna', name: 'Luna', version: '6', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  ]);
  // a family named by its newest model has its version in the name already
  expect(modelChoices({ id: 'codex', ready: true, models: [{ id: 'o3', name: 'o3' }] })).toEqual([{ value: 'o#', name: 'o3', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] }]);
  expect(modelChoices(codex, 'gpt-#-terra').at(-1)).toEqual({ value: 'gpt-#-terra', name: 'Terra', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] });
  expect(codexFamilyName('gpt-#-codex-max')).toBe('Codex Max');
  // a family named only by its version goes by its newest model's name here
  expect(codexFamilyName('o#', 'o3')).toBe('o3');
  expect(codexFamilyName('gpt-#')).toBe('gpt');
  const claude: HarnessView = { id: 'claude', ready: true, models: [{ id: 'opus', resolved: 'claude-opus-5-5' }, { id: 'haiku' }] };
  expect(modelChoices(claude, 'default').map((c) => c.value)).toEqual(['opus', 'haiku', 'default']);
  // an alias with the version of the model it stands for here, once Claude Code has said
  expect(modelChoices(claude).map((c) => c.version)).toEqual(['5.5', undefined]);
  expect([modelVersion('claude-haiku-4-5-20251001'), modelVersion('gpt-6.1-sol'), modelVersion('opus')]).toEqual(['4.5', '6.1', undefined]);
});

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
