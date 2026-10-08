// Renders the hero video (`demo.ts`) in the owner's ElevenLabs voice, without touching Obeya's own
// demo settings: a home of its own beside the output holds the voice settings, its voices directory
// is Obeya's (for Whisper to listen back). The key lies in `.voice/elevenlabs.key` of the main
// checkout, gitignored. Arguments go on to the demo (`--narration`, `--dry`).
//
//   node scripts/hero-video/render.ts [--narration | --dry]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const VOICE = 'IErGHDQU4vPqicCi8dwR';
const OUT = process.env.HERO_OUT ?? path.join(os.homedir(), 'demos', 'obeya-hero');
const common = spawnSync('git', ['-C', import.meta.dirname, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).stdout.trim();
const keyFile = path.join(path.dirname(common), '.voice', 'elevenlabs.key');
if (!fs.existsSync(keyFile)) {
  console.error(`no ElevenLabs key at ${keyFile}`);
  process.exit(1);
}

const home = path.join(OUT, 'home');
fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(path.join(home, 'demo.json'), JSON.stringify({ language: 'en', voice: 'elevenlabs', ownVoice: true, voiceName: VOICE, keyFile }, null, 2));
const voices = path.join(process.env.OBEYA_HOME ?? path.join(os.homedir(), '.obeya'), 'voices');
if (fs.existsSync(voices) && !fs.existsSync(path.join(home, 'voices'))) fs.symlinkSync(voices, path.join(home, 'voices'));

const r = spawnSync('node', [path.join(import.meta.dirname, 'demo.ts'), ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, OBEYA_HOME: home, HERO_OUT: OUT, DEMO_ELEVENLABS_MODEL: 'eleven_v4' },
});
process.exit(r.status ?? 1);
