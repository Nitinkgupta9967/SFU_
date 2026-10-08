import { describe, expect, it } from 'vitest';
import { RtpRewriter } from '../src/sfu/RtpRewriter.js';
import type { RtpPacket } from '../src/transport/IMediaTransport.js';

function pkt(sequenceNumber: number, timestamp: number): RtpPacket {
  return {
    header: { payloadType: 96, sequenceNumber, timestamp, ssrc: 1234, marker: false, rid: 'f' },
    payload: Buffer.from([0x10, 0x00])
  };
}

describe('RtpRewriter', () => {
  it('rewrites ssrc, payload type, sequence and timestamp without mutating payload', () => {
    const rewriter = new RtpRewriter({
      kind: 'video',
      ssrc: 999,
      payloadType: 120,
      initialSequenceNumber: 5000,
      initialTimestamp: 90_000
    });

    const input = pkt(100, 10_000);
    const out = rewriter.rewrite(input);

    expect(out.header).toEqual({
      payloadType: 120,
      sequenceNumber: 5000,
      timestamp: 90_000,
      ssrc: 999,
      marker: false
    });
    expect(out.payload).toBe(input.payload);
    expect(input.header.ssrc).toBe(1234);
  });

  it('rebases after pause while keeping outbound sequence continuity', () => {
    const rewriter = new RtpRewriter({
      kind: 'video',
      ssrc: 999,
      payloadType: 120,
      initialSequenceNumber: 65534,
      initialTimestamp: 1_000
    });

    expect(rewriter.rewrite(pkt(10, 100)).header.sequenceNumber).toBe(65534);
    expect(rewriter.rewrite(pkt(11, 200)).header.sequenceNumber).toBe(65535);

    rewriter.rebase(pkt(900, 9_000));
    const out = rewriter.rewrite(pkt(900, 9_000));

    expect(out.header.sequenceNumber).toBe(0);
    expect(out.header.timestamp).toBe(4_100);
  });
});
