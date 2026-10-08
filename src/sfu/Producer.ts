import type { MediaKind, TrackInfo, TrackSource } from '../signaling/protocol.js';
import type { IncomingTrack, RtpPacket, Unsubscribe } from '../transport/IMediaTransport.js';
import { isVp8KeyframeStart } from './codecs/vp8.js';
import type { Consumer } from './Consumer.js';
import { KeyframeController } from './KeyframeController.js';

export interface ProducerOptions {
  trackSid: string;
  peerId: string;
  kind: MediaKind;
  source: TrackSource;
  incoming: IncomingTrack;
  pliThrottleMs: number;
  onClose?: (producer: Producer) => void;
  onRtp?: (producer: Producer, pkt: RtpPacket) => void;
}

export class Producer {
  readonly trackSid: string;
  readonly peerId: string;
  readonly kind: MediaKind;
  readonly source: TrackSource;
  readonly consumers = new Map<string, Consumer>();
  muted = false;
  packetsReceived = 0;
  bytesReceived = 0;
  keyframes = 0;
  readonly createdAt = Date.now();
  private readonly incoming: IncomingTrack;
  private readonly keyframesController: KeyframeController;
  private readonly unsubscribers: Unsubscribe[] = [];
  private closed = false;

  constructor(private readonly options: ProducerOptions) {
    this.trackSid = options.trackSid;
    this.peerId = options.peerId;
    this.kind = options.kind;
    this.source = options.source;
    this.incoming = options.incoming;
    this.keyframesController = new KeyframeController(this.incoming, { throttleMs: options.pliThrottleMs });
    this.unsubscribers.push(this.incoming.onRtp((pkt) => this.handleRtp(pkt)));
    this.unsubscribers.push(this.incoming.onClose(() => this.close()));
  }

  addConsumer(consumer: Consumer): void {
    this.consumers.set(consumer.id, consumer);
    if (this.kind === 'video') {
      this.requestKeyframe('new-consumer');
    }
  }

  removeConsumer(consumerId: string): void {
    this.consumers.delete(consumerId);
  }

  setMuted(muted: boolean): void {
    if (this.muted === muted) return;
    this.muted = muted;
    if (!muted && this.kind === 'video') {
      for (const consumer of this.consumers.values()) {
        consumer.onSourceResumed();
      }
      this.requestKeyframe('unmute');
    }
  }

  requestKeyframe(reason: string): void {
    this.keyframesController.request(reason);
  }

  get plisSent(): number {
    return this.keyframesController.plisSent;
  }

  toStats(): {
    trackSid: string;
    kind: MediaKind;
    bitrateKbps: number;
    packets: number;
    packetsLost: number;
    jitterMs: number;
    keyframes: number;
    plisSent: number;
  } {
    const elapsedSec = Math.max(0.001, (Date.now() - this.createdAt) / 1000);
    return {
      trackSid: this.trackSid,
      kind: this.kind,
      bitrateKbps: Number(((this.bytesReceived * 8) / 1000 / elapsedSec).toFixed(1)),
      packets: this.packetsReceived,
      packetsLost: 0,
      jitterMs: 0,
      keyframes: this.keyframes,
      plisSent: this.plisSent
    };
  }

  toTrackInfo(): TrackInfo {
    return {
      trackSid: this.trackSid,
      peerId: this.peerId,
      kind: this.kind,
      source: this.source,
      muted: this.muted
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const unsub of this.unsubscribers.splice(0)) {
      unsub();
    }
    this.keyframesController.close();
    for (const consumer of [...this.consumers.values()]) {
      consumer.close();
    }
    this.consumers.clear();
    this.options.onClose?.(this);
  }

  private handleRtp(pkt: RtpPacket): void {
    if (this.closed) return;
    this.packetsReceived += 1;
    this.bytesReceived += pkt.payload.length;
    this.options.onRtp?.(this, pkt);

    if (this.muted) return;

    if (this.kind === 'video' && isVp8KeyframeStart(pkt.payload)) {
      this.keyframes += 1;
      this.keyframesController.keyframeReceived();
    }

    for (const consumer of this.consumers.values()) {
      consumer.forward(pkt);
    }
  }
}
