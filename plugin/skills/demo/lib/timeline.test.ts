import { describe, expect, test } from 'bun:test';
import { frameDurations, laterLabel, videoTime } from './timeline.ts';

const frame = (t: number) => ({ file: `f${t}`, t, width: 1440, height: 900 });

describe('the video timeline', () => {
  test('a cut takes its stretch out of everything after it', () => {
    const cuts = [{ from: 110, to: 140 }];
    expect(videoTime(105, 100, cuts)).toBe(5);
    expect(videoTime(120, 100, cuts)).toBe(10);
    expect(videoTime(150, 100, cuts)).toBe(20);
    expect(videoTime(150, 100, [...cuts, { from: 145, to: 148 }])).toBe(17);
  });

  test('a frame is held until the next one, less the cut, and one seen only inside the cut is dropped', () => {
    const frames = [frame(99), frame(105), frame(120), frame(130), frame(145)];
    const held = frameDurations(frames, 100, 150, [{ from: 110, to: 140 }]);
    // f105 runs to the cut; f120 shows only inside it; f130 is the last state before it ends.
    expect(held.map((h) => h.file)).toEqual(['f99', 'f105', 'f130', 'f145']);
    expect(held.map((h) => +h.seconds.toFixed(3))).toEqual([5, 5, 5, 5]);
  });

  test('without cuts, frames run in real time', () => {
    const held = frameDurations([frame(100), frame(101.5)], 100, 103, []);
    expect(held.map((h) => h.seconds)).toEqual([1.5, 1.5]);
  });

  test('the picture says how much later it is', () => {
    expect(laterLabel(31.4, 'de')).toBe('31 Sekunden später');
    expect(laterLabel(0.4, 'de')).toBe('eine Sekunde später');
    expect(laterLabel(75, 'de')).toBe('eine Minute später');
    expect(laterLabel(200, 'de')).toBe('3 Minuten später');
    expect(laterLabel(12, 'en')).toBe('12 seconds later');
    expect(laterLabel(130, 'en')).toBe('2 minutes later');
  });
});
