import { expect, test } from 'bun:test';
import { Harnesses } from './harnesses';

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

test("the Konfiguration's harnesses: Claude Code's aliases, Codex's models with its default by name, none while Codex is not ready", async () => {
  let asked = 0;
  const h = new Harnesses({
    cwd: '/tmp',
    codexModels: async () => (asked++, [{ id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', isDefault: true, efforts: ['low', 'high'] }, { id: 'gpt-6-luna', name: 'GPT-6-Luna' }]),
  });
  h.set({ codex: null });
  const before = await h.view();
  expect(before[1]).toEqual({ id: 'codex', ready: false, models: [{ id: 'default' }] });
  expect(before[0]!.models.map((m) => m.id)).toEqual(['default', 'fable', 'opus', 'sonnet', 'haiku']);
  h.set({ codex: { version: '0.159.2', loggedIn: true } });
  const [, codex] = await h.view();
  expect(codex).toEqual({
    id: 'codex',
    ready: true,
    version: '0.159.2',
    models: [
      { id: 'default', name: 'GPT-6.1-Sol', efforts: ['low', 'high'] },
      { id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', isDefault: true, efforts: ['low', 'high'] },
      { id: 'gpt-6-luna', name: 'GPT-6-Luna' },
    ],
  });
  // asked once for a while
  await h.view();
  expect(asked).toBe(1);
});
