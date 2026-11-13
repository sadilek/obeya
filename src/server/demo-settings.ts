// The demo settings' dialog: the narration language and voice in `demo.json` under Obeya's home,
// read by every render, so saving them restarts nothing; a voice as the owner chooses it, checked,
// installed in the background and heard in a sample; and what else a render needs on this machine.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { LANGUAGES } from '../core/locale';
import type { DemoSettingsProblem, DemoSettingsView, DemoVoiceCheck, VoiceInstallJob } from '../core/types';
import {
  absoluteDirectory,
  DEMO_SETTINGS_FILE,
  demoDirectory,
  type DemoSettings,
  expandHome,
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
import type { DemoSpace } from './demo-space';
import { freshPath } from './path';

const demoShape = z
  .object({
    language: z.enum(LANGUAGES),
    voice: z.enum(VOICES),
    ownVoice: z.boolean().optional(),
    command: z.string().optional(),
    url: z.string().optional(),
    voiceName: z.string().optional(),
    references: z.partialRecord(z.enum(LANGUAGES), z.string()).optional(),
    // the one clip of a draft kept in the dialog from before `references`: `tidyDemoSettings` takes it as its language's
    reference: z.string().optional(),
    keyFile: z.string().optional(),
    directory: z.string().optional(),
    keepFrames: z.union([z.number().int().positive(), z.literal('always')]).optional(),
    subtitles: z.array(z.string()).optional(),
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
  return problems;
}

/** What keeps each of Qwen3's clips to clone from working, by its language; saving them is allowed all the same. */
export function clipProblems(s: DemoSettings): DemoVoiceCheck['clips'] {
  const out: DemoVoiceCheck['clips'] = {};
  if (s.voice !== 'qwen3') return out;
  for (const language of LANGUAGES) {
    const clip = s.references?.[language] && expandHome(s.references[language]);
    if (!clip) continue;
    if (!existsSync(clip)) out[language] = 'referenceMissing';
    else if (!existsSync(clip.replace(/\.wav$/i, '.txt'))) out[language] = 'noTranscript';
  }
  return out;
}

export interface DemoSettingsOptions {
  /** Obeya's home, which holds `demo.json`. */
  home: string;
  /** The demo directory's space and the deletion of old frames; none in tests. */
  space?: DemoSpace;
  /** Where this Obeya answers, so a sample's voice is held by it (`narration.ts`); none in tests. */
  narrationUrl?: string;
  /** The lock a heavy voice's sample waits for; the machine's (TTS_LOCK) unless a test gives its own. */
  ttsLock?: string;
}

export class DemoSettingsDialog {
  constructor(private o: DemoSettingsOptions) {}

  /** The demo settings in Obeya's home; a demo reads them when it renders, so no restart is needed. */
  demo(): DemoSettingsView {
    const settings = readDemoSettings(this.o.home);
    return {
      file: resolve(this.o.home, DEMO_SETTINGS_FILE),
      settings,
      check: this.voiceCheck(settings),
      ...(this.voiceJob ? { job: this.voiceJob } : {}),
      platform: process.platform,
      ...(this.o.space ? { space: this.o.space.view() } : {}),
    };
  }

  saveDemo(input: unknown): DemoSettingsView {
    const before = readDemoSettings(this.o.home);
    const settings = parseDemo(input);
    writeDemoSettings(settings, this.o.home);
    console.log(`Obeya: demo settings saved to ${resolve(this.o.home, DEMO_SETTINGS_FILE)}`);
    // frames kept for a shorter time, or another directory: what is due goes at once
    if (before.keepFrames !== settings.keepFrames || demoDirectory(before) !== demoDirectory(settings)) void this.o.space?.sweepSoon();
    return this.demo();
  }

  private voiceCheck(s: DemoSettings): DemoVoiceCheck {
    return {
      person: narrationPerson(s),
      problems: demoSettingsProblems(s),
      clips: clipProblems(s),
      install: installState(s, this.o.home),
      directory: demoDirectory(s),
      ...(s.directory && !absoluteDirectory(s.directory) ? { directoryRelative: true } : {}),
    };
  }

  /** A voice as the owner is choosing it, before it is saved. */
  checkDemo(input: unknown): DemoVoiceCheck {
    return this.voiceCheck(parseDemo(input));
  }

  /** What a render with these settings needs on this machine, and how to install what is missing. */
  async demoSetup(input: unknown): Promise<SetupCheck> {
    await freshPath();
    return checkSetup(parseDemo(input), { home: this.o.home });
  }

  private voiceJob?: VoiceInstallJob;

  /** Installs what the voice needs, in the background; the view says how far it got. */
  installDemoVoice(input: unknown): DemoSettingsView {
    const s = parseDemo(input);
    if (this.voiceJob?.running) throw new BadRequest('voiceInstalling', `${this.voiceJob.voice} is being installed`);
    const job: VoiceInstallJob = (this.voiceJob = { voice: s.voice, running: true, line: '' });
    console.log(`Obeya: installing the voice ${s.voice}`);
    installVoice(s, (line) => (job.line = line.slice(0, 300)), this.o.home).then(
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
      await sample(s, out, this.o.home, this.o.narrationUrl, this.o.ttsLock).catch((e: Error) => {
        // tts.py says why on its last line: no key, no command, a service's refusal
        const why = e.message.trim().split('\n').at(-1) ?? e.message;
        throw new BadRequest('voiceSample', why);
      });
      return Uint8Array.from(readFileSync(out));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
