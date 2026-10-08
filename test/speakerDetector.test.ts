import { describe, expect, it } from 'vitest';
import { SpeakerDetector } from '../src/sfu/SpeakerDetector.js';

describe('SpeakerDetector', () => {
  it('emits top speakers only when voice levels cross the threshold', () => {
    let now = 1_000;
    const detector = new SpeakerDetector({ threshold: 50, now: () => now, emitIntervalMs: 0 });

    expect(detector.update('quiet', 80, true)).toBeUndefined();
    now += 20;
    expect(detector.update('alice', 30, true)).toEqual([{ peerId: 'alice', level: 30 }]);
    now += 20;
    expect(detector.update('bob', 20, true)).toEqual([
      { peerId: 'bob', level: 20 },
      { peerId: 'alice', level: 30 }
    ]);
  });

  it('drops old samples from the active window', () => {
    let now = 1_000;
    const detector = new SpeakerDetector({ threshold: 50, now: () => now, emitIntervalMs: 0, windowMs: 100 });

    detector.update('alice', 20, true);
    now += 200;
    expect(detector.currentSpeakers()).toEqual([]);
  });
});
