// What Obeya's own voice in and out needs on this machine, checked for the settings sheet like a
// demo's setup (`plugin/skills/demo/lib/setup.ts`): Whisper (the package in uv's cache or in
// `OBEYA_WHISPER_PYTHON`, the model in the Hugging Face cache), ffmpeg (it decodes the recordings),
// uv (it brings Whisper and Piper's environment), and the voice confirmations are spoken in (the
// macOS one, or Piper under Obeya's home). "Installieren" installs Piper and loads Whisper, which
// fetches it the first time, so the first command does not wait minutes for it.

import type { VoiceSetupItem, VoiceSetupView } from '../core/types';
import { installHint, linuxFamily, output, whisperKit } from '../../plugin/skills/demo/lib/setup.ts';
import { hfModelPresent, installState, installVoice } from '../../plugin/skills/demo/lib/voices.ts';
import { BadRequest } from './board';
import { CONFIRMATION_VOICE, type ListenBackend, type SpeechBackend } from './voice';

export interface VoiceSetupOptions {
  home: string;
  backends: { listen: ListenBackend; speech: SpeechBackend };
  /** Loads Whisper: the transcriber's `prepare`. */
  prepare: () => Promise<void>;
  env?: Record<string, string | undefined>;
}

export class VoiceSetup {
  private job?: VoiceSetupView['job'];

  constructor(private o: VoiceSetupOptions) {}

  async view(): Promise<VoiceSetupView> {
    const env = this.o.env ?? process.env;
    const { platform, arch } = process;
    const { listen, speech } = this.o.backends;
    const family = platform === 'linux' ? linuxFamily() : null;
    const hint = (id: 'ffmpeg' | 'uv') => installHint(id, platform, arch, family);
    const kit = whisperKit(listen);
    const python = env.OBEYA_WHISPER_PYTHON;
    const has = `import importlib.util,sys; sys.exit(not importlib.util.find_spec(${JSON.stringify(kit.module)}))`;
    const [ffmpegOut, uvOut, packageOut] = await Promise.all([
      output('ffmpeg', ['-hide_banner', '-version'], env),
      output('uv', ['--version'], env),
      // offline: only what uv has in its cache counts as there
      python ? output(python, ['-c', has], env) : output('uv', ['run', '--offline', '--quiet', '--no-project', ...kit.uvArgs, 'python', '-c', has], env),
    ]);
    const items: VoiceSetupItem[] = [];
    const found = kit.module.replace('_', '-');
    const model = env.OBEYA_WHISPER_MODEL ?? kit.model;
    // a model named without its repository (faster-whisper's own names) is not looked up
    const modelMb = model.includes('/') && !hfModelPresent(model) ? 1600 : 0;
    let whisperMb = 0;
    if (python && packageOut === null)
      items.push({ id: 'whisper', state: 'missing', found: python, need: found, install: { commands: [`"${python}" -m pip install ${found}`] } });
    else {
      whisperMb = (packageOut === null ? (listen === 'mlx' ? 150 : 250) : 0) + modelMb;
      items.push({ id: 'whisper', state: whisperMb ? 'later' : 'ok', found, ...(whisperMb ? { mb: whisperMb } : {}) });
    }
    const ffmpeg = ffmpegOut?.match(/ffmpeg version (\S+)/)?.[1];
    items.push(ffmpeg ? { id: 'ffmpeg', state: 'ok', found: ffmpeg } : { id: 'ffmpeg', state: 'missing', install: hint('ffmpeg') });
    // uv fetches Whisper unless its Python is given, and makes Piper's environment
    if (!python || speech === 'piper') {
      const uv = uvOut?.match(/uv (\S+)/)?.[1];
      items.push(uv ? { id: 'uv', state: 'ok', found: uv } : { id: 'uv', state: 'missing', install: hint('uv') });
    }
    let piperMb = 0;
    if (speech === 'macos') items.push({ id: 'speech', state: 'ok', found: 'macOS' });
    else {
      const piper = installState(CONFIRMATION_VOICE, this.o.home);
      piperMb = piper.mb;
      items.push(piper.installed ? { id: 'speech', state: 'ok', found: 'Piper' } : { id: 'speech', state: 'missing', found: piper.missing.join(', '), mb: piper.mb });
    }
    const parts = [...(piperMb ? (['piper'] as const) : []), ...(whisperMb ? (['whisper'] as const) : [])];
    return { platform, arch, listen, speech, items, fetch: { parts, mb: piperMb + whisperMb }, ...(this.job ? { job: this.job } : {}) };
  }

  /** Installs Piper if it is missing and loads Whisper, in the background; the view says how far it got. */
  async install(): Promise<VoiceSetupView> {
    if (this.job?.running) throw new BadRequest('voiceInstalling', 'voice is being installed');
    const { speech } = this.o.backends;
    const job: NonNullable<VoiceSetupView['job']> = (this.job = { running: true, step: 'piper', line: '' });
    (async () => {
      if (speech === 'piper' && !installState(CONFIRMATION_VOICE, this.o.home).installed) {
        console.log('Obeya: installing Piper for spoken confirmations');
        await installVoice(CONFIRMATION_VOICE, (line) => (job.line = line.slice(0, 300)), this.o.home);
      }
      job.step = 'whisper';
      job.line = '';
      console.log('Obeya: loading Whisper (fetched the first time)');
      await this.o.prepare();
    })().then(
      () => {
        job.running = false;
        console.log('Obeya: voice ready');
      },
      (e: Error) => {
        job.running = false;
        job.error = e.message;
        console.error(`Obeya: installing the voice failed: ${e.message}`);
      },
    );
    return this.view();
  }
}
