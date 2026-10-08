import { describe, expect, it } from 'vitest';
import { Consumer } from '../src/sfu/Consumer.js';
import { Producer } from '../src/sfu/Producer.js';
import { FakeIncomingTrack, FakeOutgoingTrack } from '../src/transport/FakeTransport.js';
import type { RtpPacket } from '../src/transport/IMediaTransport.js';

function packet(seq: number, payload = Buffer.from([0x10, 0x01])): RtpPacket {
  return {
    header: { payloadType: 96, sequenceNumber: seq, timestamp: seq * 3000, ssrc: 123, marker: false },
    payload
  };
}

describe('Consumer', () => {
  it('keeps video gated until a keyframe and requests PLI while gated', () => {
    const incoming = new FakeIncomingTrack('0', 'video', 111, 96);
    const producer = new Producer({
      trackSid: 'TR_video',
      peerId: 'p_pub',
      kind: 'video',
      source: 'camera',
      incoming,
      pliThrottleMs: 0
    });
    const outgoing = new FakeOutgoingTrack('video', 999, 96);
    const consumer = new Consumer({ producer, subscriberPeerId: 'p_sub', outgoing, packetCacheSize: 8 });
    producer.addConsumer(consumer);

    incoming.pushRtp(packet(1));
    expect(outgoing.written).toHaveLength(0);
    expect(incoming.keyframeRequests).toBeGreaterThan(0);

    incoming.pushRtp(packet(2, Buffer.from([0x10, 0x00])));
    expect(outgoing.written).toHaveLength(1);
    expect(outgoing.written[0]?.header.ssrc).toBe(999);
  });

  it('serves NACKs from the rewritten packet cache', () => {
    const incoming = new FakeIncomingTrack('0', 'video', 111, 96);
    const producer = new Producer({
      trackSid: 'TR_video',
      peerId: 'p_pub',
      kind: 'video',
      source: 'camera',
      incoming,
      pliThrottleMs: 0
    });
    const outgoing = new FakeOutgoingTrack('video', 999, 96);
    const consumer = new Consumer({ producer, subscriberPeerId: 'p_sub', outgoing, packetCacheSize: 8 });
    producer.addConsumer(consumer);

    incoming.pushRtp(packet(20, Buffer.from([0x10, 0x00])));
    const sentSeq = outgoing.written[0]!.header.sequenceNumber;
    outgoing.pushFeedback({ type: 'nack', sequenceNumbers: [sentSeq] });

    expect(outgoing.written).toHaveLength(2);
    expect(outgoing.written[1]).toBe(outgoing.written[0]);
    expect(consumer.retransmits).toBe(1);
  });
});
