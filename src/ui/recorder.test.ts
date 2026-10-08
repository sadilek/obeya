import { expect, test } from 'bun:test';
import { wav } from './recorder';

test('samples become a mono 16-bit WAV, clipped to full scale', async () => {
  const bytes = new DataView(await wav([new Float32Array([0, 0.5]), new Float32Array([-1, 2])], 48000).arrayBuffer());
  const text = (at: number, n: number) => String.fromCharCode(...new Uint8Array(bytes.buffer, at, n));
  expect([text(0, 4), text(8, 4), text(36, 4)]).toEqual(['RIFF', 'WAVE', 'data']);
  expect(bytes.getUint32(24, true)).toBe(48000);
  expect(bytes.getUint32(40, true)).toBe(8);
  expect([0, 1, 2, 3].map((i) => bytes.getInt16(44 + i * 2, true))).toEqual([0, 16383, -32767, 32767]);
});
