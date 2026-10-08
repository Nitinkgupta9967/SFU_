import type { RtcpFeedback, OutgoingTrack, RtpPacket, Unsubscribe } from '../transport/IMediaTransport.js';
import { isVp8KeyframeStart } from './codecs/vp8.js';
import { LayerSelector } from './LayerSelector.js';
import { PacketCache } from './PacketCache.js';
import type { Producer } from './Producer.js';
import { RtpRewriter } from './RtpRewriter.js';

export interface ConsumerOptions {
  producer: Producer;
  subscriberPeerId: string;
  outgoing: OutgoingTrack;
  packetCacheSize: number;
  onSubscriptionChanged?: (paused: boolean, reason: 'bandwidth' | 'policy') => void;
}

export class Consumer {
  readonly id: string;
  readonly producer: Producer;
  readonly subscriberPeerId: string;
  paused = false;
  pausedByServer = false;
  packetsSent = 0;
  bytesSent = 0;
  nacksReceived = 0;
  retransmits = 0;
  plisReceived = 0;
  readonly createdAt = Date.now();
  private keyframeGateOpen: boolean;
  private readonly outgoing: OutgoingTrack;
  private readonly rewriter: RtpRewriter;
  private readonly packetCache: PacketCache;
  private readonly layerSelector = new LayerSelector();
  private readonly onSubscriptionChanged?: ConsumerOptions['onSubscriptionChanged'];
  private readonly unsubscribers: Unsubscribe[] = [];
  private closed = false;

  constructor(options: ConsumerOptions) {
    this.producer = options.producer;
    this.subscriberPeerId = options.subscriberPeerId;
    this.id = `${this.subscriberPeerId}:${this.producer.trackSid}`;
    this.outgoing = options.outgoing;
    this.keyframeGateOpen = this.producer.kind === 'audio';
    this.rewriter = new RtpRewriter({
      kind: this.producer.kind,
      ssrc: this.outgoing.ssrc,
      payloadType: this.outgoing.payloadType
    });
    this.packetCache = new PacketCache(options.packetCacheSize);
    this.onSubscriptionChanged = options.onSubscriptionChanged;
    this.unsubscribers.push(this.outgoing.onFeedback((fb) => this.handleFeedback(fb)));
  }

  get mid(): string | null {
    return this.outgoing.mid;
  }

  forward(pkt: RtpPacket): void {
    if (this.closed || this.paused || this.pausedByServer) return;

    if (!this.keyframeGateOpen) {
      if (!isVp8KeyframeStart(pkt.payload)) {
        this.producer.requestKeyframe('gate-closed');
        return;
      }
      this.keyframeGateOpen = true;
      this.rewriter.rebase(pkt);
    }

    const out = this.rewriter.rewrite(pkt);
    if (this.producer.kind === 'video') {
      this.packetCache.put(out);
    }
    this.outgoing.writeRtp(out);
    this.packetsSent += 1;
    this.bytesSent += out.payload.length;
  }

  pause(byServer = false): void {
    this.paused = true;
    this.pausedByServer = byServer;
  }

  resume(): void {
    this.paused = false;
    this.pausedByServer = false;
    this.onSourceResumed();
  }

  onSourceResumed(): void {
    this.rewriter.reset();
    this.packetCache.clear();
    if (this.producer.kind === 'video') {
      this.keyframeGateOpen = false;
      this.producer.requestKeyframe('resume');
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const unsub of this.unsubscribers.splice(0)) {
      unsub();
    }
    this.outgoing.close();
    this.producer.removeConsumer(this.id);
  }

  toStats(): {
    trackSid: string;
    subscriberPeerId: string;
    bitrateKbps: number;
    packetsSent: number;
    nacksReceived: number;
    retransmits: number;
    plisReceived: number;
    paused: boolean;
  } {
    const elapsedSec = Math.max(0.001, (Date.now() - this.createdAt) / 1000);
    return {
      trackSid: this.producer.trackSid,
      subscriberPeerId: this.subscriberPeerId,
      bitrateKbps: Number(((this.bytesSent * 8) / 1000 / elapsedSec).toFixed(1)),
      packetsSent: this.packetsSent,
      nacksReceived: this.nacksReceived,
      retransmits: this.retransmits,
      plisReceived: this.plisReceived,
      paused: this.paused || this.pausedByServer
    };
  }

  private handleFeedback(feedback: RtcpFeedback): void {
    if (feedback.type === 'pli' || feedback.type === 'fir') {
      this.plisReceived += 1;
      this.producer.requestKeyframe(feedback.type);
      return;
    }
    if (feedback.type === 'receiverReport' && this.producer.kind === 'video') {
      const decision = this.layerSelector.onReceiverReport(feedback.fractionLost);
      if (decision === 'down' && !this.pausedByServer) {
        this.pause(true);
        this.onSubscriptionChanged?.(true, 'bandwidth');
      } else if (decision === 'up' && this.pausedByServer) {
        this.resume();
        this.onSubscriptionChanged?.(false, 'bandwidth');
      }
      return;
    }
    if (feedback.type !== 'nack') return;
    this.nacksReceived += feedback.sequenceNumbers.length;
    for (const seq of feedback.sequenceNumbers) {
      const cached = this.packetCache.get(seq);
      if (!cached) continue;
      this.outgoing.writeRtp(cached);
      this.retransmits += 1;
    }
  }
}
