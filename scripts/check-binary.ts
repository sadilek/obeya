// Checks a compiled Obeya (`bun run build`) on this machine, the way someone without Bun or a
// checkout would use it: a scratch repository with its own settings (`.obeya/settings.json`) and
// demo site, the binary started as `obeya` starts (supervised), and then what it hands to other
// processes. Runs on macOS, Linux and Windows.
//
//   bun scripts/check-binary.ts <obeya> [--voice] [--demo] [--worker] [--port <n>] [--keep]
//
// Always: the canvas answers, the settings show the version and no checkout, the repository's own
// settings are read, the demo setup finds Playwright among the resources, and a script run with the
// binary's Bun (`BUN_BE_BUN`) runs. --voice installs Piper and Whisper through
// the settings, speaks a sentence in the demo voice (tts.py from the resources) and gives it to
// Obeya as a voice command; what Whisper heard must match. --demo renders a short demo of the
// canvas with the skill's director from the resources (Node, a browser, ffmpeg and uv needed).
// --worker starts a card with a real agent on the Claude Code `OBEYA_CLAUDE` names, else the
// machine's own, which commits a file and hands over an HTML artifact that is then shared on the
// repository's demo site (served from the scratch directory). The Koordinator's answer to the voice command needs a Claude
// login as well; without --worker it is not waited for. Prints one line per check; exits 1 when
// one failed. --keep leaves the scratch directory and the server running. With CHECK_ARTIFACTS set,
// a failed render leaves its screenshot and the server's log in that directory.

import { type Subprocess } from 'bun';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { loginLink, ownerHeaders } from '../src/server/owner';
import { pathToFileURL } from 'node:url';
import pkg from '../package.json';
import { check, expect, failed, until as untilEvery } from './check-harness';
import { opt } from './common';

const args = process.argv.slice(2);
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

// what is waited for here takes minutes: asked every 2 s
const until: typeof untilEvery = (what, ms, fn) => untilEvery(what, ms, fn, 2000);
const api = async (path: string, init?: RequestInit & { json?: unknown }) => {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: ownerHeaders(home),
    ...(init?.json !== undefined ? { method: init.method ?? 'POST', body: JSON.stringify(init.json), headers: { ...ownerHeaders(home), 'content-type': 'application/json' } } : {}),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path}: ${res.status} ${await res.text()}`);
  return res;
};
const json = async <T = any>(path: string, init?: RequestInit & { json?: unknown }) => (await (await api(path, init)).json()) as T;

// the scratch repository: a plan doc, its own settings with a demo site, and the site's deploy
// script, which copies the site to `deployed` under Obeya's home, where the site is served from
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'obeya-check-')));
const repo = join(dir, 'repo');
const home = join(dir, 'home');
const deployed = join(home, 'deployed');
const host = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch(req) {
    let path = decodeURIComponent(new URL(req.url).pathname);
    if (path.endsWith('/')) path += 'index.html';
    const file = join(deployed, path);
    return !path.includes('..') && existsSync(file) ? new Response(Bun.file(file)) : new Response('not found', { status: 404 });
  },
});
const siteUrl = `http://127.0.0.1:${host.port}/`;
const files: Record<string, string> = {
  'README.md': '# Scratch\n',
  'docs/plan/tool.md': '# Tool\n\n## Workstreams\n\n- [ ] **W1:** Configuration.\n',
  '.obeya/settings.json': `${JSON.stringify({ app: { run: 'Nothing to run.' }, demo: { site: { title: 'Check demos', url: siteUrl, deploy: 'deploy.ts {dir}' } } }, null, 2)}\n`,
  'deploy.ts': `import { cpSync, rmSync } from 'node:fs';
const out = process.env.OBEYA_HOME + '/deployed';
rmSync(out, { recursive: true, force: true });
cpSync(process.argv[2], out, { recursive: true });
console.log('deployed to ' + out);
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
writeFileSync(configFile, JSON.stringify([{ name: 'Check', repos: [{ path: repo, clones: 1 }] }], null, 2));
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
  await until('the canvas answers', 60_000, async () => (await fetch(`${base}/api/canvases`, { headers: ownerHeaders(home) })).ok);
  return logText().split('\n')[0];
});
const canvas = 'check';

await check('the settings show the version and no checkout; the repository has its own settings', async () => {
  const view = await json('/api/config');
  expect(view.server.version === pkg.version, `version ${view.server.version}`);
  expect(view.server.commit === null, `commit ${view.server.commit}`);
  expect(view.server.restarts, 'not supervised');
  const checked = await json('/api/config/check');
  const run = checked.resolved[0]?.repos[0]?.values.app.run;
  expect(run?.source === 'repository', `app.run ${JSON.stringify(run)} (${JSON.stringify(checked.problems)})`);
  return `version ${view.server.version}, app.run from the repository`;
});

await check('the demo setup finds Playwright among the resources', async () => {
  const setup = await json('/api/demo-settings/setup', { json: { language: 'en', voice: 'piper' } });
  const items = Object.fromEntries((setup.items as { id: string; state: string; found?: string }[]).map((i) => [i.id, i]));
  expect(items.playwright?.state === 'ok', `playwright ${JSON.stringify(items.playwright)}`);
  return (setup.items as { id: string; state: string }[]).map((i) => `${i.id} ${i.state}`).join(', ');
});

await check("the site's deploy script runs on the binary's Bun", async () => {
  const site = join(dir, 'site');
  mkdirSync(site, { recursive: true });
  writeFileSync(join(site, 'index.html'), 'Check');
  const p = Bun.spawnSync([binary, join(repo, 'deploy.ts'), site], { cwd: dir, env: { ...env, BUN_BE_BUN: '1' }, stdout: 'pipe', stderr: 'pipe' });
  expect(p.exitCode === 0, `exit ${p.exitCode}: ${p.stderr.toString()}`);
  expect(existsSync(join(deployed, 'index.html')), 'nothing deployed');
  // the site the worker's demo goes to starts empty
  rmSync(deployed, { recursive: true, force: true });
  return p.stdout.toString().trim();
});

if (args.includes('--voice')) {
  await check('voice: Whisper installs from the settings', async () => {
    await api('/api/voice-setup/install', { method: 'POST' });
    const view = await until('the installation ends', 30 * 60_000, async () => {
      const v = await json('/api/voice-setup');
      return !v.job?.running && v;
    });
    expect(!view.job?.error, view.job?.error);
    const missing = (view.items as { id: string; state: string }[]).filter((i) => i.state !== 'ok');
    expect(!missing.length, `still missing: ${JSON.stringify(missing)}`);
    // the demo voice (Piper) too, which speaks the sentence heard below
    await api('/api/demo-settings/install', { json: { language: 'en', voice: 'piper' } });
    const done = await until('the demo voice is installed', 30 * 60_000, async () => /voice piper installed|installing the voice piper failed.*/.exec(logText())?.[0]);
    expect(!/failed/.test(done), done);
    return view.listen;
  });
  await check('voice: a sentence in the demo voice, heard as a command', async () => {
    const wav = await (await api('/api/demo-settings/sample', { json: { language: 'en', voice: 'piper' } })).arrayBuffer();
    const res = await json(`/api/c/${canvas}/voice`, { method: 'POST', body: wav, headers: { 'content-type': 'audio/wav' } });
    const heard = /heard on check: (.*)/.exec(logText())?.[1] ?? '';
    expect(/voice sounds/i.test(heard), `heard „${heard}“`);
    return `heard „${heard}“; Obeya answered „${res.confirm}“`;
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
    login: async (page) => { await page.goto(${JSON.stringify(await loginLink(base, home, `/c/${canvas}`))}); },
    open: async (d) => { await d.goto('/c/${canvas}'); await d.page.getByText('Configuration').first().waitFor(); },
    scenes: [{ title: 'The canvas', say: 'This canvas is served by the compiled Obeya.', run: async (d) => { await d.untilSpoken(0.5); } }],
    report: { summary: 'A check render.', meta: {} },
  },
  import.meta.dirname,
);
`,
    );
    const p = Bun.spawnSync(['node', join(demo, 'demo.ts')], { cwd: demo, env, stdout: 'pipe', stderr: 'pipe' });
    const out = p.stdout.toString() + p.stderr.toString();
    // what the browser showed when it failed, for a run on a machine one cannot look at (CHECK_ARTIFACTS)
    const shot = join(demo, '.work', 'failure.png');
    if (p.exitCode !== 0 && process.env.CHECK_ARTIFACTS && existsSync(shot)) {
      mkdirSync(process.env.CHECK_ARTIFACTS, { recursive: true });
      copyFileSync(shot, join(process.env.CHECK_ARTIFACTS, 'demo-failure.png'));
      copyFileSync(log, join(process.env.CHECK_ARTIFACTS, 'server.log'));
    }
    expect(p.exitCode === 0, `exit ${p.exitCode}\n${out.slice(-3000)}\n${p.exitCode !== 0 ? pageConsole(demo, await loginLink(base, home, `/c/${canvas}`)) : ''}`);
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
    await check("worker: the artifact is shared on the repository's demo site", async () => {
      await api(`/api/c/${canvas}/cards/${card}/act`, { json: { action: 'share' } });
      const events = await until('the page is shared', 120_000, async () => {
        const ev = (await json(`/api/c/${canvas}/cards/${card}/events`)) as { text?: string }[];
        return ev.some((e) => (e.text ?? '').includes(siteUrl)) && ev;
      });
      const url = (await json(`/api/c/${canvas}/canvas`)).items.find((i: { id: string }) => i.id === card)?.share?.url;
      expect(url && (await fetch(url)).ok, `the page ${url} is not on the site`);
      return events.map((e) => e.text ?? '').find((t) => t.includes(siteUrl));
    });
}

/** What the browser says loading the canvas once more, as the director launches it: for a render that failed. */
function pageConsole(demo: string, link: string | null): string {
  const chromium = join(resources, 'plugin', 'lib', 'chromium.ts');
  const script = join(demo, 'console.ts');
  writeFileSync(
    script,
    `import { launchChromium } from ${JSON.stringify(pathToFileURL(chromium).href)};
const b = await launchChromium({ args: ['--window-size=1440,900'] });
console.log('browser', b.version());
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
p.on('console', (m) => console.log('console', m.type(), m.text().slice(0, 300)));
p.on('pageerror', (e) => console.log('pageerror', e.message.slice(0, 500)));
p.on('requestfailed', (r) => console.log('requestfailed', r.url(), r.failure()?.errorText));
const started = Date.now();
await p.goto(${JSON.stringify(link)});
await p.waitForTimeout(15000);
console.log('after', Date.now() - started, 'ms the page says:', (await p.locator('body').innerText()).slice(0, 300).replace(/\\n/g, ' | '));
await b.close();
`,
  );
  const r = Bun.spawnSync(['node', script], { cwd: demo, env, stdout: 'pipe', stderr: 'pipe' });
  return `the page loaded once more:\n${r.stdout.toString()}${r.stderr.toString().slice(-1500)}`;
}

console.log(failed ? `${failed} check(s) failed; the server's log:\n${logText().slice(-4000)}` : 'all checks passed');
if (args.includes('--keep')) console.log(`kept: ${dir} (server pid ${server?.pid}, port ${port})`);
process.exit(failed ? 1 : 0);
