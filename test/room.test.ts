import { describe, expect, it } from 'vitest';
import { RoomManager } from '../src/sfu/RoomManager.js';
import { FakeIncomingTrack, FakeTransport } from '../src/transport/FakeTransport.js';
import { newTransportId } from '../src/util/ids.js';

describe('Room', () => {
  it('creates consumers for other peers when a producer is published', () => {
    const transports: FakeTransport[] = [];
    const manager = new RoomManager({
      maxPeersPerRoom: 4,
      emptyRoomTtlMs: 30_000,
      pliThrottleMs: 0,
      negotiationDebounceMs: 0,
      speakerThreshold: 50,
      packetCacheSize: 8,
      createTransport: (role) => {
        const transport = new FakeTransport(newTransportId(), role);
        transports.push(transport);
        return transport;
      }
    });
    const room = manager.getOrCreate('demo');
    const messagesA: unknown[] = [];
    const messagesB: unknown[] = [];
    const alice = room.addPeer('Alice', (m) => messagesA.push(m));
    const bob = room.addPeer('Bob', (m) => messagesB.push(m));
    const trackSid = room.registerPendingTrack(alice.id, { cid: 'camera-1', kind: 'video', source: 'camera' });
    const incoming = new FakeIncomingTrack('0', 'video', 123, 96);

    const producer = room.addProducerFromIncomingTrack(alice.id, trackSid, 'camera-1', incoming);

    expect(producer.consumers).toHaveLength(1);
    expect(bob.consumers.has(trackSid)).toBe(true);
    expect(alice.consumers.has(trackSid)).toBe(false);
    expect(messagesB).toContainEqual({
      type: 'notification',
      event: 'track.published',
      data: { track: producer.toTrackInfo() }
    });
    expect(transports.some((t) => t.role === 'subscriber' && t.outgoingTracks.length === 1)).toBe(true);
  });

  it('catches up a late joiner to existing producers', () => {
    const manager = new RoomManager({
      maxPeersPerRoom: 4,
      emptyRoomTtlMs: 30_000,
      pliThrottleMs: 0,
      negotiationDebounceMs: 0,
      speakerThreshold: 50,
      packetCacheSize: 8,
      createTransport: (role) => new FakeTransport(newTransportId(), role)
    });
    const room = manager.getOrCreate('demo');
    const alice = room.addPeer('Alice', () => {});
    const trackSid = room.registerPendingTrack(alice.id, { cid: 'mic-1', kind: 'audio', source: 'microphone' });
    room.addProducerFromIncomingTrack(alice.id, trackSid, 'mic-1', new FakeIncomingTrack('0', 'audio', 123, 111));

    const bob = room.addPeer('Bob', () => {});

    expect(bob.consumers.has(trackSid)).toBe(true);
  });
});
