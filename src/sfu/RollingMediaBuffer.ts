import type { MediaKind } from '../signaling/protocol.js';
import type { RtpPacket } from '../transport/IMediaTransport.js';
import { isVp8KeyframeStart } from './codecs/vp8.js';

export interface BufferedPacket {
  packet: RtpPacket;
  arrivalTimeMs: number;
  isKeyframeStart: boolean;
}

export interface RollingMediaBufferOptions {
  windowMs?: number;
  maxPackets?: number;
  maxBytes?: number;
  kind?: MediaKind;
}

export class RollingMediaBuffer {
  readonly windowMs: number;
  readonly maxPackets: number;
  readonly maxBytes: number;
  readonly kind: MediaKind;

  private buffer: BufferedPacket[] = [];
  // Indices within this.buffer where isKeyframeStart === true
  private keyframeIndices: number[] = [];
  private totalPayloadBytes = 0;

  constructor(options: RollingMediaBufferOptions = {}) {
    this.windowMs = options.windowMs ?? 30_000;
    this.maxPackets = options.maxPackets ?? 10_000;
    this.maxBytes = options.maxBytes ?? 20 * 1024 * 1024; // 20 MB default safety ceiling
    this.kind = options.kind ?? 'video';
  }

  get length(): number {
    return this.buffer.length;
  }

  get bytes(): number {
    return this.totalPayloadBytes;
  }

  get keyframesCount(): number {
    return this.keyframeIndices.length;
  }

  get oldestArrivalTimeMs(): number | null {
    return this.buffer.length > 0 ? this.buffer[0].arrivalTimeMs : null;
  }

  get newestArrivalTimeMs(): number | null {
    return this.buffer.length > 0 ? this.buffer[this.buffer.length - 1].arrivalTimeMs : null;
  }

  get durationMs(): number {
    if (this.buffer.length === 0) return 0;
    return this.buffer[this.buffer.length - 1].arrivalTimeMs - this.buffer[0].arrivalTimeMs;
  }

  append(pkt: RtpPacket, arrivalTimeMs = Date.now(), isKeyframe?: boolean): void {
    const keyframeStart =
      isKeyframe !== undefined
        ? isKeyframe
        : this.kind === 'video'
          ? isVp8KeyframeStart(pkt.payload)
          : false;

    // Header clone, payload reference (per-packet rule: zero-copy payload, do not mutate original)
    const clonedHeader: RtpPacket['header'] = {
      payloadType: pkt.header.payloadType,
      sequenceNumber: pkt.header.sequenceNumber,
      timestamp: pkt.header.timestamp,
      ssrc: pkt.header.ssrc,
      marker: pkt.header.marker,
      audioLevel: pkt.header.audioLevel,
      rid: pkt.header.rid
    };

    const entry: BufferedPacket = {
      packet: { header: clonedHeader, payload: pkt.payload },
      arrivalTimeMs,
      isKeyframeStart: keyframeStart
    };

    const index = this.buffer.length;
    this.buffer.push(entry);
    this.totalPayloadBytes += pkt.payload.length;

    if (keyframeStart) {
      this.keyframeIndices.push(index);
    }

    this.evict(arrivalTimeMs);
  }

  get(index: number): BufferedPacket | undefined {
    return this.buffer[index];
  }

  toArray(): BufferedPacket[] {
    return [...this.buffer];
  }

  getKeyframeIndices(): number[] {
    return [...this.keyframeIndices];
  }

  /**
   * Finds the starting buffer index for a replay requested at targetTimeMs.
   * For video: returns the nearest keyframe index with arrivalTimeMs <= targetTimeMs.
   * If all keyframes are after targetTimeMs, returns the earliest available keyframe index (or 0).
   * For audio: returns the nearest packet index with arrivalTimeMs <= targetTimeMs (or 0).
   */
  findStartIndex(targetTimeMs: number): number | null {
    if (this.buffer.length === 0) return null;

    if (this.kind === 'video' && this.keyframeIndices.length > 0) {
      // Find the last keyframe whose arrivalTimeMs <= targetTimeMs
      let bestKeyframeIdx: number | null = null;
      for (const kfIdx of this.keyframeIndices) {
        const kfTime = this.buffer[kfIdx].arrivalTimeMs;
        if (kfTime <= targetTimeMs) {
          bestKeyframeIdx = kfIdx;
        } else {
          break;
        }
      }

      // If all keyframes are newer than targetTimeMs, return the earliest available keyframe
      return bestKeyframeIdx !== null ? bestKeyframeIdx : this.keyframeIndices[0];
    }

    // For audio or streams without keyframe indexing: binary search or linear scan for nearest <= targetTimeMs
    let bestIdx = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      if (this.buffer[i].arrivalTimeMs <= targetTimeMs) {
        bestIdx = i;
      } else {
        break;
      }
    }
    return bestIdx;
  }

  clear(): void {
    this.buffer = [];
    this.keyframeIndices = [];
    this.totalPayloadBytes = 0;
  }

  /**
   * Evicts packets based on age and capacity limits.
   * Key rule: Never evict past the last keyframe before or at the window start cutoff
   * (cutoff = now - windowMs), ensuring playback starting at the window boundary has a valid keyframe.
   */
  private evict(now: number): void {
    const cutoff = now - this.windowMs;

    // Determine how many items we could evict based on age
    let evictCount = 0;

    if (this.kind === 'video' && this.keyframeIndices.length > 0) {
      // Find the last keyframe with arrivalTimeMs <= cutoff
      let preserveFromIndex: number | null = null;
      for (const kfIdx of this.keyframeIndices) {
        if (this.buffer[kfIdx].arrivalTimeMs <= cutoff) {
          preserveFromIndex = kfIdx;
        } else {
          break;
        }
      }

      if (preserveFromIndex !== null) {
        // We can evict all packets strictly before preserveFromIndex
        evictCount = preserveFromIndex;
      } else {
        // All keyframes are newer than cutoff; do not evict past 0 by age
        evictCount = 0;
      }
    } else {
      // For audio or non-indexed: evict strictly older than cutoff
      while (evictCount < this.buffer.length && this.buffer[evictCount].arrivalTimeMs < cutoff) {
        evictCount++;
      }
    }

    // Also check maxPackets and maxBytes constraints to prevent unbounded growth
    let remainingBytes = this.totalPayloadBytes;
    for (let i = 0; i < evictCount; i++) {
      remainingBytes -= this.buffer[i].packet.payload.length;
    }

    while (
      (this.buffer.length - evictCount > this.maxPackets ||
        remainingBytes > this.maxBytes) &&
      evictCount < this.buffer.length
    ) {
      remainingBytes -= this.buffer[evictCount].packet.payload.length;
      evictCount++;
    }

    if (evictCount > 0) {
      this.dropFirst(evictCount);
    }
  }

  private dropFirst(count: number): void {
    const dropped = this.buffer.splice(0, count);
    for (const pkt of dropped) {
      this.totalPayloadBytes -= pkt.packet.payload.length;
    }

    // Re-index remaining keyframes
    this.keyframeIndices = [];
    for (let i = 0; i < this.buffer.length; i++) {
      if (this.buffer[i].isKeyframeStart) {
        this.keyframeIndices.push(i);
      }
    }
  }
}
