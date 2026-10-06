// Obeya's configuration: the canvases it serves, saved in `canvases.json` under its home. The owner
// reads and edits it in its sheet, the Koordinator on their word; a saved change takes effect when
// Obeya starts again, which it does by itself once no agent is in the middle of a turn.

import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { adapterNames } from '../adapters';
import type { CanvasConfig, ConfigProblem, ConfigView, DemoSettingsProblem, DemoSettingsView, DemoVoiceCheck, LanguageView, ResolvedCanvas, VoiceInstallJob } from '../core/types';
import {
  DEMO_SETTINGS_FILE,
  type DemoSettings,
  expandHome,
  NARRATION_LANGUAGES,
  narrationPerson,
  readDemoSettings,
  SERVICES,
  tidyDemoSettings,
  VOICES,
  writeDemoSettings,
} from '../../plugin/skills/demo/lib/settings.ts';
import { checkSetup, type SetupCheck } from '../../plugin/skills/demo/lib/setup.ts';
import { installState, installVoice, KEY_ENV, sample } from '../../plugin/skills/demo/lib/voices.ts';
import { BadRequest } from './board';
import { ConfigError, resolveCanvas } from './canvas';
import type { Store } from './db';
import { repoInfo } from './repo';
import { languageView, saveLanguage } from './settings';
import { shareArgv, shareProblem } from './share';

export const CONFIG_FILE = 'canvases.json';

/** A path with `~` for the home directory, as the owner may write it. */
export const expand = (p: string) => p.replace(/^~(?=$|\/)/, homedir());

/** The configuration with its paths as the server uses them. */
export function expandConfig(canvases: CanvasConfig[]): CanvasConfig[] {
  return canvases.map((c) => ({
    ...c,
    repos: c.repos.map((r) => ({ ...r, path: expand(r.path), ...(r.workspaces ? { workspaces: r.workspaces.map(expand) } : {}) })),
  }));
}

const shape = z.array(
  z
    .object({
      name: z.string().optional(),
      id: z.string().optional(),
      repos: z.array(
        z
          .object({
            path: z.string(),
            adapter: z.string().optional(),
            workspaces: z.array(z.string()).optional(),
            clones: z.number().int().min(0).max(20).optional(),
            share: z.string().optional(),
          })
          .strict(),
      ),
    })
    .strict(),
);

/** The configuration as it is saved: no empty names, adapters, clone lists or counts. */
function tidy(canvases: z.infer<typeof shape>): CanvasConfig[] {
  return canvases.map((c) => ({
    ...(c.name?.trim() ? { name: c.name.trim() } : {}),
    ...(c.id?.trim() ? { id: c.id.trim() } : {}),
    repos: c.repos.map((r) => {
      const workspaces = (r.workspaces ?? []).map((w) => w.trim()).filter(Boolean);
      return {
        path: r.path.trim(),
        ...(r.adapter?.trim() ? { adapter: r.adapter.trim() } : {}),
        ...(workspaces.length ? { workspaces } : {}),
        ...(r.clones ? { clones: r.clones } : {}),
        ...(r.share?.trim() ? { share: r.share.trim() } : {}),
      };
    }),
  }));
}

/** Reads a configuration file; throws when it is no list of canvases. */
export function readConfigFile(file: string): CanvasConfig[] {
  return tidy(shape.parse(JSON.parse(readFileSync(file, 'utf8'))));
}

export interface ConfigOptions {
  /** Where it is saved. */
  file: string;
  /** Whether the running canvases come from that file or from the command line. */
  source: 'file' | 'args';
  /** The configuration the server started with, paths as given. */
  started: CanvasConfig[];
  store: Store;
  /** The ids of the canvases the server runs. */
  running: () => string[];
  server: { port: number; home: string; permissionMode: string };
  /** Where this Obeya answers, so a sample's voice is held by it (`narration.ts`); none in tests. */
  narrationUrl?: string;
  /** The lock a heavy voice's sample waits for; the machine's (TTS_LOCK) unless a test gives its own. */
  ttsLock?: string;
  /** Starts Obeya again with the saved configuration; absent where nothing restarts it (--dev). */
  restart?: () => void;
}

const demoShape = z
  .object({
    language: z.enum(NARRATION_LANGUAGES),
    voice: z.enum(VOICES),
    ownVoice: z.boolean().optional(),
    command: z.string().optional(),
    url: z.string().optional(),
    voiceName: z.string().optional(),
    reference: z.string().optional(),
    keyFile: z.string().optional(),
    listenBack: z.literal(false).optional(),
  })
  .strict();

function parseDemo(input: unknown): DemoSettings {
  const parsed = demoShape.safeParse(input);
  if (!parsed.success) throw new BadRequest('config', z.prettifyError(parsed.error));
  return tidyDemoSettings(parsed.data);
}

/** What keeps demo settings from working; saving them is allowed all the same. */
export function demoSettingsProblems(
  s: DemoSettings,
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
): DemoSettingsProblem[] {
  const problems: DemoSettingsProblem[] = [];
  if (s.voice === 'command' && !s.command) problems.push('noCommand');
  if ((s.voice === 'http' || s.voice === 'azure') && !s.url) problems.push('noUrl');
  if (s.voice === 'say' && platform !== 'darwin') problems.push('notHere');
  const service = (SERVICES as readonly string[]).includes(s.voice) || s.voice === 'http';
  if (service && !env[KEY_ENV[s.voice as keyof typeof KEY_ENV]]) {
    if (s.keyFile && !existsSync(expandHome(s.keyFile))) problems.push('keyFileMissing');
    else if (!s.keyFile && s.voice !== 'http') problems.push('noKey');
  }
  if (s.voice === 'qwen3' && s.reference) {
    const clip = expandHome(s.reference);
    if (!existsSync(clip)) problems.push('referenceMissing');
    else if (!existsSync(clip.replace(/\.wav$/i, '.txt'))) problems.push('noTranscript');
  }
  return problems;
}

/** A configuration checked: what it amounts to, and what keeps it from working. */
export interface Checked {
  canvases: CanvasConfig[];
  resolved: (ResolvedCanvas | null)[];
  problems: ConfigProblem[];
}

export class Config {
  private restarting = false;

  constructor(private o: ConfigOptions) {}

  /** The configuration as saved, or as started when nothing is saved yet (or the file no longer reads). */
  current(): CanvasConfig[] {
    if (this.o.source === 'file' && existsSync(this.o.file)) {
      try {
        return readConfigFile(this.o.file);
      } catch {}
    }
    return this.o.started;
  }

  view(): ConfigView {
    const { canvases, resolved, problems } = this.check(this.current());
    return {
      file: this.o.file,
      source: this.o.source,
      canvases,
      resolved,
      problems,
      running: this.o.running(),
      adapters: adapterNames(),
      server: { ...this.o.server, restarts: !!this.o.restart },
      restarting: this.restarting,
    };
  }

  /** Checks a configuration without saving it: every canvas resolves, and no two share an id. */
  check(input: unknown): Checked {
    const parsed = shape.safeParse(input);
    if (!parsed.success) return { canvases: [], resolved: [], problems: [{ code: 'invalid', detail: z.prettifyError(parsed.error) }] };
    const canvases = tidy(parsed.data);
    const problems: ConfigProblem[] = [];
    if (!canvases.length) problems.push({ code: 'noCanvas', detail: 'Obeya needs at least one canvas' });
    const resolved = expandConfig(canvases).map((c, canvas): ResolvedCanvas | null => {
      c.repos.forEach((r, repo) =>
        (r.workspaces ?? []).forEach((w) => {
          try {
            repoInfo(resolve(w));
          } catch {
            problems.push({ code: 'notClone', canvas, repo, detail: `workspace ${w} is not a git repository` });
          }
        }),
      );
      c.repos.forEach((r, repo) => {
        const wrong = r.share && shareProblem(shareArgv(r.share, resolve(r.path)));
        if (wrong) problems.push({ code: 'shareCommand', canvas, repo, detail: wrong });
      });
      try {
        const { id, name, adapters, refs, config } = resolveCanvas(c, this.o.store);
        // the repositories in the order given, though the home one runs first
        return {
          id,
          name,
          repos: c.repos.map((r) => {
            const i = config.repos.indexOf(r);
            return { id: refs[i]!.id, adapter: adapters[i]!.name, workspaces: adapters[i]!.workspaces, ...(adapters[i]!.demo?.share ? { adapterShares: true } : {}) };
          }),
        };
      } catch (e) {
        if (!(e instanceof ConfigError)) throw e;
        problems.push({ code: e.code, canvas, ...(e.repo !== undefined ? { repo: e.repo } : {}), detail: e.message });
        return null;
      }
    });
    resolved.forEach((r, canvas) => {
      const first = resolved.findIndex((x) => x?.id === r?.id);
      if (r && first !== canvas) problems.push({ code: 'sameId', canvas, detail: `canvas ${canvas + 1} has the id "${r.id}" of canvas ${first + 1}; give it another name` });
    });
    return { canvases, resolved, problems };
  }

  /** The demo settings in Obeya's home; a demo reads them when it renders, so no restart is needed. */
  demo(): DemoSettingsView {
    const settings = readDemoSettings(this.o.server.home);
    return {
      file: resolve(this.o.server.home, DEMO_SETTINGS_FILE),
      settings,
      check: this.voiceCheck(settings),
      ...(this.voiceJob ? { job: this.voiceJob } : {}),
      platform: process.platform,
    };
  }

  /** The language Obeya speaks to the owner, in `settings.json` in Obeya's home; saving it restarts nothing. */
  language(): LanguageView {
    return languageView(this.o.server.home);
  }

  saveLanguage(input: unknown): LanguageView {
    return saveLanguage(this.o.server.home, input);
  }

  saveDemo(input: unknown): DemoSettingsView {
    writeDemoSettings(parseDemo(input), this.o.server.home);
    console.log(`Obeya: demo settings saved to ${resolve(this.o.server.home, DEMO_SETTINGS_FILE)}`);
    return this.demo();
  }

  private voiceCheck(s: DemoSettings): DemoVoiceCheck {
    return { person: narrationPerson(s), problems: demoSettingsProblems(s), install: installState(s, this.o.server.home) };
  }

  /** A voice as the owner is choosing it, before it is saved. */
  checkDemo(input: unknown): DemoVoiceCheck {
    return this.voiceCheck(parseDemo(input));
  }

  /** What a render with these settings needs on this machine, and how to install what is missing. */
  demoSetup(input: unknown): Promise<SetupCheck> {
    return checkSetup(parseDemo(input), { home: this.o.server.home });
  }

  private voiceJob?: VoiceInstallJob;

  /** Installs what the voice needs, in the background; the view says how far it got. */
  installDemoVoice(input: unknown): DemoSettingsView {
    const s = parseDemo(input);
    if (this.voiceJob?.running) throw new BadRequest('voiceInstalling', `${this.voiceJob.voice} is being installed`);
    const job: VoiceInstallJob = (this.voiceJob = { voice: s.voice, running: true, line: '' });
    console.log(`Obeya: installing the voice ${s.voice}`);
    installVoice(s, (line) => (job.line = line.slice(0, 300)), this.o.server.home).then(
      () => {
        job.running = false;
        console.log(`Obeya: voice ${s.voice} installed`);
      },
      (e: Error) => {
        job.running = false;
        job.error = e.message;
        console.error(`Obeya: installing the voice ${s.voice} failed: ${e.message}`);
      },
    );
    return this.demo();
  }

  /** One sentence in the voice, as WAV, so the owner hears it before choosing it. */
  async sampleDemoVoice(input: unknown): Promise<Uint8Array<ArrayBuffer>> {
    const s = parseDemo(input);
    const dir = mkdtempSync(join(tmpdir(), 'obeya-voice-'));
    try {
      const out = join(dir, 'sample.wav');
      await sample(s, out, this.o.server.home, this.o.narrationUrl, this.o.ttsLock).catch((e: Error) => {
        // tts.py says why on its last line: no key, no command, a service's refusal
        const why = e.message.trim().split('\n').at(-1) ?? e.message;
        throw new BadRequest('voiceSample', why);
      });
      return Uint8Array.from(readFileSync(out));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Saves a configuration that works, and starts Obeya again with it where something restarts it. */
  save(input: unknown): { restarting: boolean } {
    const { canvases, problems } = this.check(input);
    if (problems.length) throw new BadRequest('config', problems.map((p) => p.detail).join('; '));
    mkdirSync(dirname(this.o.file), { recursive: true });
    writeFileSync(this.o.file, `${JSON.stringify(canvases, null, 2)}\n`);
    console.log(`Obeya: configuration saved to ${this.o.file}`);
    if (this.o.restart && !this.restarting) {
      this.restarting = true;
      this.o.restart();
    }
    return { restarting: this.restarting };
  }
}
