import { notification } from '../signaling/protocol.js';
import type { NotificationEnvelope } from '../signaling/protocol.js';
import type { IMediaTransport } from '../transport/IMediaTransport.js';
import { newPeerId } from '../util/ids.js';
import { systemClock, type Clock } from '../util/time.js';
import { Consumer } from './Consumer.js';
import { Peer, type PeerSession } from './Peer.js';
import type { PendingTrack } from './Peer.js';
import type { Producer } from './Producer.js';
import { SubscribeAllPolicy, type SubscriptionPolicy } from './SubscriptionPolicy.js';
import { SpeakerDetector, type SpeakerInfo } from './SpeakerDetector.js';

export interface RoomOptions {
  id: string;
  maxPeers: number;
  emptyRoomTtlMs: number;
  pliThrottleMs: number;
  negotiationDebounceMs: number;
  speakerThreshold: number;
  packetCacheSize: number;
  reconnectGraceMs?: number;
  lastNVideo?: number;
  createTransport: (role: 'publisher' | 'subscriber') => IMediaTransport;
  onEmptyExpired?: (room: Room) => void;
  clock?: Clock;
  subscriptionPolicy?: SubscriptionPolicy;
}

export class Room {
  readonly id: string;
  readonly createdAt = new Date();
  readonly peers = new Map<string, Peer>();
  private readonly policy: SubscriptionPolicy;
  private readonly speakerDetector: SpeakerDetector;
  private emptyTimer?: NodeJS.Timeout;
  private lastByteSample = { at: Date.now(), in: 0, out: 0, inKbps: 0, outKbps: 0 };

  constructor(private readonly options: RoomOptions) {
    this.id = options.id;
    this.policy = options.subscriptionPolicy ?? new SubscribeAllPolicy();
    this.speakerDetector = new SpeakerDetector({ threshold: options.speakerThreshold });
  }

  addPeer(displayName: string, send: (message: NotificationEnvelope) => void, options: { autoSubscribe?: boolean } = {}): Peer {
    if (this.peers.size >= this.options.maxPeers) {
      throw new Error('ROOM_FULL');
    }
    this.clearEmptyTimer();
    const peer = new Peer({
      id: newPeerId(),
      displayName,
      autoSubscribe: options.autoSubscribe ?? true,
      publisher: this.options.createTransport('publisher'),
      subscriber: this.options.createTransport('subscriber'),
      send,
      pliThrottleMs: this.options.pliThrottleMs,
      negotiationDebounceMs: this.options.negotiationDebounceMs,
      clock: this.options.clock,
      onProducerClosed: (producer) => this.removeProducer(producer),
      onProducerRtp: (producer, pkt) => {
        if (producer.kind !== 'audio' || !pkt.header.audioLevel) return;
        const speakers = this.speakerDetector.update(producer.peerId, pkt.header.audioLevel.level, pkt.header.audioLevel.voice);
        if (speakers) {
          this.broadcast(notification('speakers.changed', { speakers }));
          this.applyLastN(speakers);
        }
      }
    });
    peer.activate();
    this.peers.set(peer.id, peer);
    this.broadcastExcept(peer.id, notification('peer.joined', { peer: peer.toPeerInfo() }));
    this.catchUpPeer(peer);
    return peer;
  }

  reconnectPeer(reconnectToken: string, session: PeerSession): Peer | undefined {
    const peer = [...this.peers.values()].find((candidate) => candidate.reconnectToken === reconnectToken);
    if (!peer || peer.state === 'closed') return undefined;
    this.clearEmptyTimer();
    peer.bindSession(session);
    return peer;
  }

  disconnectPeer(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (!peer || peer.state === 'closed') return;
    peer.startDisconnectGrace(this.options.reconnectGraceMs ?? 10_000, () => {
      this.removePeer(peerId, 'timeout');
    });
  }

  removePeer(peerId: string, reason: 'left' | 'timeout' | 'kicked' = 'left'): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;

    if (reason === 'kicked') {
      peer.closeSession(1000, 'kicked');
    }

    for (const producer of [...peer.producers.values()]) {
      this.removeProducer(producer);
    }
    for (const other of this.peers.values()) {
      if (other.id !== peerId) {
        for (const consumer of [...other.consumers.values()]) {
          if (consumer.producer.peerId === peerId) {
            other.removeConsumer(consumer.producer.trackSid);
          }
        }
      }
    }
    peer.close();
    this.peers.delete(peerId);
    this.speakerDetector.removePeer(peerId);
    this.broadcast(notification('peer.left', { peerId, reason }));
    if (this.peers.size === 0) {
      this.scheduleEmptyClose();
    }
  }

  registerPendingTrack(peerId: string, pending: Omit<PendingTrack, 'trackSid'>): string {
    const peer = this.requirePeer(peerId);
    return peer.addPendingTrack(pending);
  }

  addProducerFromIncomingTrack(peerId: string, trackSid: string, cid: string, incoming: Parameters<Peer['createProducerFromTrack']>[2]): Producer {
    const peer = this.requirePeer(peerId);
    const pending = peer.pendingTracksByCid.get(cid);
    if (!pending) {
      throw new Error('TRACK_NOT_FOUND');
    }
    const producer = peer.createProducerFromTrack(trackSid, pending, incoming);
    this.broadcastExcept(peer.id, notification('track.published', { track: producer.toTrackInfo() }));
    this.createConsumersForProducer(producer);
    return producer;
  }

  muteTrack(peerId: string, trackSid: string, muted: boolean): void {
    const peer = this.requirePeer(peerId);
    const producer = peer.producers.get(trackSid);
    if (!producer) {
      throw new Error('TRACK_NOT_FOUND');
    }
    producer.setMuted(muted);
    this.broadcast(notification('track.muted', { trackSid, peerId, muted }));
  }

  unpublishTrack(peerId: string, trackSid: string): void {
    const peer = this.requirePeer(peerId);
    const producer = peer.producers.get(trackSid);
    if (!producer) {
      throw new Error('TRACK_NOT_FOUND');
    }
    producer.close();
  }

  stats(): {
    roomId: string;
    peerCount: number;
    trackCount: number;
    consumerCount: number;
    createdAt: string;
    peers: number;
    producers: number;
    consumers: number;
    ingressKbps: number;
    egressKbps: number;
  } {
    let trackCount = 0;
    let consumerCount = 0;
    let bytesIn = 0;
    let bytesOut = 0;
    for (const peer of this.peers.values()) {
      trackCount += peer.producers.size;
      consumerCount += peer.consumers.size;
      for (const producer of peer.producers.values()) bytesIn += producer.bytesReceived;
      for (const consumer of peer.consumers.values()) bytesOut += consumer.bytesSent;
    }
    const now = Date.now();
    const dt = Math.max(0.001, (now - this.lastByteSample.at) / 1000);
    this.lastByteSample = {
      at: now,
      in: bytesIn,
      out: bytesOut,
      inKbps: Number((((bytesIn - this.lastByteSample.in) * 8) / 1000 / dt).toFixed(1)),
      outKbps: Number((((bytesOut - this.lastByteSample.out) * 8) / 1000 / dt).toFixed(1))
    };
    return {
      roomId: this.id,
      peerCount: this.peers.size,
      trackCount,
      consumerCount,
      createdAt: this.createdAt.toISOString(),
      peers: this.peers.size,
      producers: trackCount,
      consumers: consumerCount,
      ingressKbps: Math.max(0, this.lastByteSample.inKbps),
      egressKbps: Math.max(0, this.lastByteSample.outKbps)
    };
  }

  detail(): Record<string, unknown> {
    return {
      ...this.stats(),
      peers: [...this.peers.values()].map((peer) => ({
        ...peer.toPeerInfo(),
        state: peer.state,
        producers: [...peer.producers.values()].map((producer) => producer.toStats()),
        consumers: [...peer.consumers.values()].map((consumer) => consumer.toStats())
      }))
    };
  }

  close(reason = 'closed'): void {
    if (this.emptyTimer) this.clock.clearTimeout(this.emptyTimer);
    this.broadcast(notification('room.closed', { reason }));
    for (const peer of [...this.peers.values()]) {
      peer.closeSession(4002, 'room closed');
      peer.close();
    }
    this.peers.clear();
  }

  private createConsumer(peer: Peer, producer: Producer): void {
    const outgoing = peer.subscriber.addOutgoingTrack(producer.kind);
    const consumer = new Consumer({
      producer,
      subscriberPeerId: peer.id,
      outgoing,
      packetCacheSize: this.options.packetCacheSize,
      onSubscriptionChanged: (paused, reason) => {
        peer.send(notification('subscription.changed', { trackSid: producer.trackSid, paused, reason }));
        if (reason === 'bandwidth') {
          peer.send(
            notification('connection.quality', {
              peerId: peer.id,
              quality: paused ? 'poor' : 'good'
            })
          );
        }
      }
    });
    producer.addConsumer(consumer);
    peer.addConsumer(consumer);
  }

  private createConsumersForProducer(producer: Producer): void {
    for (const peer of this.peers.values()) {
      if (!this.policy.shouldAutoSubscribe(peer, producer)) continue;
      this.createConsumer(peer, producer);
    }
  }

  private catchUpPeer(peer: Peer): void {
    for (const existing of this.peers.values()) {
      if (existing.id === peer.id) continue;
      for (const producer of existing.producers.values()) {
        if (!this.policy.shouldAutoSubscribe(peer, producer)) continue;
        this.createConsumer(peer, producer);
      }
    }
  }

  private applyLastN(speakers: SpeakerInfo[]): void {
    const lastN = this.options.lastNVideo ?? 0;
    if (lastN <= 0) return;
    const allowed = new Set(speakers.slice(0, lastN).map((speaker) => speaker.peerId));
    if (allowed.size === 0) return;

    for (const peer of this.peers.values()) {
      for (const consumer of peer.consumers.values()) {
        if (consumer.producer.kind !== 'video' || consumer.producer.source === 'screen') continue;
        const shouldPause = !allowed.has(consumer.producer.peerId);
        if (shouldPause && !consumer.pausedByServer) {
          consumer.pause(true);
          peer.send(
            notification('subscription.changed', {
              trackSid: consumer.producer.trackSid,
              paused: true,
              reason: 'policy'
            })
          );
        } else if (!shouldPause && consumer.pausedByServer) {
          consumer.resume();
          peer.send(
            notification('subscription.changed', {
              trackSid: consumer.producer.trackSid,
              paused: false,
              reason: 'policy'
            })
          );
        }
      }
    }
  }

  private removeProducer(producer: Producer): void {
    const owner = this.peers.get(producer.peerId);
    owner?.producers.delete(producer.trackSid);
    for (const peer of this.peers.values()) {
      peer.removeConsumer(producer.trackSid);
    }
    this.broadcastExcept(producer.peerId, notification('track.unpublished', { trackSid: producer.trackSid, peerId: producer.peerId }));
  }

  private broadcast(message: NotificationEnvelope): void {
    for (const peer of this.peers.values()) {
      peer.send(message);
    }
  }

  private broadcastExcept(excludedPeerId: string, message: NotificationEnvelope): void {
    for (const peer of this.peers.values()) {
      if (peer.id !== excludedPeerId) {
        peer.send(message);
      }
    }
  }

  private requirePeer(peerId: string): Peer {
    const peer = this.peers.get(peerId);
    if (!peer) {
      throw new Error('PEER_NOT_FOUND');
    }
    return peer;
  }

  private clearEmptyTimer(): void {
    if (this.emptyTimer) {
      this.clock.clearTimeout(this.emptyTimer);
      this.emptyTimer = undefined;
    }
  }

  private scheduleEmptyClose(): void {
    if (this.options.emptyRoomTtlMs === 0) {
      this.options.onEmptyExpired?.(this);
      return;
    }
    this.emptyTimer = this.clock.setTimeout(() => this.options.onEmptyExpired?.(this), this.options.emptyRoomTtlMs);
  }

  private get clock(): Clock {
    return this.options.clock ?? systemClock;
  }
}
