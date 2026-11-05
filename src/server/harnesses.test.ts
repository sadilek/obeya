import { expect, test } from 'bun:test';
import { Harnesses, newestOfFamilies } from './harnesses';

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

test("the Konfiguration's harnesses: Claude Code's aliases, Codex's models without a default of their own, none while Codex is not ready", async () => {
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

test("of each family of Codex's models only the newest version is offered, and the default", () => {
  const ids = ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6.1-terra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.10-codex', 'gpt-5.9-codex', 'gpt-5.1-codex-max', 'o3'];
  expect(newestOfFamilies(ids.map((id) => ({ id }))).map((m) => m.id)).toEqual(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6.1-terra', 'gpt-6-luna', 'gpt-5.10-codex', 'gpt-5.1-codex-max', 'o3']);
  // the model Codex runs by default stays, old or not
  expect(newestOfFamilies([{ id: 'gpt-6.1-sol' }, { id: 'gpt-5.6-sol', isDefault: true }]).map((m) => m.id)).toEqual(['gpt-6.1-sol', 'gpt-5.6-sol']);
});
