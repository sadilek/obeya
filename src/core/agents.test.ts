import { expect, test } from 'bun:test';
import { cardAgentOf, codexFamily, codexFamilyName, type HarnessView, modelChoices, modelFits, modelName, modelVersion, newestOfFamilies } from './agents';

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
