import { expect, test } from 'bun:test';
import { aliasesOf, Harnesses } from './harnesses';

test('a group without a harness of its own runs on Claude Code, unless only Codex is ready; Codex counts once a look says so', async () => {
  let claude: { version: string; loggedIn: boolean } | null = { version: '2.1.300', loggedIn: true };
  const h = new Harnesses({ cwd: '/tmp', claude: async () => claude, codex: async () => ({ version: '0.159.2', loggedIn: true }), codexModels: async () => [] });
  expect([h.ready('claude'), h.ready('codex'), h.preferred()]).toEqual([true, false, 'claude']);
  let changes = 0;
  h.onChange(() => changes++);
  await h.refresh();
  expect([h.ready('claude'), h.ready('codex'), h.preferred()]).toEqual([true, true, 'claude']);
  claude = null;
  await h.refresh();
  expect(h.preferred()).toBe('codex');
  // the same look again changes nothing
  await h.refresh();
  expect(changes).toBe(2);
});

test("the configuration's harnesses: Claude Code's aliases, Codex's models without a default of their own, none while Codex is not ready", async () => {
  let asked = 0;
  const h = new Harnesses({
    cwd: '/tmp',
    codexModels: async () => (asked++, [{ id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', isDefault: true, efforts: ['low', 'high'] }, { id: 'gpt-6-luna', name: 'GPT-6-Luna' }]),
  });
  h.set({ codex: null });
  const before = await h.view();
  expect(before[1]).toEqual({ id: 'codex', ready: false, models: [] });
  expect(before[0]!.models.map((m) => m.id)).toEqual(['fable', 'opus', 'sonnet', 'haiku']);
  h.set({ codex: { version: '0.159.2', loggedIn: true } });
  const [, codex] = await h.view();
  expect(codex).toEqual({
    id: 'codex',
    ready: true,
    version: '0.159.2',
    models: [
      { id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', isDefault: true, efforts: ['low', 'high'] },
      { id: 'gpt-6-luna', name: 'GPT-6-Luna' },
    ],
  });
  // asked once for a while
  await h.view();
  expect(asked).toBe(1);
});

test("Claude Code's aliases go with the model each stands for, asked in the background and again once Claude Code changed", async () => {
  let asked = 0;
  let opus = 'claude-opus-5-5';
  const h = new Harnesses({ cwd: '/tmp', claudeAliases: async () => (asked++, { opus, haiku: 'claude-haiku-4-5-20251001' }) });
  h.set({ claude: { version: '2.1.300', loggedIn: true }, codex: null });
  // the menus do not wait for Claude Code: the first answer comes with a later look
  await Bun.sleep(0);
  const [claude] = await h.view();
  expect(claude!.models).toEqual([{ id: 'fable' }, { id: 'opus', resolved: 'claude-opus-5-5' }, { id: 'sonnet' }, { id: 'haiku', resolved: 'claude-haiku-4-5-20251001' }]);
  await h.view();
  expect(asked).toBe(1);
  opus = 'claude-opus-5-6';
  h.set({ claude: { version: '2.1.301', loggedIn: true } });
  await Bun.sleep(0);
  expect((await h.view())[0]!.models[1]).toEqual({ id: 'opus', resolved: 'claude-opus-5-6' });
  expect(asked).toBe(2);
});

test("an alias stands for the model Claude Code lists under it, else for the newest of its family it lists", () => {
  expect(
    aliasesOf([
      { value: 'default', resolvedModel: 'claude-opus-5-5' },
      { value: 'opus', resolvedModel: 'claude-opus-5-5' },
      { value: 'claude-fable-5', resolvedModel: 'claude-fable-5' },
      { value: 'claude-fable-5-1', resolvedModel: 'claude-fable-5-1' },
      { value: 'claude-opus-5-6' },
      { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001' },
    ]),
  ).toEqual({ fable: 'claude-fable-5-1', opus: 'claude-opus-5-5', haiku: 'claude-haiku-4-5-20251001' });
});
