// Renders the hero video (`demo.ts`) in the owner's ElevenLabs voice, without touching Obeya's own
// demo settings: a home of its own beside the output holds the voice settings, its voices directory
// is Obeya's (for Qwen3-TTS with `--qwen`). The key lies in `.voice/elevenlabs.key` of the main
// checkout, gitignored. `--qwen` renders in the owner's voice cloned by Qwen3-TTS instead (the
// reference `.voice/qwen-reference-en.wav` there), which costs no credits: for trying a change out,
// into `obeya-hero-qwen` in the demo directory (`~/demos` unless the demo settings name another).
// `--record` records the take's agents (real ones) into a directory, `obeya-hero-recording` there
// unless named; `--replay` plays such a recording back instead of
// running agents, the same take in minutes (the README says when which). A take on a busy machine
// stutters: before one starts, it measures the machine and refuses when it is short of memory or its
// cores are nearly all busy (`load.ts`), unless `--ignore-load` says to render anyway; it refuses
// too while another render runs. `--check-load` only measures and says whether a take may start
// (exit 0, else 3). Other arguments go on to the demo (`--narration`, `--dry`).
//
//   node scripts/hero-video/render.ts [--qwen] [--record [<dir>] | --replay [<dir>]] [--ignore-load] [--narration | --dry]
//   node scripts/hero-video/render.ts --check-load
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { holdPidLock } from '../../plugin/lib/process.ts';
import { demoDirectory } from '../../plugin/skills/demo/lib/settings.ts';
import { measure, quiet, reasons, warning } from './load.ts';

const VOICE = 'IErGHDQU4vPqicCi8dwR';
const qwen = process.argv.includes('--qwen');
/** The owner's demo directory: the take's own home below names it too, so its agents' demos go there. */
const DEMOS = demoDirectory();
const OUT = process.env.HERO_OUT ?? path.join(DEMOS, qwen ? 'obeya-hero-qwen' : 'obeya-hero');
const common = spawnSync('git', ['-C', import.meta.dirname, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).stdout.trim();
const voiceDir = path.join(path.dirname(common), '.voice');
const keyFile = path.join(voiceDir, 'elevenlabs.key');
const reference = path.join(voiceDir, 'qwen-reference-en.wav');
const needed = qwen ? reference : keyFile;
if (!fs.existsSync(needed)) {
  console.error(`missing ${needed}`);
  process.exit(1);
}

/** The directory after `--<flag>`, else the default recording, when the flag is given. */
const recording = (flag: string) => {
  const i = process.argv.indexOf(`--${flag}`);
  if (i < 0) return undefined;
  const given = process.argv[i + 1];
  return path.resolve(given && !given.startsWith('--') ? given : path.join(DEMOS, 'obeya-hero-recording'));
};
const record = recording('record');
const replay = recording('replay');
if (record && replay) {
  console.error('--record or --replay, not both');
  process.exit(1);
}
const own = new Set(['--qwen', '--record', '--replay', '--ignore-load', '--check-load', ...[record, replay].filter((d) => d !== undefined)]);

/** Whether the machine is quiet enough for a take: says so, or why not and what loads it. */
async function quietEnough() {
  const load = await measure();
  const why = reasons(load);
  if (why.length) console.error(warning(load, why));
  else console.log(quiet(load));
  return why.length === 0;
}
if (process.argv.includes('--check-load')) process.exit((await quietEnough()) ? 0 : 3);

// Two takes share the scratch Obeya on its fixed port: a second one restages it and the first loses its server.
const narrationOnly = process.argv.includes('--narration');
const lock = path.join(os.tmpdir(), 'obeya-hero-render.pid');
if (!narrationOnly) {
  const holder = holdPidLock(lock);
  if (holder) {
    console.error(`Another render of the hero video is running (pid ${holder}); a second one would stop its scratch Obeya. Not started.`);
    process.exit(3);
  }
}
// the narration alone and a dry run record no video
if (!narrationOnly && !process.argv.includes('--dry') && !process.argv.includes('--ignore-load') && !(await quietEnough())) process.exit(3);

const home = path.join(OUT, 'home');
fs.mkdirSync(home, { recursive: true });
const settings = qwen
  ? { language: 'en', voice: 'qwen3', ownVoice: true, reference }
  : { language: 'en', voice: 'elevenlabs', ownVoice: true, voiceName: VOICE, keyFile };
fs.writeFileSync(path.join(home, 'demo.json'), JSON.stringify({ ...settings, directory: DEMOS }, null, 2));
const voices = path.join(process.env.OBEYA_HOME ?? path.join(os.homedir(), '.obeya'), 'voices');
if (fs.existsSync(voices) && !fs.existsSync(path.join(home, 'voices'))) fs.symlinkSync(voices, path.join(home, 'voices'));

const r = spawnSync('node', [path.join(import.meta.dirname, 'demo.ts'), ...process.argv.slice(2).filter((a) => !own.has(a) && !own.has(path.resolve(a)))], {
  stdio: 'inherit',
  env: { ...process.env, OBEYA_HOME: home, HERO_OUT: OUT, DEMO_ELEVENLABS_MODEL: 'eleven_v4', ...(record ? { HERO_RECORD: record } : {}), ...(replay ? { HERO_REPLAY: replay } : {}) },
});
process.exit(r.status ?? 1);
