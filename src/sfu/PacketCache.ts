import type { RtpPacket } from '../transport/IMediaTransport.js';

export class PacketCache {
  private readonly packets: Array<RtpPacket | undefined>;
  private readonly sequenceNumbers: Array<number | undefined>;

  constructor(private readonly size: number) {
    if (!Number.isInteger(size) || size <= 0) {
      throw new Error('PacketCache size must be a positive integer');
    }
    this.packets = new Array(size);
    this.sequenceNumbers = new Array(size);
  }

  put(pkt: RtpPacket): void {
    const seq = pkt.header.sequenceNumber & 0xffff;
    const index = seq % this.size;
    this.packets[index] = pkt;
    this.sequenceNumbers[index] = seq;
  }

  get(sequenceNumber: number): RtpPacket | undefined {
    const seq = sequenceNumber & 0xffff;
    const index = seq % this.size;
    return this.sequenceNumbers[index] === seq ? this.packets[index] : undefined;
  }

  clear(): void {
    this.packets.fill(undefined);
    this.sequenceNumbers.fill(undefined);
  }
}
