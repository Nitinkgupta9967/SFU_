import type { IceCandidateInit, MediaKind, SessionDescription } from '../signaling/protocol.js';
import type {
  IMediaTransport,
  IncomingTrack,
  OutgoingTrack,
  RtcpFeedback,
  RtpPacket,
  TransportRole,
  TransportStats,
  Unsubscribe
} from './IMediaTransport.js';

type Listener<T> = (value: T) => void;

export class FakeIncomingTrack implements IncomingTrack {
  private readonly rtpListeners = new Set<Listener<RtpPacket>>();
  private readonly closeListeners = new Set<() => void>();
  keyframeRequests = 0;

  constructor(
    readonly mid: string,
    readonly kind: MediaKind,
    readonly ssrc: number,
    readonly payloadType: number
  ) {}

  onRtp(cb: Listener<RtpPacket>): Unsubscribe {
    this.rtpListeners.add(cb);
    return () => this.rtpListeners.delete(cb);
  }

  requestKeyframe(): void {
    this.keyframeRequests += 1;
  }

  onClose(cb: () => void): Unsubscribe {
    this.closeListeners.add(cb);
    return () => this.closeListeners.delete(cb);
  }

  pushRtp(pkt: RtpPacket): void {
    for (const listener of this.rtpListeners) {
      listener(pkt);
    }
  }

  close(): void {
    for (const listener of this.closeListeners) {
      listener();
    }
  }
}

export class FakeOutgoingTrack implements OutgoingTrack {
  readonly written: RtpPacket[] = [];
  private readonly feedbackListeners = new Set<Listener<RtcpFeedback>>();
  closed = false;

  constructor(
    readonly kind: MediaKind,
    readonly ssrc: number,
    readonly payloadType: number,
    readonly mid: string | null = null
  ) {}

  writeRtp(pkt: RtpPacket): void {
    this.written.push(pkt);
  }

  onFeedback(cb: Listener<RtcpFeedback>): Unsubscribe {
    this.feedbackListeners.add(cb);
    return () => this.feedbackListeners.delete(cb);
  }

  pushFeedback(feedback: RtcpFeedback): void {
    for (const listener of this.feedbackListeners) {
      listener(feedback);
    }
  }

  close(): void {
    this.closed = true;
  }
}

export class FakeTransport implements IMediaTransport {
  state: IMediaTransport['state'] = 'new';
  readonly incomingTracks: FakeIncomingTrack[] = [];
  readonly outgoingTracks: FakeOutgoingTrack[] = [];
  private readonly trackListeners = new Set<Listener<IncomingTrack>>();
  private readonly iceListeners = new Set<Listener<IceCandidateInit>>();
  private readonly stateListeners = new Set<Listener<IMediaTransport['state']>>();

  constructor(readonly id: string, readonly role: TransportRole) {}

  async setRemoteDescription(_d: SessionDescription): Promise<void> {}

  async createAnswer(): Promise<SessionDescription> {
    return { type: 'answer', sdp: 'fake-answer' };
  }

  async createOffer(opts?: { iceRestart?: boolean }): Promise<SessionDescription> {
    return { type: 'offer', sdp: opts?.iceRestart ? 'fake-offer-ice-restart' : 'fake-offer' };
  }

  async addIceCandidate(_c: IceCandidateInit): Promise<void> {}

  onIceCandidate(cb: Listener<IceCandidateInit>): Unsubscribe {
    this.iceListeners.add(cb);
    return () => this.iceListeners.delete(cb);
  }

  onStateChange(cb: Listener<IMediaTransport['state']>): Unsubscribe {
    this.stateListeners.add(cb);
    return () => this.stateListeners.delete(cb);
  }

  onTrack(cb: Listener<IncomingTrack>): Unsubscribe {
    this.trackListeners.add(cb);
    return () => this.trackListeners.delete(cb);
  }

  addOutgoingTrack(kind: MediaKind): OutgoingTrack {
    const track = new FakeOutgoingTrack(kind, this.outgoingTracks.length + 10_000, kind === 'audio' ? 111 : 96, String(this.outgoingTracks.length));
    this.outgoingTracks.push(track);
    return track;
  }

  removeOutgoingTrack(t: OutgoingTrack): void {
    t.close();
  }

  async getStats(): Promise<TransportStats> {
    const packetsSent = this.outgoingTracks.reduce((sum, track) => sum + track.written.length, 0);
    return { bytesSent: 0, bytesReceived: 0, packetsSent, packetsReceived: 0 };
  }

  close(): void {
    this.state = 'closed';
    for (const listener of this.stateListeners) {
      listener(this.state);
    }
  }

  emitTrack(track: FakeIncomingTrack): void {
    this.incomingTracks.push(track);
    for (const listener of this.trackListeners) {
      listener(track);
    }
  }

  emitIceCandidate(candidate: IceCandidateInit): void {
    for (const listener of this.iceListeners) {
      listener(candidate);
    }
  }
}
