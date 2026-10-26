import { describe, expect, it } from 'vitest';
import { RollingMediaBuffer } from '../src/sfu/RollingMediaBuffer.js';
import type { RtpPacket } from '../src/transport/IMediaTransport.js';

function makePacket(seq: number, ts: number, payloadLength = 100): RtpPacket {
  return {
    header: {
      payloadType: 96,
      sequenceNumber: seq,
      timestamp: ts,
      ssrc: 12345,
      marker: false
    },
    payload: Buffer.alloc(payloadLength, seq % 256)
  };
}

describe('RollingMediaBuffer', () => {
  it('stores packets with arrival timestamps and keyframe index', () => {
    const buffer = new RollingMediaBuffer({ windowMs: 30_000, kind: 'video' });
    const pkt1 = makePacket(1, 1000);
    const pkt2 = makePacket(2, 2000);

    buffer.append(pkt1, 10_000, true);
    buffer.append(pkt2, 11_000, false);

    expect(buffer.length).toBe(2);
    expect(buffer.bytes).toBe(200);
    expect(buffer.keyframesCount).toBe(1);
    expect(buffer.oldestArrivalTimeMs).toBe(10_000);
    expect(buffer.newestArrivalTimeMs).toBe(11_000);
    expect(buffer.durationMs).toBe(1000);

    const first = buffer.get(0);
    expect(first?.isKeyframeStart).toBe(true);
    expect(first?.packet.header.sequenceNumber).toBe(1);
    // Header should be cloned, not same reference
    expect(first?.packet.header).not.toBe(pkt1.header);
    // Payload should share underlying buffer (zero-copy)
    expect(first?.packet.payload).toBe(pkt1.payload);
  });

  it('finds nearest keyframe start index for video replay', () => {
    const buffer = new RollingMediaBuffer({ windowMs: 60_000, kind: 'video' });

    buffer.append(makePacket(1, 100), 1000, true); // KF at 1000 (idx 0)
    buffer.append(makePacket(2, 200), 2000, false);
    buffer.append(makePacket(3, 300), 3000, false);
    buffer.append(makePacket(4, 400), 4000, true); // KF at 4000 (idx 3)
    buffer.append(makePacket(5, 500), 5000, false);
    buffer.append(makePacket(6, 600), 6000, true); // KF at 6000 (idx 5)
    buffer.append(makePacket(7, 700), 7000, false);

    // Target between KF 1 and KF 2 -> should return index of KF at 1000 (0)
    expect(buffer.findStartIndex(3500)).toBe(0);

    // Target exactly at KF 2 -> should return index of KF at 4000 (3)
    expect(buffer.findStartIndex(4000)).toBe(3);

    // Target between KF 2 and KF 3 -> should return index of KF at 4000 (3)
    expect(buffer.findStartIndex(5500)).toBe(3);

    // Target after KF 3 -> should return index of KF at 6000 (5)
    expect(buffer.findStartIndex(8000)).toBe(5);

    // Target before any KF -> should return earliest available KF (0)
    expect(buffer.findStartIndex(500)).toBe(0);
  });

  it('evicts old packets by age while never evicting past the last keyframe before the window cutoff', () => {
    // 10 second window
    const buffer = new RollingMediaBuffer({ windowMs: 10_000, kind: 'video' });

    // Stream timeline:
    // t=1000: KF1
    // t=3000: delta
    // t=6000: KF2
    // t=8000: delta
    // t=15000: KF3
    // t=18000: delta
    // t=21000: delta
    buffer.append(makePacket(1, 100), 1000, true);
    buffer.append(makePacket(2, 200), 3000, false);
    buffer.append(makePacket(3, 300), 6000, true);
    buffer.append(makePacket(4, 400), 8000, false);
    buffer.append(makePacket(5, 500), 15_000, true);
    buffer.append(makePacket(6, 600), 18_000, false);

    // At t=21_000, cutoff is 21_000 - 10_000 = 11_000.
    // The keyframes are:
    // KF1 at 1000 (<= 11000)
    // KF2 at 6000 (<= 11000)
    // KF3 at 15000 (> 11000)
    // The last keyframe before or at cutoff 11000 is KF2 at 6000!
    // So packets before 6000 (KF1 and t=3000 delta) are evicted.
    // KF2 and all packets from 6000 onwards are preserved!
    buffer.append(makePacket(7, 700), 21_000, false);

    const remaining = buffer.toArray();
    expect(remaining.length).toBe(5);
    expect(remaining[0].arrivalTimeMs).toBe(6000);
    expect(remaining[0].isKeyframeStart).toBe(true);
    expect(remaining[0].packet.header.sequenceNumber).toBe(3);

    // Keyframe indices should be updated to point to valid indices in remaining buffer
    const kfIndices = buffer.getKeyframeIndices();
    expect(kfIndices).toEqual([0, 2]); // KF2 is at 0 (t=6000), KF3 is at 2 (t=15000)
  });

  it('evicts audio packets strictly by age cutoff', () => {
    const buffer = new RollingMediaBuffer({ windowMs: 5000, kind: 'audio' });

    buffer.append(makePacket(1, 100), 1000);
    buffer.append(makePacket(2, 200), 3000);
    buffer.append(makePacket(3, 300), 5000);
    buffer.append(makePacket(4, 400), 7000);

    // At t=8000, cutoff is 3000. Packets strictly < 3000 (t=1000) are dropped.
    buffer.append(makePacket(5, 500), 8000);

    const remaining = buffer.toArray();
    expect(remaining.map((p) => p.arrivalTimeMs)).toEqual([3000, 5000, 7000, 8000]);
  });

  it('enforces maxPackets and maxBytes capacity limits', () => {
    const buffer = new RollingMediaBuffer({
      windowMs: 60_000,
      maxPackets: 3,
      maxBytes: 300,
      kind: 'video'
    });

    buffer.append(makePacket(1, 100, 100), 1000, true);
    buffer.append(makePacket(2, 200, 100), 2000, false);
    buffer.append(makePacket(3, 300, 100), 3000, false);
    expect(buffer.length).toBe(3);
    expect(buffer.bytes).toBe(300);

    // Exceeding maxPackets/maxBytes forces eviction of oldest packet
    buffer.append(makePacket(4, 400, 100), 4000, false);
    expect(buffer.length).toBe(3);
    expect(buffer.bytes).toBe(300);
    expect(buffer.get(0)?.packet.header.sequenceNumber).toBe(2);
  });

  it('handles empty buffer queries and clear()', () => {
    const buffer = new RollingMediaBuffer();
    expect(buffer.length).toBe(0);
    expect(buffer.bytes).toBe(0);
    expect(buffer.oldestArrivalTimeMs).toBeNull();
    expect(buffer.newestArrivalTimeMs).toBeNull();
    expect(buffer.findStartIndex(1000)).toBeNull();

    buffer.append(makePacket(1, 100), 1000);
    expect(buffer.length).toBe(1);

    buffer.clear();
    expect(buffer.length).toBe(0);
    expect(buffer.bytes).toBe(0);
    expect(buffer.getKeyframeIndices()).toEqual([]);
  });
});
