import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanvasConfig, ConfigView, DemoSettingsView, LanguageView } from '../core/types';
import { CanvasRuntime } from './canvas';
import { Config, demoSettingsProblems, readConfigFile } from './config';
import { Store } from './db';
import { serve } from './server';
import { ownerLanguage } from './settings';
import { FakeRuntime, noForge, gitRepo } from './testing';

let dir: string;
let store: Store;
let web: string;
let api: string;
let file: string;
let restarts: number;

function repo(name: string) {
  return gitRepo(join(dir, name));
}

const config = (source: 'file' | 'args', started: CanvasConfig[], running: string[] = []) =>
  new Config({
    file,
    source,
    started,
    store,
    running: () => running,
    server: { port: 4417, home: dir, permissionMode: 'auto' },
    // not the machine's lock: a demo another agent renders meanwhile would hold up the sample
    ttsLock: join(dir, 'tts.lock'),
    restart: () => void restarts++,
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'obeya-config-'));
  store = new Store(':memory:');
  web = repo('web');
  api = repo('api');
  file = join(dir, 'home', 'canvases.json');
  restarts = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("Obeya's configuration", () => {
  test('says what each canvas amounts to: its id, name, repositories and their adapters', () => {
    const c = config('args', [{ name: 'Produkt', repos: [{ path: web }, { path: api, adapter: 'obeya' }] }], ['produkt']);
    const v = c.view();
    expect(v).toMatchObject({ file, source: 'args', running: ['produkt'], problems: [], restarting: false, server: { port: 4417, restarts: true } });
    expect(v.adapters).toContain('obeya');
    expect(v.resolved).toEqual([
      {
        id: 'produkt',
        name: 'Produkt',
        repos: [
          { id: 'web', adapter: 'generic', workspaces: 'clones' },
          { id: 'api', adapter: 'obeya', workspaces: 'worktrees' },
        ],
      },
    ]);
  });

  test('finds what keeps a configuration from working, by canvas and repository', () => {
    const c = config('file', []);
    const { problems } = c.check([
      { name: 'A', repos: [{ path: web }, { path: join(dir, 'nowhere') }] },
      { name: 'B', repos: [{ path: api, adapter: 'nope', workspaces: [join(dir, 'nowhere')] }] },
      { name: 'Leer', repos: [] },
    ]);
    expect(problems.map(({ code, canvas, repo }) => ({ code, canvas, repo }))).toEqual([
      { code: 'notRepo', canvas: 0, repo: 1 },
      { code: 'notClone', canvas: 1, repo: 0 },
      { code: 'unknownAdapter', canvas: 1, repo: 0 },
      { code: 'noRepo', canvas: 2, repo: undefined },
    ]);
    // the id follows the name, unless it is kept
    expect(c.check([{ name: 'Neuer Name', id: 'web', repos: [{ path: web }] }]).resolved[0]).toMatchObject({ id: 'web', name: 'Neuer Name' });
    expect(c.check([{ name: 'Web', repos: [{ path: web }] }, { name: 'web', repos: [{ path: api }] }]).problems).toMatchObject([{ code: 'sameId', canvas: 1 }]);
    expect(c.check([]).problems.map((p) => p.code)).toEqual(['noCanvas']);
    expect(c.check([{ repos: [{ path: web, color: 'red' }] }]).problems.map((p) => p.code)).toEqual(['invalid']);
    expect(c.check({}).problems.map((p) => p.code)).toEqual(['invalid']);
  });

  test("a repository's share command is checked: its program must be there, a script is found in the repository", () => {
    const c = config('file', []);
    writeFileSync(join(web, 'share.ts'), '');
    const problems = (share: string) => c.check([{ repos: [{ path: web, share }] }]).problems.map((p) => p.code);
    expect(problems('share.ts --site demos')).toEqual([]);
    expect(problems('./share.ts')).toEqual([]);
    expect(problems('git')).toEqual([]);
    expect(problems('scripts/nowhere.sh')).toEqual(['shareCommand']);
    expect(problems('no-such-program-anywhere publish')).toEqual(['shareCommand']);
    // an empty one is no command: the adapter's counts, or demos are exported
    expect(problems('  ')).toEqual([]);
    expect(c.check([{ repos: [{ path: web, share: ' ' }] }]).canvases).toEqual([{ repos: [{ path: web }] }]);
  });

  test("keeps a canvas's home repository: leaving it out is a problem, moving it is not", () => {
    store.ensureCanvas('produkt', 'Produkt');
    store.setSetting('produkt', 'home_repo', 'web');
    const c = config('file', []);
    expect(c.check([{ name: 'Produkt', repos: [{ path: api }] }]).problems.map((p) => p.code)).toEqual(['homeMissing']);
    const moved = c.check([{ name: 'Produkt', repos: [{ path: api }, { path: web }] }]);
    expect(moved.problems).toEqual([]);
    // listed in the order given, though the home one runs first
    expect(moved.resolved[0]!.repos.map((r) => r.id)).toEqual(['api', 'web']);
  });

  test('saves a configuration that works, tidied, and starts Obeya again; one with problems is refused', () => {
    const c = config('args', [{ repos: [{ path: web }] }]);
    expect(() => c.save([{ repos: [{ path: join(dir, 'nowhere') }] }])).toThrow();
    expect(existsSync(file)).toBe(false);
    expect(restarts).toBe(0);

    expect(c.save([{ name: ' ', repos: [{ path: web, adapter: '', workspaces: [' '], clones: 0 }, { path: api, clones: 2 }] }])).toEqual({ restarting: true });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([{ repos: [{ path: web }, { path: api, clones: 2 }] }]);
    expect(readConfigFile(file)).toEqual([{ repos: [{ path: web }, { path: api, clones: 2 }] }]);
    expect(restarts).toBe(1);
    expect(c.view().restarting).toBe(true);
    // saved again before the restart: the file has the latest, and the restart is already on its way
    c.save([{ repos: [{ path: api }] }]);
    expect(restarts).toBe(1);
  });

  test('shows the file when Obeya runs from it, the command line until something is saved', () => {
    mkdirSync(join(dir, 'home'));
    writeFileSync(file, JSON.stringify([{ name: 'Aus Datei', repos: [{ path: web }] }]));
    expect(config('file', []).view().canvases).toEqual([{ name: 'Aus Datei', repos: [{ path: web }] }]);
    expect(config('args', [{ repos: [{ path: api }] }]).view().canvases).toEqual([{ repos: [{ path: api }] }]);
  });

  test('expands ~ in paths', () => {
    const home = process.env.HOME!;
    if (!web.startsWith(`${home}/`)) return;
    expect(config('file', []).check([{ repos: [{ path: `~${web.slice(home.length)}` }] }]).problems).toEqual([]);
  });
});

describe('the configuration over HTTP', () => {
  let server: ReturnType<typeof serve>;
  let canvas: CanvasRuntime;
  beforeEach(() => {
    const c = config('args', [{ repos: [{ path: web }] }], ['web']);
    canvas = new CanvasRuntime({ repos: [{ path: web }] }, { store, home: dir, runtime: new FakeRuntime(), forge: noForge, config: c });
    server = serve([canvas], { transcriber: { transcribe: async () => ({ text: '', doubtful: false }) }, speaker: { speak: async () => null } }, 0, false, c);
  });
  afterEach(() => {
    server.stop(true);
    canvas.shutdown();
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(new URL(path, server.url), { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  test('reads, checks and saves it', async () => {
    const view = (await call('GET', '/api/config')).body as unknown as ConfigView;
    expect(view.canvases).toEqual([{ repos: [{ path: web }] }]);
    expect(view.running).toEqual(['web']);

    const checked = await call('POST', '/api/config/check', [{ name: 'Zwei', repos: [{ path: web }, { path: join(dir, 'nowhere') }] }]);
    expect(checked.body.problems).toMatchObject([{ code: 'notRepo', canvas: 0, repo: 1 }]);

    const refused = await call('PUT', '/api/config', [{ repos: [{ path: join(dir, 'nowhere') }] }]);
    expect(refused).toMatchObject({ status: 400, body: { code: 'config' } });

    expect((await call('PUT', '/api/config', [{ repos: [{ path: web }, { path: api }] }])).body).toEqual({ restarting: true });
    expect(readConfigFile(file)).toEqual([{ repos: [{ path: web }, { path: api }] }]);
  });

  test('reads and saves the language in its home, keeping the file\'s other settings', async () => {
    const before = (await call('GET', '/api/language')).body as unknown as LanguageView;
    expect(before).toMatchObject({ file: join(dir, 'settings.json'), chosen: null });
    expect(before.language).toBe(before.system);
    expect((await call('PUT', '/api/language', { language: 'fr' })).status).toBe(400);
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ later: 1 }));
    expect((await call('PUT', '/api/language', { language: 'en' })).body).toMatchObject({ chosen: 'en', language: 'en' });
    expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))).toEqual({ later: 1, language: 'en' });
    // the server reads it whenever it needs it
    expect(ownerLanguage(dir)).toBe('en');
    expect((await call('PUT', '/api/language', { language: null })).body).toMatchObject({ chosen: null, language: before.system });
    expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))).toEqual({ later: 1 });
  });

  test('reads and saves the demo settings in its home, without a restart', async () => {
    // without a narration language of their own, demos speak the owner's
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ language: 'de' }));
    const before = (await call('GET', '/api/demo-settings')).body as unknown as DemoSettingsView;
    expect(before).toMatchObject({ file: join(dir, 'demo.json'), settings: { language: 'de', voice: 'piper' }, check: { person: 'third', problems: [] } });
    expect(before.check.install).toMatchObject({ installed: false, missing: ['Piper', 'Piper-Stimme de_DE-thorsten-high'] });
    expect((await call('PUT', '/api/demo-settings', { language: 'fr', voice: 'piper' })).status).toBe(400);
    const saved = await call('PUT', '/api/demo-settings', { language: 'en', voice: 'command', command: ' speak ', ownVoice: true });
    expect(saved.body).toMatchObject({ settings: { language: 'en', voice: 'command', command: 'speak', ownVoice: true }, check: { person: 'first', problems: [] } });
    expect(JSON.parse(readFileSync(join(dir, 'demo.json'), 'utf8'))).toEqual({ language: 'en', voice: 'command', ownVoice: true, command: 'speak' });
    // a voice being chosen is checked before it is saved
    const draft = await call('POST', '/api/demo-settings/check', { language: 'en', voice: 'qwen3', reference: join(dir, 'me.wav') });
    expect(draft.body).toMatchObject({ person: 'third', problems: ['referenceMissing'], install: { installed: false } });
    expect(restarts).toBe(0);
  });

  test.skipIf(!Bun.which('uv') || !Bun.which('ffmpeg'))('plays a sentence in the voice being chosen, or says why it cannot', async () => {
    const clip = join(dir, 'clip.wav');
    writeFileSync(clip, wav(0.2));
    const heard = await fetch(new URL('/api/demo-settings/sample', server.url), {
      method: 'POST',
      body: JSON.stringify({ language: 'de', voice: 'command', command: `cat > ${JSON.stringify(join(dir, 'said.txt'))}; cp ${JSON.stringify(clip)} "$DEMO_WAV"` }),
    });
    expect(heard.headers.get('content-type')).toBe('audio/wav');
    expect((await heard.arrayBuffer()).byteLength).toBeGreaterThan(44);
    expect(readFileSync(join(dir, 'said.txt'), 'utf8')).toContain('So klingt diese Stimme');
    const refused = await call('POST', '/api/demo-settings/sample', { language: 'de', voice: 'command', command: 'echo kaputt >&2; exit 3' });
    expect(refused).toMatchObject({ status: 400, body: { code: 'voiceSample' } });
    expect(String(refused.body.error)).toContain('kaputt');

    // an own endpoint gets the text and the language as JSON, the key as a bearer token
    let asked: { auth: string | null; body: unknown } | undefined;
    const endpoint = Bun.serve({
      port: 0,
      fetch: async (req) => {
        asked = { auth: req.headers.get('authorization'), body: await req.json() };
        return new Response(wav(0.3), { headers: { 'content-type': 'audio/wav' } });
      },
    });
    try {
      writeFileSync(join(dir, 'key'), 'geheim\n');
      const served = await fetch(new URL('/api/demo-settings/sample', server.url), {
        method: 'POST',
        body: JSON.stringify({ language: 'en', voice: 'http', url: `http://127.0.0.1:${endpoint.port}/tts`, keyFile: join(dir, 'key') }),
      });
      expect(served.status).toBe(200);
      expect(asked).toEqual({ auth: 'Bearer geheim', body: { text: expect.stringContaining('This is how the voice sounds'), language: 'en' } });
    } finally {
      endpoint.stop(true);
    }
  }, 60_000);

  test('a configuration command of the Koordinator saves it after the undo window', () => {
    canvas.run({ do: 'configure', canvases: [{ name: 'Neu', repos: [{ path: web }] }] });
    expect(readConfigFile(file)).toEqual([{ name: 'Neu', repos: [{ path: web }] }]);
    expect(restarts).toBe(1);
  });
});

describe('the demo settings', () => {
  test('say what keeps a voice from speaking', () => {
    const missing = join(dir, 'nowhere');
    expect(demoSettingsProblems({ language: 'de', voice: 'piper' }, {})).toEqual([]);
    expect(demoSettingsProblems({ language: 'de', voice: 'command' }, {})).toEqual(['noCommand']);
    expect(demoSettingsProblems({ language: 'de', voice: 'http' }, {})).toEqual(['noUrl']);
    expect(demoSettingsProblems({ language: 'de', voice: 'http', url: 'http://localhost:9' }, {})).toEqual([]);
    expect(demoSettingsProblems({ language: 'de', voice: 'say' }, {}, 'linux')).toEqual(['notHere']);
    expect(demoSettingsProblems({ language: 'de', voice: 'say' }, {}, 'darwin')).toEqual([]);
    expect(demoSettingsProblems({ language: 'de', voice: 'gemini' }, {})).toEqual(['noKey']);
    expect(demoSettingsProblems({ language: 'de', voice: 'gemini' }, { GEMINI_API_KEY: 'k' })).toEqual([]);
    expect(demoSettingsProblems({ language: 'de', voice: 'azure', url: 'westeurope' }, {})).toEqual(['noKey']);
    expect(demoSettingsProblems({ language: 'de', voice: 'openai', keyFile: missing }, {})).toEqual(['keyFileMissing']);
    writeFileSync(join(dir, 'key'), 'k');
    expect(demoSettingsProblems({ language: 'en', voice: 'elevenlabs', keyFile: join(dir, 'key') }, {})).toEqual([]);
    writeFileSync(join(dir, 'me.wav'), '');
    expect(demoSettingsProblems({ language: 'de', voice: 'qwen3', reference: join(dir, 'me.wav') }, {})).toEqual(['noTranscript']);
    writeFileSync(join(dir, 'me.txt'), 'Hallo.');
    expect(demoSettingsProblems({ language: 'de', voice: 'qwen3', reference: join(dir, 'me.wav') }, {})).toEqual([]);
  });
});

/** A silent mono 16-bit WAV of `seconds`. */
function wav(seconds: number, rate = 16000) {
  const data = Math.round(seconds * rate) * 2;
  const b = Buffer.alloc(44 + data);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + data, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(data, 40);
  return b;
}
