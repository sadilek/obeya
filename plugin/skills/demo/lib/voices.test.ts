import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installState, onMlx, qwen3Serve, voiceSpec } from './voices.ts';

let home: string;
let hub: string;
const hubBefore = process.env.HF_HUB_CACHE;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'obeya-voices-'));
  hub = join(home, 'hub');
  process.env.HF_HUB_CACHE = hub;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (hubBefore === undefined) delete process.env.HF_HUB_CACHE;
  else process.env.HF_HUB_CACHE = hubBefore;
});

describe('voices', () => {
  test('Piper speaks with the voice of the language, from its own environment in the home', () => {
    const spec = voiceSpec({ language: 'de', voice: 'piper' }, home);
    expect(spec).toMatchObject({ kind: 'command', tag: 'piper|de_DE-thorsten-high', heavy: false });
    expect(spec.kind === 'command' && spec.argv).toContain(join(home, 'voices', 'piper', 'de_DE-thorsten-high.onnx'));
    expect(voiceSpec({ language: 'en', voice: 'piper' }, home)).toMatchObject({ tag: 'piper|en_US-ryan-high' });
    expect(voiceSpec({ language: 'en', voice: 'piper', voiceName: 'en_GB-alan-medium' }, home)).toMatchObject({ tag: 'piper|en_GB-alan-medium' });
  });

  test('Piper is installed once its environment and its voice are there', () => {
    const s = { language: 'de', voice: 'piper' } as const;
    expect(installState(s, home)).toEqual({ installed: false, missing: ['Piper', 'Piper-Stimme de_DE-thorsten-high'], mb: 265 });
    mkdirSync(join(home, 'voices', 'piper', 'env'), { recursive: true });
    writeFileSync(join(home, 'voices', 'piper', 'env', '.obeya-installed'), '');
    writeFileSync(join(home, 'voices', 'piper', 'de_DE-thorsten-high.onnx'), '');
    expect(installState(s, home).missing).toEqual(['Piper-Stimme de_DE-thorsten-high']);
    writeFileSync(join(home, 'voices', 'piper', 'de_DE-thorsten-high.onnx.json'), '{}');
    expect(installState(s, home)).toEqual({ installed: true, missing: [], mb: 0 });
    // another language needs its own voice
    expect(installState({ language: 'en', voice: 'piper' }, home).missing).toEqual(['Piper-Stimme en_US-ryan-high']);
  });

  test('Qwen3-TTS speaks with a stock speaker, or clones a clip; a model downloaded before counts as installed', () => {
    const stock = voiceSpec({ language: 'de', voice: 'qwen3' }, home);
    expect(stock).toMatchObject({ kind: 'command', heavy: true });
    expect(stock.kind === 'command' && stock.argv).toEqual(expect.arrayContaining(['--speaker', 'ryan', '--language', 'de']));
    const clone = voiceSpec({ language: 'de', voice: 'qwen3', reference: '/x/me.wav' }, home);
    expect(clone.kind === 'command' && clone.argv).toEqual(expect.arrayContaining(['--reference', '/x/me.wav']));
    const repo = onMlx() ? 'mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-bf16' : 'Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice';
    expect(stock.kind === 'command' && stock.argv).toContain(repo);
    expect(installState({ language: 'de', voice: 'qwen3' }, home).missing).toHaveLength(2);
    const snapshot = join(hub, `models--${repo.replace('/', '--')}`, 'snapshots', 'abc');
    mkdirSync(snapshot, { recursive: true });
    writeFileSync(join(snapshot, 'config.json'), '{}');
    expect(installState({ language: 'de', voice: 'qwen3' }, home).missing).toHaveLength(2);
    writeFileSync(join(snapshot, 'model.safetensors'), '');
    expect(installState({ language: 'de', voice: 'qwen3' }, home).missing).toEqual([onMlx() ? 'Qwen3-TTS (MLX)' : 'Qwen3-TTS (PyTorch)']);
  });

  test('Qwen3-TTS stays loaded for a render; Piper, say and the own command run once per clip', () => {
    for (const s of [{ language: 'de', voice: 'qwen3' }, { language: 'en', voice: 'qwen3', reference: '/x/me.wav' }] as const) {
      const spec = voiceSpec(s, home);
      if (spec.kind !== 'command' || !spec.argv || !spec.serve) throw new Error('Qwen3-TTS has no serve command');
      // the same voice, model and language as one clip, just without a WAV of its own
      expect(spec.serve).toEqual([...spec.argv.slice(0, -2), '--serve']);
      expect(spec.argv.slice(-2)).toEqual(['--out', '{out}']);
      // what Obeya runs to hold it across renders is the same command
      expect(spec.host).toEqual('reference' in s ? { reference: '/x/me.wav' } : { speaker: 'ryan' });
      expect(qwen3Serve(spec.host!, s.language, home)).toEqual(spec.serve);
    }
    for (const voice of ['piper', 'say', 'command'] as const) {
      expect(voiceSpec({ language: 'de', voice, command: 'speak' }, home)).not.toHaveProperty('serve');
    }
  });

  test('the own command runs through the shell and takes the machine like a clone; services need nothing installed', () => {
    expect(voiceSpec({ language: 'de', voice: 'command', command: 'speak --fast' }, home)).toEqual({
      kind: 'command',
      shell: 'speak --fast',
      tag: 'command|speak --fast',
      heavy: true,
    });
    expect(voiceSpec({ language: 'de', voice: 'say' }, home)).toMatchObject({ tag: 'say|Anna', heavy: false });
    expect(voiceSpec({ language: 'en', voice: 'elevenlabs', voiceName: 'abc', keyFile: '~/k' }, home)).toMatchObject({
      kind: 'http',
      service: 'elevenlabs',
      voiceName: 'abc',
      keyFile: expect.not.stringContaining('~'),
    });
    expect(voiceSpec({ language: 'en', voice: 'http', url: 'http://x' }, home)).toMatchObject({ kind: 'http', service: 'http', url: 'http://x' });
    for (const voice of ['say', 'command', 'http', 'gemini', 'openai', 'elevenlabs', 'azure'] as const) {
      expect(installState({ language: 'de', voice }, home).installed).toBe(true);
    }
  });
});
