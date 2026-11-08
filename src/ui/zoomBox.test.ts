import { expect, test } from 'bun:test';
import { behindThumb, onto, ZOOM_BELOW, ZOOM_MARGIN, zoomBox } from './zoomBox';

test('a wide window: the zoomed video takes the height above the microphone, centred', () => {
  const b = zoomBox(16 / 9, 2560, 1400);
  expect(b.height).toBe(1400 - ZOOM_MARGIN - ZOOM_BELOW);
  expect(b.width).toBeCloseTo(b.height * (16 / 9));
  expect(b.left).toBeCloseTo((2560 - b.width) / 2);
  expect(b.top).toBe(ZOOM_MARGIN);
});

test('a narrow window: the zoomed video takes the width and stands in the middle above the microphone', () => {
  const b = zoomBox(16 / 9, 1000, 1400);
  expect(b.width).toBe(1000 - 2 * ZOOM_MARGIN);
  expect(b.left).toBe(ZOOM_MARGIN);
  expect(b.top + b.height / 2).toBeCloseTo(ZOOM_MARGIN + (1400 - ZOOM_MARGIN - ZOOM_BELOW) / 2);
});

test('the transform puts the zoomed box back onto the card’s', () => {
  expect(onto({ left: 100, top: 200, width: 400, height: 225 }, { left: 50, top: 40, width: 1600, height: 900 })).toBe('translate(50px, 160px) scale(0.25)');
});

test('a screenshot cropped in its thumbnail stands wider behind it, the thumbnail showing its middle', () => {
  const { box, inset } = behindThumb({ left: 10, top: 20, width: 160, height: 64 }, 4);
  expect(box).toEqual({ left: -38, top: 20, width: 256, height: 64 });
  expect(inset.x).toBeCloseTo(48 / 256);
  expect(inset.y).toBe(0);
});

test('a screenshot whole in its thumbnail stands right on it', () => {
  const { box, inset } = behindThumb({ left: 10, top: 20, width: 100, height: 64 }, 100 / 64);
  expect(box).toEqual({ left: 10, top: 20, width: 100, height: 64 });
  expect(inset).toEqual({ x: 0, y: 0 });
});

test('a walkthrough zoomed keeps room under its slide for its caption and controls', () => {
  const chrome = { fixed: 52, perWidth: 0.06 };
  const b = zoomBox(16 / 10, 2560, 1400, chrome);
  expect(b.height).toBeCloseTo(1400 - ZOOM_MARGIN - ZOOM_BELOW);
  expect(b.height).toBeCloseTo(b.width / 1.6 + 52 + 0.06 * b.width);
  expect(b.top).toBeCloseTo(ZOOM_MARGIN);
});
