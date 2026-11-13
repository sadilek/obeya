import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import { MIC_RECHECK_MS, micHolder, stillOpen } from './voice';

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
  // the holder's own timer is faked: on a busy machine a real one fires late and the tests go wrong
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());
  const holder = (keptMs = 10_000) => {
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
  /** Lets what waits on a settled promise run. */
  const settle = () => new Promise((r) => setImmediate(r));

  test('the microphone is let go a while after the last recording, and opened afresh by the next press', async () => {
    const { h, log } = holder();
    expect(await h.take()).toBe(1);
    h.release();
    jest.advanceTimersByTime(9_999);
    expect(log).toEqual(['open 1']);
    jest.advanceTimersByTime(1);
    expect(log).toEqual(['open 1', 'close 1']);
    expect(await h.take()).toBe(2);
  });

  test('a press within the while keeps the open microphone', async () => {
    const { h, log } = holder();
    await h.take();
    h.release();
    jest.advanceTimersByTime(5_000);
    expect(await h.take()).toBe(1);
    jest.advanceTimersByTime(20_000);
    expect(log).toEqual(['open 1']);
  });

  test('dropped, it closes at once', async () => {
    const { h, log } = holder();
    await h.take();
    h.release();
    h.drop();
    expect(log).toEqual(['open 1', 'close 1']);
  });

  test('an open microphone dropped for a fresh one closes before the fresh one opens', async () => {
    const { h, log } = holder();
    await h.take();
    h.drop();
    expect(await h.take()).toBe(2);
    expect(log).toEqual(['open 1', 'close 1', 'open 2']);
  });

  test('dropped while it opens, it closes once open', async () => {
    const { h, log } = holder();
    const opening = h.take();
    h.drop();
    expect(await opening).toBe(1);
    await settle();
    expect(log).toEqual(['open 1', 'close 1']);
  });
});

describe('micHolder while the page plays sound', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('the microphone is kept until the sound stops, and let go then', async () => {
    const log: string[] = [];
    let playing = true;
    const h = micHolder(
      async () => (log.push('open'), 1),
      () => log.push('close'),
      10_000,
      () => playing,
    );
    await h.take();
    h.release();
    jest.advanceTimersByTime(60_000);
    expect(log).toEqual(['open']);
    playing = false;
    jest.advanceTimersByTime(MIC_RECHECK_MS);
    expect(log).toEqual(['open', 'close']);
  });

  test('a press while it waits for the sound keeps it, and the wait starts again from its release', async () => {
    const log: string[] = [];
    let playing = true;
    const h = micHolder(
      async () => (log.push('open'), 1),
      () => log.push('close'),
      10_000,
      () => playing,
    );
    await h.take();
    h.release();
    jest.advanceTimersByTime(15_000);
    await h.take();
    playing = false;
    jest.advanceTimersByTime(30_000);
    expect(log).toEqual(['open']);
    h.release();
    jest.advanceTimersByTime(10_000);
    expect(log).toEqual(['open', 'close']);
  });
});
