// Checks a compiled Obeya (`bun run build`) on this machine, the way someone without Bun or a
// checkout would use it: a scratch repository with its own adapter (`.obeya/adapter/`) and share
// command, the binary started as `obeya` starts (supervised), and then what it hands to other
// processes. Runs on macOS, Linux and Windows.
//
//   bun scripts/check-binary.ts <obeya> [--voice] [--demo] [--worker] [--port <n>] [--keep]
//
// Always: the canvas answers, the settings show the version and no checkout, the repository's own
// adapter loads, the demo setup finds Playwright among the resources, and a script run with the
// binary's Bun (`BUN_BE_BUN`) imports the adapter kit. --voice installs Piper and Whisper through
// the settings, speaks a sentence in the demo voice (tts.py from the resources) and gives it to
// Obeya as a voice command; what Whisper heard must match. --demo renders a short demo of the
// canvas with the skill's director from the resources (Node, a browser, ffmpeg and uv needed).
// --worker starts a card with a real agent on the Claude Code `OBEYA_CLAUDE` names, else the
// machine's own, which commits a file and hands over an HTML artifact that is then shared through
// the repository's share command. The Koordinator's answer to the voice command needs a Claude
// login as well; without --worker it is not waited for. Prints one line per check; exits 1 when
// one failed. --keep leaves the scratch directory and the server running.

import { type Subprocess } from 'bun';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pkg from '../package.json';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const binaryArg = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--port');
if (!binaryArg) {
  console.error('usage: bun scripts/check-binary.ts <obeya> [--voice] [--demo] [--worker] [--port <n>] [--keep]');
  process.exit(2);
}
const binary = resolve(binaryArg);
const resources = join(dirname(binary), 'resources');
const port = Number(opt('port') ?? 4499);
const base = `http://127.0.0.1:${port}`;
const win = process.platform === 'win32';

let failed = 0;
const ok = (what: string, detail = '') => console.log(`✓ ${what}${detail ? `: ${detail}` : ''}`);
const bad = (what: string, detail: string) => {
  failed++;
  console.log(`✗ ${what}: ${detail}`);
};
const check = async (what: string, fn: () => Promise<string | void> | string | void) => {
  const started = performance.now();
  try {
    const detail = await fn();
    ok(what, [detail, `${((performance.now() - started) / 1000).toFixed(1)} s`].filter(Boolean).join(', '));
  } catch (e) {
    bad(what, e instanceof Error ? e.message : String(e));
  }
};
const expect = (cond: unknown, why: string) => {
  if (!cond) throw new Error(why);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, ms: number, fn: () => Promise<T | undefined | null | false>): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`${what}: not within ${Math.round(ms / 1000)} s`);
    await sleep(2000);
  }
}
const api = async (path: string, init?: RequestInit & { json?: unknown }) => {
  const res = await fetch(`${base}${path}`, {
    ...init,
    ...(init?.json !== undefined ? { method: init.method ?? 'POST', body: JSON.stringify(init.json), headers: { 'content-type': 'application/json' } } : {}),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path}: ${res.status} ${await res.text()}`);
  return res;
};
const json = async <T = any>(path: string, init?: RequestInit & { json?: unknown }) => (await (await api(path, init)).json()) as T;

// the scratch repository: a plan doc, its own adapter and a share command that imports the kit
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'obeya-check-')));
const repo = join(dir, 'repo');
const home = join(dir, 'home');
const files: Record<string, string> = {
  'README.md': '# Scratch\n',
  'docs/plan/tool.md': '# Tool\n\n## Workstreams\n\n- [ ] **W1:** Configuration.\n',
  '.obeya/adapter/index.ts': "export default (kit) => ({ name: 'own', demo: { howToRun: `Nothing to run; ${kit.esc('<generic>')}` } });\n",
  'share.ts': `const kit = await import(process.env.OBEYA_KIT);
if (process.argv[2] !== 'publish') process.exit(process.argv[2] === 'version' ? 1 : 0);
const page = JSON.parse(await Bun.stdin.text());
await Bun.write(\`\${process.env.OBEYA_HOME}/shared-\${page.slug}.txt\`, kit.esc('<' + page.slug + '>'));
console.log(\`https://demos.example/\${page.slug}/\`);
`,
};
for (const [path, text] of Object.entries(files)) {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
}
const git = (...a: string[]) => {
  const r = Bun.spawnSync(['git', '-c', 'user.name=Check', '-c', 'user.email=check@example.com', '-C', repo, ...a], { stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};
git('init', '-q', '-b', 'main');
git('add', '-A');
git('commit', '-qm', 'init');
mkdirSync(home, { recursive: true });
const configFile = join(home, 'canvases.json');
writeFileSync(configFile, JSON.stringify([{ name: 'Check', repos: [{ path: repo, clones: 1, share: 'share.ts' }] }], null, 2));
writeFileSync(join(home, 'settings.json'), JSON.stringify({ language: 'en' }));
writeFileSync(join(home, 'demo.json'), JSON.stringify({ language: 'en', voice: 'piper' }));

// the binary, supervised as `obeya` runs without --dev
const log = join(dir, 'server.log');
const env = { ...process.env, OBEYA_HOME: home, OBEYA_SUPERVISED: undefined };
let server: Subprocess | undefined;
const logText = () => readFileSync(log, 'utf8');
const stop = () => {
  if (!server) return;
  if (win) Bun.spawnSync(['taskkill', '/pid', String(server.pid), '/T', '/F'], { stdout: 'ignore', stderr: 'ignore' });
  else
    try {
      process.kill(-server.pid, 'SIGKILL');
    } catch {}
};
process.on('exit', () => {
  if (!args.includes('--keep')) {
    stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

await check(`Obeya ${pkg.version} starts from ${binary}`, async () => {
  server = Bun.spawn([binary, '--port', String(port)], { cwd: dir, env, stdout: Bun.file(log), stderr: Bun.file(log), detached: !win });
  await until('the canvas answers', 60_000, async () => (await fetch(`${base}/api/canvases`)).ok);
  return logText().split('\n')[0];
});
const canvas = 'check';

await check('the settings show the version and no checkout; the repository has its own adapter', async () => {
  const view = await json('/api/config');
  expect(view.server.version === pkg.version, `version ${view.server.version}`);
  expect(view.server.commit === null, `commit ${view.server.commit}`);
  expect(view.server.restarts, 'not supervised');
  const adapter = view.resolved[0]?.repos[0]?.adapter;
  expect(adapter === 'own', `adapter ${adapter} (${JSON.stringify(view.problems)})`);
  return `version ${view.server.version}, adapter ${adapter}`;
});

await check('the demo setup finds Playwright among the resources', async () => {
  const setup = await json('/api/demo-settings/setup', { json: { language: 'en', voice: 'piper' } });
  const items = Object.fromEntries((setup.items as { id: string; state: string; found?: string }[]).map((i) => [i.id, i]));
  expect(items.playwright?.state === 'ok', `playwright ${JSON.stringify(items.playwright)}`);
  return (setup.items as { id: string; state: string }[]).map((i) => `${i.id} ${i.state}`).join(', ');
});

await check("a script on the binary's Bun imports the adapter kit", async () => {
  const p = Bun.spawnSync([binary, join(repo, 'share.ts'), 'publish'], {
    cwd: dir,
    env: { ...env, BUN_BE_BUN: '1', OBEYA_KIT: join(resources, 'kit.js') },
    stdin: new TextEncoder().encode(JSON.stringify({ slug: 'kit' })),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(p.exitCode === 0, `exit ${p.exitCode}: ${p.stderr.toString()}`);
  expect(readFileSync(join(home, 'shared-kit.txt'), 'utf8') === '&lt;kit&gt;', 'the kit did not escape');
  return p.stdout.toString().trim();
});

if (args.includes('--voice')) {
  await check('voice: Whisper and Piper install from the settings', async () => {
    await api('/api/voice-setup/install', { method: 'POST' });
    const view = await until('the installation ends', 30 * 60_000, async () => {
      const v = await json('/api/voice-setup');
      return !v.job?.running && v;
    });
    expect(!view.job?.error, view.job?.error);
    const missing = (view.items as { id: string; state: string }[]).filter((i) => i.state !== 'ok');
    expect(!missing.length, `still missing: ${JSON.stringify(missing)}`);
    // the demo voice (Piper) too, which on a Mac is not the one confirmations are spoken in
    await api('/api/demo-settings/install', { json: { language: 'en', voice: 'piper' } });
    const done = await until('the demo voice is installed', 30 * 60_000, async () => /voice piper installed|installing the voice piper failed.*/.exec(logText())?.[0]);
    expect(!/failed/.test(done), done);
    return `${view.listen}, ${view.speech}`;
  });
  await check('voice: a sentence in the demo voice, heard as a command', async () => {
    const wav = await (await api('/api/demo-settings/sample', { json: { language: 'en', voice: 'piper' } })).arrayBuffer();
    const res = await json(`/api/c/${canvas}/voice`, { method: 'POST', body: wav, headers: { 'content-type': 'audio/wav' } });
    const heard = /heard on check: (.*)/.exec(logText())?.[1] ?? '';
    expect(/voice sounds/i.test(heard), `heard „${heard}“`);
    return `heard „${heard}“; Obeya answered „${res.confirm}“${res.audio ? ', spoken' : ''}`;
  });
}

if (args.includes('--demo')) {
  await check('demo: a render with the director from the resources', async () => {
    const demo = join(dir, 'demo');
    mkdirSync(demo);
    const director = join(resources, 'plugin', 'skills', 'demo', 'lib', 'director.ts');
    writeFileSync(
      join(demo, 'demo.ts'),
      `import { runDemo } from ${JSON.stringify(pathToFileURL(director).href)};
await runDemo(
  {
    title: 'Obeya from one file',
    baseUrl: ${JSON.stringify(base)},
    login: async (page) => { await page.goto(${JSON.stringify(`${base}/?c=${canvas}`)}); },
    open: async (d) => { await d.goto('/?c=${canvas}'); await d.page.getByText('Configuration').first().waitFor(); },
    scenes: [{ title: 'The canvas', say: 'This canvas is served by the compiled Obeya.', run: async (d) => { await d.untilSpoken(0.5); } }],
    report: { summary: 'A check render.', shown: ['The canvas'], notShown: [], findings: [], meta: {} },
  },
  import.meta.dirname,
);
`,
    );
    const p = Bun.spawnSync(['node', join(demo, 'demo.ts')], { cwd: demo, env, stdout: 'pipe', stderr: 'pipe' });
    const out = p.stdout.toString() + p.stderr.toString();
    expect(p.exitCode === 0, `exit ${p.exitCode}\n${out.slice(-3000)}`);
    expect(Bun.file(join(demo, 'demo.mp4')).size > 0, 'no demo.mp4');
    return out.split('\n').find((l) => /video →/.test(l))?.trim();
  });
}

if (args.includes('--worker')) {
  const artifact = join(dir, 'artifact');
  let card = '';
  await check('worker: a real agent commits and hands over an HTML artifact', async () => {
    const created = await json(`/api/c/${canvas}/cards`, {
      json: {
        title: 'Add hello.txt',
        body: `Create hello.txt containing "Hello from one file" and commit it. Then make an HTML artifact: ${artifact}/index.html with one heading "Hello". Hand over with ready_for_review, the artifact as the demo (kind html). Nothing else.`,
        x: 40,
        y: 300,
      },
    });
    card = created.id;
    await api(`/api/c/${canvas}/cards/${card}/act`, { json: { action: 'start' } });
    const item = await until('the card is handed over', 20 * 60_000, async () => {
      const it = (await json(`/api/c/${canvas}/canvas`)).items.find((i: { id: string }) => i.id === card);
      if (it?.state === 'waiting' && it.need === 'question') throw new Error(`the agent asks: ${JSON.stringify(it.question)}`);
      return it?.state === 'waiting' && it;
    });
    // the one clone of the canvas's one repository
    const workspaces = join(home, 'workspaces');
    const clone = join(workspaces, readdirSync(workspaces)[0]!, '1');
    const branchLog = Bun.spawnSync(['git', '-C', clone, 'log', '--oneline', '-1', '--', 'hello.txt'], { stdout: 'pipe' }).stdout.toString().trim();
    expect(branchLog, 'no commit with hello.txt in the clone');
    return `${item.need}; ${branchLog}`;
  });
  if (card)
    await check("worker: the artifact is shared through the repository's share command", async () => {
      await api(`/api/c/${canvas}/cards/${card}/act`, { json: { action: 'share' } });
      const events = await until('the page is shared', 120_000, async () => {
        const ev = (await json(`/api/c/${canvas}/cards/${card}/events`)) as { text?: string }[];
        return ev.some((e) => /https:\/\/demos\.example\//.test(e.text ?? '')) && ev;
      });
      return events.map((e) => e.text ?? '').find((t) => /demos\.example/.test(t));
    });
}

console.log(failed ? `${failed} check(s) failed; the server's log:\n${logText().slice(-4000)}` : 'all checks passed');
if (args.includes('--keep')) console.log(`kept: ${dir} (server pid ${server?.pid}, port ${port})`);
process.exit(failed ? 1 : 0);
