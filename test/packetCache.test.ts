import { describe, expect, it } from 'vitest';
import { PacketCache } from '../src/sfu/PacketCache.js';
import type { RtpPacket } from '../src/transport/IMediaTransport.js';

function packet(seq: number): RtpPacket {
  return {
    header: { payloadType: 96, sequenceNumber: seq, timestamp: seq * 10, ssrc: 1, marker: false },
    payload: Buffer.from([seq & 0xff])
  };
}

describe('PacketCache', () => {
  it('returns cached packets by outbound sequence number', () => {
    const cache = new PacketCache(4);
    const p = packet(1201);
    cache.put(p);
    expect(cache.get(1201)).toBe(p);
  });

  it('evicts colliding old packets', () => {
    const cache = new PacketCache(4);
    cache.put(packet(1));
    cache.put(packet(5));
    expect(cache.get(1)).toBeUndefined();
    expect(cache.get(5)?.header.sequenceNumber).toBe(5);
  });
});
