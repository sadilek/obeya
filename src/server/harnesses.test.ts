import { expect, test } from 'bun:test';
import type { HarnessHost } from '../core/types';
import { aliasesOf, type HostHarness, type ClaudeListed, Harnesses, hostClaude } from './harnesses';
import { registerHost } from './hosts';

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
  const h = new Harnesses({
    cwd: '/tmp',
    claudeModels: async () => (asked++, [{ value: 'opus', resolvedModel: opus }, { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001' }]),
  });
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

test('an alias stands for the newest of its family Claude Code lists, by its id or under the alias', () => {
  expect(
    aliasesOf([
      { value: 'default', resolvedModel: 'claude-opus-5-5' },
      { value: 'opus', resolvedModel: 'claude-opus-5-5' },
      { value: 'claude-fable-5-2', resolvedModel: 'claude-fable-5-2' },
      { value: 'fable', resolvedModel: 'claude-fable-5-1' },
      { value: 'claude-fable-5', resolvedModel: 'claude-fable-5' },
      { value: 'claude-opus-5' },
      { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001' },
    ]),
  ).toEqual({ fable: 'claude-fable-5-2', opus: 'claude-opus-5-5', haiku: 'claude-haiku-4-5-20251001' });
});

test("an agent on an alias is given the newer model of its family that Claude Code lists by its id, else the alias", async () => {
  const h = new Harnesses({
    cwd: '/tmp',
    claudeModels: async () => [
      { value: 'opus', resolvedModel: 'claude-opus-5-5' },
      { value: 'claude-fable-5-2', resolvedModel: 'claude-fable-5-2' },
      { value: 'fable', resolvedModel: 'claude-fable-5-1' },
      { value: 'claude-sonnet-5-5' },
    ],
  });
  // before Claude Code has said, every alias goes as it is
  expect(h.claudeModel('fable')).toBe('fable');
  h.set({ claude: { version: '2.1.318', loggedIn: true }, codex: null });
  await Bun.sleep(0);
  expect([h.claudeModel('fable'), h.claudeModel('opus'), h.claudeModel('sonnet'), h.claudeModel('haiku'), h.claudeModel('default')]).toEqual([
    'claude-fable-5-2',
    'opus',
    // listed by its id only, under no alias
    'claude-sonnet-5-5',
    'haiku',
    'default',
  ]);
  expect((await h.view())[0]!.models[0]).toEqual({ id: 'fable', resolved: 'claude-fable-5-2' });
});

test('a newer Claude Code that is out is offered as an update, which runs in the background and brings the new version and its models', async () => {
  let version = '2.1.285';
  let updates = 0;
  let finish = () => {};
  const h = new Harnesses({
    cwd: '/tmp',
    claude: async () => ({ version, loggedIn: true }),
    codex: async () => null,
    claudeModels: async () => (version === '2.1.285' ? [{ value: 'fable', resolvedModel: 'claude-fable-5-1' }] : [{ value: 'fable', resolvedModel: 'claude-fable-5-1' }, { value: 'claude-fable-5-2' }]),
    claudeNewest: async () => '2.1.322',
    updateClaude: () => (updates++, new Promise<void>((done) => (finish = () => ((version = '2.1.322'), done())))),
  });
  // npm is asked in the background as Claude Code is first looked at: no view waits for it
  await h.refresh();
  await Bun.sleep(0);
  expect((await h.view())[0]!.update).toEqual({ version: '2.1.322' });
  h.update('claude');
  // a second click while it runs starts no second update
  h.update('claude');
  expect((await h.view())[0]!.update).toEqual({ version: '2.1.322', running: true });
  finish();
  for (let i = 0; i < 20 && (await h.view())[0]!.update; i++) await Bun.sleep(1);
  const [claude] = await h.view();
  expect([claude!.version, claude!.update, claude!.models[0]]).toEqual(['2.1.322', undefined, { id: 'fable', resolved: 'claude-fable-5-2' }]);
  expect(updates).toBe(1);
});

test('an update that fails says why, and is offered again', async () => {
  const h = new Harnesses({
    cwd: '/tmp',
    claude: async () => ({ version: '2.1.300', loggedIn: true }),
    codex: async () => null,
    claudeNewest: async () => '2.1.322',
    updateClaude: async () => {
      throw new Error('claude update exited with 1: no network');
    },
  });
  await h.refresh();
  await h.view();
  await Bun.sleep(0);
  h.update('claude');
  for (let i = 0; i < 20 && (await h.view())[0]!.update?.running; i++) await Bun.sleep(1);
  expect((await h.view())[0]!.update).toEqual({ version: '2.1.322', error: 'claude update exited with 1: no network' });
});

test('a newer Codex that is out is offered as an update, after which the menus have the new version and its models', async () => {
  let version = '0.159.2';
  let finish = () => {};
  let updates = 0;
  const h = new Harnesses({
    cwd: '/tmp',
    claude: async () => ({ version: '2.1.338', loggedIn: true }),
    codex: async () => ({ version, loggedIn: true }),
    codexModels: async () => (version === '0.159.2' ? [{ id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol' }] : [{ id: 'gpt-6.2-sol', name: 'GPT-6.2-Sol' }, { id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol' }]),
    claudeNewest: async () => '2.1.338',
    codexNewest: async () => '0.167.0',
    updateCodex: () => (updates++, new Promise<void>((done) => (finish = () => ((version = '0.167.0'), done())))),
  });
  await h.refresh();
  await Bun.sleep(0);
  const [claude, codex] = await h.view();
  // only Codex is behind
  expect([claude!.update, codex!.update, codex!.models.map((m) => m.id)]).toEqual([undefined, { version: '0.167.0' }, ['gpt-6.1-sol']]);
  h.update('codex');
  h.update('codex');
  expect((await h.view())[1]!.update).toEqual({ version: '0.167.0', running: true });
  finish();
  for (let i = 0; i < 20 && (await h.view())[1]!.update; i++) await Bun.sleep(1);
  const after = (await h.view())[1]!;
  expect([after.version, after.update, after.models.map((m) => m.id)]).toEqual(['0.167.0', undefined, ['gpt-6.2-sol']]);
  expect(updates).toBe(1);
});

test('Codex is not asked about updates where it is not installed, and a Codex at the newest has none', async () => {
  let asked = 0;
  const h = new Harnesses({ cwd: '/tmp', claude: async () => null, codex: async () => null, codexNewest: async () => (asked++, '0.167.0') });
  await h.refresh();
  await Bun.sleep(0);
  expect([(await h.view())[1]!.update, asked]).toEqual([undefined, 0]);
  h.set({ codex: { version: '0.167.0', loggedIn: true } });
  await Bun.sleep(0);
  expect([(await h.view())[1]!.update, asked]).toEqual([undefined, 1]);
});

test("a host's Codex that is behind gets a line of its own and is updated there; its Claude Code is another", async () => {
  let codexThere = '0.159.2';
  let updated = 0;
  const codexHost: HostHarness = {
    name: 'box',
    harness: 'codex',
    reachable: () => true,
    look: async () => ({ version: codexThere }),
    update: async () => void (updated++, (codexThere = '0.167.0')),
  };
  const claudeHost = fakeHost('box', { version: '2.1.338' });
  const h = new Harnesses({
    cwd: '/tmp',
    claude: async () => ({ version: '2.1.338', loggedIn: true }),
    codex: async () => ({ version: '0.167.0', loggedIn: true }),
    codexModels: async () => [],
    claudeNewest: async () => '2.1.338',
    codexNewest: async () => '0.167.0',
    hosts: () => [claudeHost.claude, codexHost],
  });
  await h.refresh();
  const codexOf = async () => (await h.view())[1]!.hosts ?? [];
  for (let i = 0; i < 50 && !(await codexOf())[0]?.update; i++) await Bun.sleep(1);
  expect(await codexOf()).toEqual([{ name: 'box', version: '0.159.2', update: { version: '0.167.0' } }]);
  expect((await h.view())[0]!.hosts).toEqual([{ name: 'box', version: '2.1.338' }]);
  h.update('codex', 'box');
  for (let i = 0; i < 50 && (await codexOf())[0]?.update; i++) await Bun.sleep(1);
  expect([await codexOf(), updated, claudeHost.updates]).toEqual([[{ name: 'box', version: '0.167.0' }], 1, 0]);
});

/** A host's Claude Code as `Harnesses` asks it, at `version` there, listing `models`. */
function fakeHost(name: string, o: { version: string | null; channel?: 'latest' | 'stable'; models?: ClaudeListed[]; newest?: string }) {
  const host: typeof o & { up: boolean; looks: number; updates: number; claude: HostHarness } = {
    ...o,
    up: true,
    looks: 0,
    updates: 0,
    claude: {
      name,
      harness: 'claude',
      reachable: () => host.up,
      look: async () => {
        host.looks++;
        if (!host.up) throw new Error(`${name}: Connection refused`);
        return host.version === null ? null : { version: host.version, channel: host.channel ?? 'latest' };
      },
      models: async () => host.models ?? [],
      update: async () => {
        host.updates++;
        host.version = host.newest ?? host.version;
      },
    },
  };
  return host;
}

/** Until the view's hosts satisfy `ok`, a millisecond at a time. */
async function viewUntil(h: Harnesses, ok: (hosts: HarnessHost[]) => boolean) {
  for (let i = 0; i < 50; i++) {
    const hosts = (await h.view())[0]!.hosts ?? [];
    if (ok(hosts)) return hosts;
    await Bun.sleep(1);
  }
  throw new Error(`the view's hosts: ${JSON.stringify((await h.view())[0]!.hosts)}`);
}

test("a host whose Claude Code is behind its channel's newest says so in the view, and is updated there at a click", async () => {
  const box = fakeHost('box', { version: '2.1.300', channel: 'stable', newest: '2.1.322' });
  const current = fakeHost('current', { version: '2.1.338' });
  const none = fakeHost('none', { version: null });
  const asked: (string | undefined)[] = [];
  const h = new Harnesses({
    cwd: '/tmp',
    claude: async () => ({ version: '2.1.338', loggedIn: true }),
    codex: async () => null,
    claudeNewest: async (channel) => (asked.push(channel), channel === 'stable' ? '2.1.322' : '2.1.338'),
    hosts: () => [box.claude, current.claude, none.claude],
  });
  await h.refresh();
  // looked at in the background: the first view has none of them yet
  expect((await h.view())[0]!.hosts).toBeUndefined();
  const hosts = await viewUntil(h, (hosts) => !!hosts.find((x) => x.name === 'box')?.update);
  // a host without Claude Code is not listed; one at the newest of its channel has no update
  expect(hosts).toEqual([{ name: 'box', version: '2.1.300', update: { version: '2.1.322' } }, { name: 'current', version: '2.1.338' }]);
  // this machine's channel, read here, and the host's own
  expect(asked).toContain(undefined);
  expect(asked).toContain('stable');
  expect((await h.view())[0]!.update).toBeUndefined();
  h.update('claude', 'box');
  expect((await h.view())[0]!.hosts![0]!.update).toEqual({ version: '2.1.322', running: true });
  const after = await viewUntil(h, (hosts) => !hosts[0]!.update);
  expect(after[0]).toEqual({ name: 'box', version: '2.1.322' });
  expect([box.updates, current.updates]).toEqual([1, 0]);
});

test('a host that does not answer is looked at again once it does, and one the configuration no longer names goes', async () => {
  const box = fakeHost('box', { version: '2.1.300' });
  box.up = false;
  let named = [box.claude];
  const h = new Harnesses({ cwd: '/tmp', claude: async () => ({ version: '2.1.338', loggedIn: true }), codex: async () => null, claudeNewest: async () => '2.1.338', hosts: () => named });
  await h.refresh();
  await h.view();
  expect(box.looks).toBe(0);
  box.up = true;
  await viewUntil(h, (hosts) => hosts.length === 1);
  expect(box.looks).toBe(1);
  named = [];
  expect((await h.view())[0]!.hosts).toBeUndefined();
});

test("an agent on a host is given the newest of its alias's family that the host's Claude Code lists", async () => {
  const box = fakeHost('box', { version: '2.1.338', models: [{ value: 'fable', resolvedModel: 'claude-fable-5-1' }, { value: 'claude-fable-5-2' }] });
  const old = fakeHost('old', { version: '2.1.300', models: [{ value: 'fable', resolvedModel: 'claude-fable-5-1' }] });
  const h = new Harnesses({
    cwd: '/tmp',
    claude: async () => ({ version: '2.1.338', loggedIn: true }),
    codex: async () => null,
    claudeModels: async () => [{ value: 'fable', resolvedModel: 'claude-fable-5-1' }],
    hosts: () => [box.claude, old.claude],
  });
  await h.refresh();
  for (let i = 0; i < 50 && h.claudeModel('fable', 'box') === 'fable'; i++) await (h.view(), Bun.sleep(1));
  expect([h.claudeModel('fable', 'box'), h.claudeModel('fable', 'old'), h.claudeModel('fable'), h.claudeModel('fable', 'unknown')]).toEqual(['claude-fable-5-2', 'fable', 'fable', 'fable']);
});

test("a host's Claude Code is one and the same for as long as the host is", () => {
  const host = registerHost({ name: `same-${Math.random().toString(36).slice(2, 8)}`, ssh: 'me@box', home: '/tmp' });
  expect(hostClaude(host)).toBe(hostClaude(host));
});
