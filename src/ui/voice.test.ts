import { describe, expect, test } from 'bun:test';
import { micHolder, stillOpen } from './voice';

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

describe('micHolder', () => {
  const holder = (keptMs: number) => {
    const log: string[] = [];
    let n = 0;
    const h = micHolder(
      async () => {
        log.push(`open ${++n}`);
        return n;
      },
      (m) => log.push(`close ${m}`),
      keptMs,
    );
    return { h, log };
  };
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  test('the microphone is let go a while after the last recording, and opened afresh by the next press', async () => {
    const { h, log } = holder(20);
    expect(await h.take()).toBe(1);
    h.release();
    await wait(5);
    expect(log).toEqual(['open 1']);
    await wait(40);
    expect(log).toEqual(['open 1', 'close 1']);
    expect(await h.take()).toBe(2);
  });

  test('a press within the while keeps the open microphone', async () => {
    const { h, log } = holder(20);
    await h.take();
    h.release();
    await wait(5);
    expect(await h.take()).toBe(1);
    await wait(40);
    expect(log).toEqual(['open 1']);
  });

  test('dropped, it closes at once', async () => {
    const { h, log } = holder(1000);
    await h.take();
    h.release();
    h.drop();
    await wait(0);
    expect(log).toEqual(['open 1', 'close 1']);
  });
});
