import type { MediaKind } from '../signaling/protocol.js';
import type { RtpPacket } from '../transport/IMediaTransport.js';

const DEFAULT_FRAME_TICKS: Record<MediaKind, number> = {
  audio: 960,
  video: 3000
};

export interface RtpRewriterOptions {
  kind: MediaKind;
  ssrc: number;
  payloadType: number;
  frameTicks?: number;
  initialSequenceNumber?: number;
  initialTimestamp?: number;
}

export class RtpRewriter {
  private readonly kind: MediaKind;
  private readonly ssrc: number;
  private readonly payloadType: number;
  private readonly frameTicks: number;
  private seqOffset = 0;
  private tsOffset = 0;
  private lastOutSeq: number;
  private lastOutTs: number;
  private initialized = false;

  constructor(options: RtpRewriterOptions) {
    this.kind = options.kind;
    this.ssrc = options.ssrc;
    this.payloadType = options.payloadType;
    this.frameTicks = options.frameTicks ?? DEFAULT_FRAME_TICKS[options.kind];
    this.lastOutSeq = options.initialSequenceNumber ?? random16();
    this.lastOutTs = options.initialTimestamp ?? random32();
  }

  rebase(first: RtpPacket): void {
    const nextSeq = this.initialized ? (this.lastOutSeq + 1) & 0xffff : this.lastOutSeq;
    const nextTs = this.initialized ? (this.lastOutTs + this.frameTicks) >>> 0 : this.lastOutTs;
    this.seqOffset = (nextSeq - first.header.sequenceNumber) & 0xffff;
    this.tsOffset = (nextTs - first.header.timestamp) >>> 0;
    this.initialized = true;
  }

  rewrite(pkt: RtpPacket): RtpPacket {
    if (!this.initialized) {
      this.rebase(pkt);
    }

    const header = {
      payloadType: this.payloadType,
      sequenceNumber: (pkt.header.sequenceNumber + this.seqOffset) & 0xffff,
      timestamp: (pkt.header.timestamp + this.tsOffset) >>> 0,
      ssrc: this.ssrc,
      marker: pkt.header.marker
    };
    this.lastOutSeq = header.sequenceNumber;
    this.lastOutTs = header.timestamp;
    return { header, payload: pkt.payload };
  }

  reset(): void {
    this.initialized = false;
  }

  get target(): { kind: MediaKind; ssrc: number; payloadType: number } {
    return { kind: this.kind, ssrc: this.ssrc, payloadType: this.payloadType };
  }
}

function random16(): number {
  return Math.floor(Math.random() * 0x10000);
}

function random32(): number {
  return Math.floor(Math.random() * 0x100000000) >>> 0;
}
