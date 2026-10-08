import {
  MediaStreamTrack,
  RTCPeerConnection,
  type RTCIceCandidate,
  type RTCRtpSender,
  RTP_EXTENSION_URI,
  RtpHeader,
  RtpPacket as WeriftRtpPacket,
  useAudioLevelIndication,
  useOPUS,
  useSdesMid,
  useVP8
} from 'werift';
import type { AppConfig } from '../config.js';
import type { IceCandidateInit, MediaKind, SessionDescription } from '../signaling/protocol.js';
import { newTransportId } from '../util/ids.js';
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

export class WeriftTransport implements IMediaTransport {
  readonly id = newTransportId();
  private readonly pc: RTCPeerConnection;
  private readonly trackListeners = new Set<Listener<IncomingTrack>>();
  private readonly iceListeners = new Set<Listener<IceCandidateInit>>();
  private readonly stateListeners = new Set<Listener<IMediaTransport['state']>>();
  private readonly incomingByTrack = new WeakMap<MediaStreamTrack, WeriftIncomingTrack>();
  private readonly pendingIce: IceCandidateInit[] = [];
  private closed = false;

  constructor(readonly role: TransportRole, config: AppConfig) {
    this.pc = new RTCPeerConnection({
      codecs: {
        audio: [useOPUS({ payloadType: 111 })],
        video: [useVP8({ payloadType: 96 })]
      },
      headerExtensions: {
        audio: [useSdesMid(), useAudioLevelIndication()],
        video: [useSdesMid()]
      },
      iceServers: config.iceServers,
      icePortRange: [config.rtcPortRange.min, config.rtcPortRange.max],
      iceAdditionalHostAddresses: config.publicIp ? [config.publicIp] : undefined,
      bundlePolicy: 'max-bundle'
    });

    this.pc.onIceCandidate.subscribe((candidate) => {
      if (!candidate) return;
      const init = toIceCandidateInit(candidate);
      for (const listener of this.iceListeners) listener(init);
    });
    this.pc.connectionStateChange.subscribe((state) => {
      for (const listener of this.stateListeners) listener(mapConnectionState(state));
    });
    this.pc.onTrack.subscribe((track) => {
      const incoming = new WeriftIncomingTrack(track, this.pc);
      this.incomingByTrack.set(track, incoming);
      for (const listener of this.trackListeners) listener(incoming);
    });
  }

  get state(): IMediaTransport['state'] {
    if (this.closed) return 'closed';
    return mapConnectionState(this.pc.connectionState);
  }

  async setRemoteDescription(d: SessionDescription): Promise<void> {
    await this.pc.setRemoteDescription(d);
    for (const candidate of this.pendingIce.splice(0)) {
      await this.pc.addIceCandidate(candidate);
    }
  }

  async createAnswer(): Promise<SessionDescription> {
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    return { type: 'answer', sdp: answer.sdp };
  }

  async createOffer(opts?: { iceRestart?: boolean }): Promise<SessionDescription> {
    const offer = await this.pc.createOffer(opts);
    await this.pc.setLocalDescription(offer);
    return { type: 'offer', sdp: offer.sdp };
  }

  async addIceCandidate(c: IceCandidateInit): Promise<void> {
    if (!this.pc.remoteDescription) {
      this.pendingIce.push(c);
      return;
    }
    await this.pc.addIceCandidate(c);
  }

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
    const track = new MediaStreamTrack({ kind });
    const sender = this.pc.addTrack(track);
    return new WeriftOutgoingTrack(track, sender, this.pc);
  }

  removeOutgoingTrack(t: OutgoingTrack): void {
    t.close();
  }

  async getStats(): Promise<TransportStats> {
    const report = await this.pc.getStats();
    let bytesSent = 0;
    let bytesReceived = 0;
    let packetsSent = 0;
    let packetsReceived = 0;

    for (const stat of report.values()) {
      if (stat.type === 'outbound-rtp') {
        const outbound = stat as { bytesSent?: number; packetsSent?: number };
        bytesSent += outbound.bytesSent ?? 0;
        packetsSent += outbound.packetsSent ?? 0;
      } else if (stat.type === 'inbound-rtp') {
        const inbound = stat as { bytesReceived?: number; packetsReceived?: number };
        bytesReceived += inbound.bytesReceived ?? 0;
        packetsReceived += inbound.packetsReceived ?? 0;
      }
    }

    return { bytesSent, bytesReceived, packetsSent, packetsReceived };
  }

  close(): void {
    this.closed = true;
    void this.pc.close();
  }
}

class WeriftIncomingTrack implements IncomingTrack {
  readonly mid: string;
  readonly kind: MediaKind;
  readonly ssrc: number;
  readonly payloadType: number;
  private readonly rtpListeners = new Set<Listener<RtpPacket>>();
  private readonly closeListeners = new Set<() => void>();
  private readonly disposers: Unsubscribe[] = [];

  constructor(
    private readonly track: MediaStreamTrack,
    private readonly pc: RTCPeerConnection
  ) {
    this.mid = findMid(pc, track) ?? track.id ?? track.uuid;
    this.kind = track.kind as MediaKind;
    this.ssrc = track.ssrc ?? 0;
    this.payloadType = track.codec?.payloadType ?? (this.kind === 'audio' ? 111 : 96);

    const rtpSub = track.onReceiveRtp.subscribe((pkt, extensions) => {
      for (const listener of this.rtpListeners) listener(fromWeriftPacket(pkt, extensions));
    });
    this.disposers.push(() => rtpSub.unSubscribe());
    track.addEventListener('ended', () => {
      for (const listener of this.closeListeners) listener();
    });
  }

  onRtp(cb: Listener<RtpPacket>): Unsubscribe {
    this.rtpListeners.add(cb);
    return () => this.rtpListeners.delete(cb);
  }

  requestKeyframe(): void {
    const receiver = this.pc.getReceivers().find((candidate) => candidate.tracks.includes(this.track) || candidate.track === this.track);
    const ssrc = this.track.ssrc ?? this.ssrc;
    if (receiver && ssrc) {
      void receiver.sendRtcpPLI(ssrc);
    }
  }

  onClose(cb: () => void): Unsubscribe {
    this.closeListeners.add(cb);
    return () => this.closeListeners.delete(cb);
  }
}

class WeriftOutgoingTrack implements OutgoingTrack {
  readonly kind: MediaKind;
  readonly ssrc: number;
  readonly payloadType: number;
  private readonly feedbackListeners = new Set<Listener<RtcpFeedback>>();
  private closed = false;
  private readonly disposers: Unsubscribe[] = [];

  constructor(
    private readonly track: MediaStreamTrack,
    private readonly sender: RTCRtpSender,
    private readonly pc: RTCPeerConnection
  ) {
    this.kind = track.kind as MediaKind;
    this.ssrc = sender.ssrc;
    this.payloadType = this.kind === 'audio' ? 111 : 96;

    const pliSub = sender.onPictureLossIndication.subscribe(() => this.emitFeedback({ type: 'pli' }));
    const nackSub = sender.onGenericNack.subscribe((nack) => {
      this.emitFeedback({ type: 'nack', sequenceNumbers: nack.lost });
    });
    this.disposers.push(() => pliSub.unSubscribe(), () => nackSub.unSubscribe());
  }

  writeRtp(pkt: RtpPacket): void {
    if (this.closed) return;
    this.track.writeRtp(toWeriftPacket(pkt));
  }

  onFeedback(cb: Listener<RtcpFeedback>): Unsubscribe {
    this.feedbackListeners.add(cb);
    return () => this.feedbackListeners.delete(cb);
  }

  close(): void {
    this.closed = true;
    for (const dispose of this.disposers.splice(0)) dispose();
    this.track.stop();
    if (typeof this.pc.removeTrack === 'function') {
      this.pc.removeTrack(this.sender);
    }
  }

  get mid(): string | null {
    return this.pc.getTransceivers().find((transceiver) => transceiver.sender === this.sender)?.mid ?? null;
  }

  private emitFeedback(feedback: RtcpFeedback): void {
    for (const listener of this.feedbackListeners) listener(feedback);
  }
}

function fromWeriftPacket(pkt: WeriftRtpPacket, extensions?: Record<string, unknown>): RtpPacket {
  const audioLevel = extensions?.[RTP_EXTENSION_URI.audioLevelIndication] as { v?: boolean; level?: number } | undefined;
  const rid = extensions?.[RTP_EXTENSION_URI.sdesRTPStreamID] as string | undefined;
  return {
    header: {
      payloadType: pkt.header.payloadType,
      sequenceNumber: pkt.header.sequenceNumber,
      timestamp: pkt.header.timestamp,
      ssrc: pkt.header.ssrc,
      marker: pkt.header.marker,
      audioLevel: audioLevel ? { voice: audioLevel.v ?? false, level: audioLevel.level ?? 127 } : undefined,
      rid
    },
    payload: pkt.payload
  };
}

function toWeriftPacket(pkt: RtpPacket): WeriftRtpPacket {
  return new WeriftRtpPacket(
    new RtpHeader({
      version: 2,
      payloadType: pkt.header.payloadType,
      sequenceNumber: pkt.header.sequenceNumber,
      timestamp: pkt.header.timestamp,
      ssrc: pkt.header.ssrc,
      marker: pkt.header.marker,
      extension: false,
      extensions: []
    }),
    pkt.payload
  );
}

function mapConnectionState(state: RTCPeerConnection['connectionState']): IMediaTransport['state'] {
  switch (state) {
    case 'new':
      return 'new';
    case 'connecting':
      return 'connecting';
    case 'connected':
      return 'connected';
    case 'disconnected':
      return 'disconnected';
    case 'failed':
      return 'failed';
    case 'closed':
      return 'closed';
  }
}

function toIceCandidateInit(candidate: RTCIceCandidate): IceCandidateInit {
  return {
    candidate: candidate.toJSON().candidate,
    sdpMid: candidate.sdpMid ?? null,
    sdpMLineIndex: candidate.sdpMLineIndex ?? null
  };
}

function findMid(pc: RTCPeerConnection, track: MediaStreamTrack): string | undefined {
  return pc.getTransceivers().find((transceiver) => transceiver.receiver.tracks.includes(track) || transceiver.receiver.track === track)?.mid ?? undefined;
}
