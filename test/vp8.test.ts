import { describe, expect, it } from 'vitest';
import { isVp8KeyframeStart } from '../src/sfu/codecs/vp8.js';

describe('isVp8KeyframeStart', () => {
  it('recognizes the first packet of a VP8 keyframe', () => {
    expect(isVp8KeyframeStart(Buffer.from([0x10, 0x00]))).toBe(true);
  });

  it('rejects delta frames and non-starting packets', () => {
    expect(isVp8KeyframeStart(Buffer.from([0x10, 0x01]))).toBe(false);
    expect(isVp8KeyframeStart(Buffer.from([0x00, 0x00]))).toBe(false);
  });

  it('skips payload descriptor extensions', () => {
    const payload = Buffer.from([0x90, 0x80, 0x81, 0x22, 0x00]);
    expect(isVp8KeyframeStart(payload)).toBe(true);
  });
});
