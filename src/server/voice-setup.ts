// What Obeya's voice in needs on this machine, checked for the settings sheet like a demo's setup
// (`plugin/skills/demo/lib/setup.ts`): the speech recognition (the package in uv's cache or in
// `OBEYA_WHISPER_PYTHON`, the model in the Hugging Face cache), ffmpeg (it decodes the recordings)
// and uv (it brings the recognition, so it comes first, and "Install" waits for it).
// "Install" loads the recognition, which fetches it the first time, so the first command does
// not wait minutes for it, and then measures it: the recognition hears a short sentence Obeya ships
// with (`voice/check-de.ogg`, spoken by Piper), and where it takes longer than the sentence lasts,
// the sheet offers a cloud service instead (voice-cloud.ts), tested with the same sentence. With a
// cloud service in use nothing of the above is needed.

import type { CloudVoiceView, ListenBackend, VoiceSetupItem, VoiceSetupView, VoiceSpeed } from '../core/types';
import { installHint, linuxFamily, output } from '../../plugin/skills/demo/lib/setup.ts';
import { hfModelPresent } from '../../plugin/skills/demo/lib/voices.ts';
import { BadRequest } from './board';
import { freshPath } from './path';
import { resource } from './resources';
import { listenKit, type Transcript } from './voice';
import { CloudError, cloudFrom, cloudInUse, cloudView, readVoiceFile, serviceName, transcribeInCloud, writeVoiceFile } from './voice-cloud';

/** The sentence the check transcribes („Starte die Karte Export für Vermieter und sag mir Bescheid, wenn sie fertig ist.“), and how long it lasts. */
export const CHECK_CLIP = { file: 'check-de.ogg', seconds: 4.1 };

export interface VoiceSetupOptions {
  home: string;
  /** The recognition on this machine: its backend, loading it (which the first time fetches it), and hearing. */
  local: { backend: ListenBackend; prepare(): Promise<void>; transcribe(audioPath: string, vocabulary: string): Promise<Transcript> };
  env?: Record<string, string | undefined>;
  /** The check's sentence; Obeya's own by default. */
  clip?: string;
  fetcher?: typeof fetch;
}

export class VoiceSetup {
  private job?: VoiceSetupView['job'];
  private done: Promise<void> = Promise.resolve();

  constructor(private o: VoiceSetupOptions) {}

  private get clip() {
    return this.o.clip ?? resource('voice', CHECK_CLIP.file);
  }

  async view(): Promise<VoiceSetupView> {
    const env = this.o.env ?? process.env;
    const { platform, arch } = process;
    const listen = this.o.local.backend;
    const cloud = cloudView(this.o.home);
    const job = this.job ? { job: { ...this.job } } : {};
    // through the cloud nothing on this machine is needed
    if (cloud?.used && cloud.key)
      return { platform, arch, listen, items: [{ id: 'recognition', state: 'ok', found: serviceName(cloud), cloud }], fetch: { mb: 0 }, ...job };
    await freshPath(env, platform);
    const family = platform === 'linux' ? linuxFamily() : null;
    const hint = (id: 'ffmpeg' | 'uv') => installHint(id, platform, arch, family);
    const kit = listenKit(listen);
    const python = env.OBEYA_WHISPER_PYTHON;
    const has = `import importlib.util,sys; sys.exit(not importlib.util.find_spec(${JSON.stringify(kit.module)}))`;
    const [ffmpegOut, uvOut, packageOut] = await Promise.all([
      output('ffmpeg', ['-hide_banner', '-version'], env),
      output('uv', ['--version'], env),
      // offline: only what uv has in its cache counts as there
      python ? output(python, ['-c', has], env) : output('uv', ['run', '--offline', '--quiet', '--no-project', ...kit.uvArgs, 'python', '-c', has], env),
    ]);
    const items: VoiceSetupItem[] = [];
    // uv fetches the recognition unless its Python is given
    const uv = python ? undefined : uvOut?.match(/uv (\S+)/)?.[1];
    if (!python) items.push(uv ? { id: 'uv', state: 'ok', found: uv } : { id: 'uv', state: 'missing', install: hint('uv') });
    const found = kit.name;
    const model = listen !== 'parakeet' && env.OBEYA_WHISPER_MODEL ? env.OBEYA_WHISPER_MODEL : kit.model;
    // a model named without its repository (faster-whisper's own names) is not looked up
    const modelMb = model.includes('/') && !hfModelPresent(model) ? kit.mb.model : 0;
    let mb = 0;
    const measured = this.speed();
    const parts = { ...(measured ? { speed: measured } : {}), ...(cloud ? { cloud } : {}) };
    if (python && packageOut === null)
      items.push({ id: 'recognition', state: 'missing', found: python, need: kit.module.replace('_', '-'), install: { commands: [`"${python}" -m pip install ${kit.uvArgs.at(-1)}`] }, ...parts });
    else {
      mb = (packageOut === null ? kit.mb.package : 0) + modelMb;
      items.push({ id: 'recognition', state: mb ? 'later' : 'ok', found, ...(mb ? { mb } : {}), ...(mb && !python && !uv ? { waits: 'uv' as const } : {}), ...parts });
    }
    const ffmpeg = ffmpegOut?.match(/ffmpeg version (\S+)/)?.[1];
    items.push(ffmpeg ? { id: 'ffmpeg', state: 'ok', found: ffmpeg } : { id: 'ffmpeg', state: 'missing', install: hint('ffmpeg') });
    return { platform, arch, listen, items, fetch: { mb }, ...job };
  }

  /** The measurement of this machine's recognition: running, or the last one of the backend in use. */
  private speed(): VoiceSpeed | 'measuring' | undefined {
    if (this.job?.running && this.job.step === 'measure') return 'measuring';
    const speed = readVoiceFile(this.o.home).speed;
    return speed?.backend === this.o.local.backend ? speed : undefined;
  }

  /** Loads the recognition and measures it, in the background; the view says how far it got. */
  async install(): Promise<VoiceSetupView> {
    if (this.job?.running) throw new BadRequest('voiceInstalling', 'voice is being installed');
    if ((await this.view()).items.some((i) => i.waits)) throw new BadRequest('invalid', 'the speech recognition comes through uv, which is not installed yet');
    return this.run(true);
  }

  /** Measures the recognition on this machine again, in the background. */
  async measure(): Promise<VoiceSetupView> {
    if (this.job?.running) throw new BadRequest('voiceInstalling', 'voice is being installed');
    return this.run(false);
  }

  private run(fetching: boolean): Promise<VoiceSetupView> {
    const job: NonNullable<VoiceSetupView['job']> = (this.job = { running: true, step: fetching ? 'fetch' : 'measure' });
    const listen = this.o.local.backend;
    this.done = (async () => {
      console.log(`Obeya: loading the speech recognition (${listenKit(listen).name}, fetched the first time)`);
      await this.o.local.prepare();
      job.step = 'measure';
      // twice, the faster one counts: the first recording after loading takes longer than those after it
      // (0.6 s against 0.1 s for a short command on an M4 Pro)
      let seconds = Infinity;
      let text = '';
      for (let i = 0; i < 2; i++) {
        const started = performance.now();
        ({ text } = await this.o.local.transcribe(this.clip, ''));
        seconds = Math.min(seconds, Math.round((performance.now() - started) / 10) / 100);
      }
      const speed: VoiceSpeed = { backend: listen, seconds, slow: seconds > CHECK_CLIP.seconds };
      writeVoiceFile(this.o.home, { ...readVoiceFile(this.o.home), speed });
      console.log(`Obeya: the speech recognition heard ${CHECK_CLIP.seconds} s of speech in ${seconds} s${speed.slow ? ', too slow' : ''}: ${text}`);
    })().then(
      () => {
        job.running = false;
      },
      (e: Error) => {
        job.running = false;
        job.error = e.message;
        console.error(`Obeya: installing the voice failed: ${e.message}`);
        throw e;
      },
    );
    // the view says how it ended; whoever waits for it hears of a failure
    this.done.catch(() => {});
    return this.view();
  }

  /** Ends with the installation running or last run, failing as it did. */
  finished(): Promise<void> {
    return this.done;
  }

  /**
   * Tests a cloud service with the check's sentence and, once it answered, sends the recordings to
   * it from now on. A key left out keeps the one stored for the same service.
   */
  async useCloud(input: unknown): Promise<VoiceSetupView> {
    const file = readVoiceFile(this.o.home);
    const service = cloudFrom(input, file.cloud);
    const started = performance.now();
    let heard: Transcript;
    try {
      heard = await transcribeInCloud(service, this.clip, '', this.o.fetcher);
    } catch (e) {
      if (e instanceof CloudError) throw new BadRequest('voiceCloud', e.message);
      throw e;
    }
    const tested: CloudVoiceView['tested'] = { seconds: Math.round((performance.now() - started) / 10) / 100 };
    writeVoiceFile(this.o.home, { ...readVoiceFile(this.o.home), use: 'cloud', cloud: { ...service, tested } });
    console.log(`Obeya: voice in through ${serviceName(service)} (${service.model}), which heard the check in ${tested.seconds} s: ${heard.text}`);
    return this.view();
  }

  /** Back to the recognition on this machine; the service stays set up for later. */
  useLocal(): Promise<VoiceSetupView> {
    if (cloudInUse(this.o.home)) {
      writeVoiceFile(this.o.home, { ...readVoiceFile(this.o.home), use: 'local' });
      console.log('Obeya: voice in on this machine again');
    }
    return this.view();
  }
}
