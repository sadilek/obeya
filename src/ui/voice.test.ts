import { describe, expect, test } from 'bun:test';
import { stillOpen } from './voice';

const mic = (tracks: { readyState: string; muted: boolean }[], state = 'running') => ({
  stream: { getAudioTracks: () => tracks } as unknown as MediaStream,
  ctx: { state },
});

describe('stillOpen', () => {
  test('a live track delivers, also with the audio context suspended', () => {
    expect(stillOpen(mic([{ readyState: 'live', muted: false }]))).toBe(true);
    expect(stillOpen(mic([{ readyState: 'live', muted: false }], 'suspended'))).toBe(true);
  });
  test('a track the phone ended or muted, or a closed context, is opened afresh', () => {
    expect(stillOpen(mic([{ readyState: 'ended', muted: false }]))).toBe(false);
    expect(stillOpen(mic([{ readyState: 'live', muted: true }]))).toBe(false);
    expect(stillOpen(mic([]))).toBe(false);
    expect(stillOpen(mic([{ readyState: 'live', muted: false }], 'closed'))).toBe(false);
  });
});
