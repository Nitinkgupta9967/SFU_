import type { IceCandidateInit, MediaKind, SessionDescription } from '../signaling/protocol.js';

export type TransportRole = 'publisher' | 'subscriber';
export type Unsubscribe = () => void;

export interface RtpPacket {
  header: {
    payloadType: number;
    sequenceNumber: number;
    timestamp: number;
    ssrc: number;
    marker: boolean;
    audioLevel?: { level: number; voice: boolean };
    rid?: string;
  };
  payload: Buffer;
}

export type RtcpFeedback =
  | { type: 'pli' }
  | { type: 'fir' }
  | { type: 'nack'; sequenceNumbers: number[] }
  | { type: 'receiverReport'; fractionLost: number; jitter: number; rttMs?: number };

export interface TransportStats {
  bytesSent: number;
  bytesReceived: number;
  packetsSent: number;
  packetsReceived: number;
}

export interface IncomingTrack {
  readonly mid: string;
  readonly kind: MediaKind;
  readonly ssrc: number;
  readonly payloadType: number;
  onRtp(cb: (pkt: RtpPacket) => void): Unsubscribe;
  requestKeyframe(): void;
  onClose(cb: () => void): Unsubscribe;
}

export interface OutgoingTrack {
  readonly mid: string | null;
  readonly kind: MediaKind;
  readonly ssrc: number;
  readonly payloadType: number;
  writeRtp(pkt: RtpPacket): void;
  onFeedback(cb: (fb: RtcpFeedback) => void): Unsubscribe;
  close(): void;
}

export interface IMediaTransport {
  readonly id: string;
  readonly role: TransportRole;
  readonly state: 'new' | 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed';
  setRemoteDescription(d: SessionDescription): Promise<void>;
  createAnswer(): Promise<SessionDescription>;
  createOffer(opts?: { iceRestart?: boolean }): Promise<SessionDescription>;
  addIceCandidate(c: IceCandidateInit): Promise<void>;
  onIceCandidate(cb: (c: IceCandidateInit) => void): Unsubscribe;
  onStateChange(cb: (s: IMediaTransport['state']) => void): Unsubscribe;
  onTrack(cb: (t: IncomingTrack) => void): Unsubscribe;
  addOutgoingTrack(kind: MediaKind): OutgoingTrack;
  removeOutgoingTrack(t: OutgoingTrack): void;
  getStats(): Promise<TransportStats>;
  close(): void;
}
