import type { NotificationEnvelope, PeerInfo, TrackSource } from '../signaling/protocol.js';
import type { IMediaTransport, IncomingTrack, RtpPacket } from '../transport/IMediaTransport.js';
import { newReconnectToken, newTrackSid } from '../util/ids.js';
import type { Clock } from '../util/time.js';
import { systemClock } from '../util/time.js';
import type { Consumer } from './Consumer.js';
import { Producer } from './Producer.js';
import { SubscriberNegotiator } from './SubscriberNegotiator.js';

export type PeerState = 'joining' | 'active' | 'disconnected' | 'closed';

export interface PendingTrack {
  cid: string;
  trackSid: string;
  kind: 'audio' | 'video';
  source: TrackSource;
}

export interface PeerSession {
  send: (message: NotificationEnvelope) => void;
  close: (code: number, reason: string) => void;
}

export interface PeerOptions {
  id: string;
  displayName: string;
  autoSubscribe: boolean;
  publisher: IMediaTransport;
  subscriber: IMediaTransport;
  send: (message: NotificationEnvelope) => void;
  pliThrottleMs: number;
  negotiationDebounceMs: number;
  clock?: Clock;
  onProducerClosed?: (producer: Producer) => void;
  onProducerRtp?: (producer: Producer, pkt: RtpPacket) => void;
}

export class Peer {
  readonly id: string;
  readonly displayName: string;
  readonly autoSubscribe: boolean;
  readonly publisher: IMediaTransport;
  readonly subscriber: IMediaTransport;
  readonly producers = new Map<string, Producer>();
  readonly consumers = new Map<string, Consumer>();
  readonly pendingTracksByCid = new Map<string, PendingTrack>();
  readonly negotiator: SubscriberNegotiator;
  readonly reconnectToken = newReconnectToken();
  state: PeerState = 'joining';
  private session?: PeerSession;
  private graceTimer?: NodeJS.Timeout;

  constructor(private readonly options: PeerOptions) {
    this.id = options.id;
    this.displayName = options.displayName;
    this.autoSubscribe = options.autoSubscribe;
    this.publisher = options.publisher;
    this.subscriber = options.subscriber;
    this.session = { send: options.send, close: () => undefined };
    this.negotiator = new SubscriberNegotiator({
      peer: this,
      transport: this.subscriber,
      debounceMs: options.negotiationDebounceMs,
      clock: options.clock
    });
  }

  activate(): void {
    if (this.state === 'joining' || this.state === 'disconnected') {
      this.state = 'active';
    }
  }

  isCurrentSession(session: PeerSession): boolean {
    return this.session === session;
  }

  bindSession(session: PeerSession): void {
    if (this.session && this.session !== session) {
      this.session.close(4004, 'session replaced');
    }
    this.session = session;
    if (this.graceTimer) {
      this.clock.clearTimeout(this.graceTimer);
      this.graceTimer = undefined;
    }
    this.state = 'active';
  }

  startDisconnectGrace(ms: number, onExpire: () => void): void {
    if (this.state === 'closed') return;
    this.state = 'disconnected';
    this.session = undefined;
    if (this.graceTimer) this.clock.clearTimeout(this.graceTimer);
    this.graceTimer = this.clock.setTimeout(onExpire, ms);
  }

  send(message: NotificationEnvelope): void {
    this.session?.send(message);
  }

  closeSession(code: number, reason: string): void {
    this.session?.close(code, reason);
  }

  addPendingTrack(track: Omit<PendingTrack, 'trackSid'>): string {
    const pending = { ...track, trackSid: newTrackSid() };
    this.pendingTracksByCid.set(track.cid, pending);
    return pending.trackSid;
  }

  createProducerFromTrack(trackSid: string, pending: PendingTrack, incoming: IncomingTrack): Producer {
    const producer = new Producer({
      trackSid,
      peerId: this.id,
      kind: pending.kind,
      source: pending.source,
      incoming,
      pliThrottleMs: this.options.pliThrottleMs,
      onRtp: this.options.onProducerRtp,
      onClose: (closed) => {
        this.producers.delete(closed.trackSid);
        this.options.onProducerClosed?.(closed);
      }
    });
    this.producers.set(trackSid, producer);
    this.pendingTracksByCid.delete(pending.cid);
    return producer;
  }

  addConsumer(consumer: Consumer): void {
    this.consumers.set(consumer.producer.trackSid, consumer);
    this.negotiator.markDirty();
  }

  removeConsumer(trackSid: string): void {
    const consumer = this.consumers.get(trackSid);
    if (!consumer) return;
    consumer.close();
    this.consumers.delete(trackSid);
    this.negotiator.markDirty();
  }

  toPeerInfo(): PeerInfo {
    return {
      peerId: this.id,
      displayName: this.displayName,
      tracks: [...this.producers.values()].map((producer) => producer.toTrackInfo())
    };
  }

  close(): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    if (this.graceTimer) this.clock.clearTimeout(this.graceTimer);
    this.negotiator.close();
    for (const producer of [...this.producers.values()]) {
      producer.close();
    }
    for (const consumer of [...this.consumers.values()]) {
      consumer.close();
    }
    this.producers.clear();
    this.consumers.clear();
    this.publisher.close();
    this.subscriber.close();
    this.session = undefined;
  }

  private get clock(): Clock {
    return this.options.clock ?? systemClock;
  }
}
