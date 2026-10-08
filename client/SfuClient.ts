import type {
  IceCandidateInit,
  JoinParams,
  PeerInfo,
  SessionDescription,
  TrackInfo,
  TrackSource
} from '../src/signaling/protocol.js';

type EventName =
  | 'peerJoined'
  | 'peerLeft'
  | 'trackSubscribed'
  | 'trackUnsubscribed'
  | 'trackMuted'
  | 'activeSpeakers'
  | 'connectionState'
  | 'error';

type Listener = (...args: any[]) => void;

interface SfuClientOptions {
  url: string;
  token?: string;
  roomId: string;
  displayName: string;
}

interface RequestEnvelope {
  type: 'request';
  id: number;
  method: string;
  params: Record<string, unknown>;
}

type ResponseEnvelope =
  | { type: 'response'; id: number; ok: true; data: Record<string, unknown> }
  | { type: 'response'; id: number; ok: false; error: { code: string; message: string } };

type NotificationEnvelope = { type: 'notification'; event: string; data: Record<string, any> };

export interface LocalTrack {
  trackSid: string;
  cid: string;
  track: MediaStreamTrack;
  sender: RTCRtpSender;
}

export interface RemotePeer {
  peerId: string;
  displayName: string;
  tracks: Map<string, TrackInfo>;
}

export class SfuClient {
  readonly peers = new Map<string, RemotePeer>();
  private readonly listeners = new Map<EventName, Set<Listener>>();
  private ws?: WebSocket;
  private publisher?: RTCPeerConnection;
  private subscriber?: RTCPeerConnection;
  private requestId = 1;
  private readonly pending = new Map<number, { resolve: (data: Record<string, unknown>) => void; reject: (error: Error) => void; timer: number }>();
  private readonly remoteTrackMids = new Map<string, { trackSid: string; peerId: string }>();
  private readonly localTracks = new Map<string, LocalTrack>();
  private readonly pendingRemoteIce: Record<'publisher' | 'subscriber', RTCIceCandidateInit[]> = {
    publisher: [],
    subscriber: []
  };
  private joined = false;
  private disconnecting = false;
  private pingTimer?: number;
  private pingIntervalMs = 15_000;
  private reconnectToken?: string;
  peerId?: string;

  constructor(private readonly options: SfuClientOptions) {}

  async connect(): Promise<Record<string, unknown>> {
    this.disconnecting = false;
    const join = await this.openSocketAndJoin(null);
    this.publisher = this.createPeerConnection('publisher', (join.iceServers as RTCIceServer[]) ?? []);
    this.subscriber = this.createPeerConnection('subscriber', (join.iceServers as RTCIceServer[]) ?? []);
    this.startPing();
    this.emit('connectionState', 'connected');
    return join;
  }

  async disconnect(): Promise<void> {
    this.disconnecting = true;
    this.stopPing();
    if (this.joined) {
      await this.request('leave', {}).catch(() => undefined);
    }
    this.ws?.close();
    this.publisher?.close();
    this.subscriber?.close();
    this.joined = false;
  }

  async publish(track: MediaStreamTrack, source: TrackSource): Promise<LocalTrack> {
    if (!this.publisher) throw new Error('client is not connected');
    const cid = track.id;
    const published = await this.request('track.publish', { cid, kind: track.kind, source, simulcast: false });
    const sender = this.publisher.addTrack(track);
    preferCodecs(this.publisher);
    const offer = await this.publisher.createOffer();
    await this.publisher.setLocalDescription(offer);
    const mids = this.publisher
      .getTransceivers()
      .filter((transceiver) => transceiver.sender === sender)
      .map((transceiver) => ({ mid: transceiver.mid!, cid }));
    const answer = await this.request('publisher.offer', {
      sdp: { type: 'offer', sdp: requireSdp(offer) } satisfies SessionDescription,
      mids
    });
    await this.publisher.setRemoteDescription(answer.sdp as RTCSessionDescriptionInit);
    await this.flushIce('publisher');
    const local: LocalTrack = { trackSid: published.trackSid as string, cid, track, sender };
    this.localTracks.set(local.trackSid, local);
    return local;
  }

  async unpublish(local: LocalTrack): Promise<void> {
    await this.request('track.unpublish', { trackSid: local.trackSid });
    local.track.stop();
    this.publisher?.removeTrack(local.sender);
    this.localTracks.delete(local.trackSid);
  }

  async setMuted(local: LocalTrack, muted: boolean): Promise<void> {
    local.track.enabled = !muted;
    await this.request('track.mute', { trackSid: local.trackSid, muted });
  }

  async setSubscription(trackSid: string, params: { subscribed?: boolean; paused?: boolean; preferredLayer?: string }): Promise<void> {
    await this.request('subscription.update', { trackSid, ...params });
  }

  on(event: EventName, cb: Listener): this {
    const set = this.listeners.get(event) ?? new Set();
    set.add(cb);
    this.listeners.set(event, set);
    return this;
  }

  private async openSocketAndJoin(reconnectToken: string | null): Promise<Record<string, unknown>> {
    const wsUrl = new URL(this.options.url);
    wsUrl.searchParams.set('room', this.options.roomId);
    if (this.options.token) wsUrl.searchParams.set('token', this.options.token);

    this.ws = new WebSocket(wsUrl);
    this.ws.addEventListener('message', (event) => this.handleMessage(event.data));
    this.ws.addEventListener('close', () => void this.handleSocketClose());
    this.ws.addEventListener('error', () => this.emit('error', new Error('websocket error')));
    await once(this.ws, 'open');

    const join = await this.request('join', {
      displayName: this.options.displayName,
      autoSubscribe: true,
      reconnectToken
    } satisfies JoinParams);

    this.peerId = join.peerId as string;
    this.reconnectToken = join.reconnectToken as string | undefined;
    this.pingIntervalMs = Number((join.serverConfig as { pingIntervalMs?: number } | undefined)?.pingIntervalMs ?? 15_000);
    this.peers.clear();
    for (const peer of (join.peers as PeerInfo[]) ?? []) {
      this.upsertPeer(peer);
    }
    this.joined = true;
    return join;
  }

  private async handleSocketClose(): Promise<void> {
    this.stopPing();
    this.joined = false;
    if (this.disconnecting) {
      this.emit('connectionState', 'disconnected');
      return;
    }
    if (!this.reconnectToken) {
      this.emit('connectionState', 'disconnected');
      return;
    }
    this.emit('connectionState', 'reconnecting');
    try {
      await this.openSocketAndJoin(this.reconnectToken);
      await this.restartIce();
      this.startPing();
      this.emit('connectionState', 'connected');
    } catch (error) {
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
      this.emit('connectionState', 'disconnected');
    }
  }

  private async restartIce(): Promise<void> {
    if (this.publisher && this.publisher.connectionState !== 'connected') {
      const offer = await this.publisher.createOffer({ iceRestart: true });
      await this.publisher.setLocalDescription(offer);
      const answer = await this.request('ice.restart', {
        target: 'publisher',
        sdp: { type: 'offer', sdp: requireSdp(offer) }
      });
      await this.publisher.setRemoteDescription(answer.sdp as RTCSessionDescriptionInit);
      await this.flushIce('publisher');
    }
    if (this.subscriber) {
      const restarted = await this.request('ice.restart', { target: 'subscriber' });
      await this.subscriber.setRemoteDescription(restarted.sdp as RTCSessionDescriptionInit);
      await this.flushIce('subscriber');
      const answer = await this.subscriber.createAnswer();
      await this.subscriber.setLocalDescription(answer);
      await this.request('subscriber.answer', {
        offerId: restarted.offerId,
        sdp: { type: 'answer', sdp: requireSdp(answer) }
      });
    }
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = globalThis.setInterval(() => {
      void this.request('ping', {}).catch(() => undefined);
    }, this.pingIntervalMs) as unknown as number;
  }

  private stopPing(): void {
    if (this.pingTimer) {
      globalThis.clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
  }

  private createPeerConnection(target: 'publisher' | 'subscriber', iceServers: RTCIceServer[]): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers });
    preferCodecs(pc);
    pc.addEventListener('icecandidate', (event) => {
      if (!event.candidate) {
        void this.request('ice.candidate', { target, candidate: null }).catch(() => undefined);
        return;
      }
      void this.request('ice.candidate', { target, candidate: event.candidate.toJSON() as IceCandidateInit }).catch((error) =>
        this.emit('error', error)
      );
    });
    pc.addEventListener('connectionstatechange', () => this.emit('connectionState', pc.connectionState));
    if (target === 'subscriber') {
      pc.addEventListener('track', (event) => this.handleRemoteTrack(event));
    }
    return pc;
  }

  private async handleNotification(message: NotificationEnvelope): Promise<void> {
    debug('notification', message);
    switch (message.event) {
      case 'peer.joined':
        this.upsertPeer(message.data.peer as PeerInfo);
        this.emit('peerJoined', message.data.peer);
        break;
      case 'peer.left':
        this.peers.delete(message.data.peerId);
        this.emit('peerLeft', message.data.peerId);
        break;
      case 'track.published': {
        const track = message.data.track as TrackInfo;
        const peer = this.peers.get(track.peerId);
        peer?.tracks.set(track.trackSid, track);
        break;
      }
      case 'track.unpublished':
        this.peers.get(message.data.peerId)?.tracks.delete(message.data.trackSid);
        this.emit('trackUnsubscribed', message.data);
        break;
      case 'track.muted':
        this.emit('trackMuted', message.data, message.data.muted);
        break;
      case 'subscriber.offer':
        await this.handleSubscriberOffer(message.data);
        break;
      case 'ice.candidate':
        await this.handleIceCandidate(message.data.target, message.data.candidate);
        break;
      case 'speakers.changed':
        this.emit('activeSpeakers', (message.data.speakers as { peerId: string }[]).map((speaker) => speaker.peerId));
        break;
      case 'room.closed':
        this.emit('error', new Error(`room closed: ${message.data.reason ?? 'unknown'}`));
        await this.disconnect();
        break;
    }
  }

  private async handleSubscriberOffer(data: Record<string, any>): Promise<void> {
    debug('subscriber.offer', data);
    if (!this.subscriber) return;
    this.remoteTrackMids.clear();
    for (const binding of data.mids ?? []) {
      if (binding.mid != null) {
        this.remoteTrackMids.set(String(binding.mid), { trackSid: binding.trackSid, peerId: binding.peerId });
      }
    }
    await this.subscriber.setRemoteDescription(data.sdp);
    await this.flushIce('subscriber');
    const answer = await this.subscriber.createAnswer();
    await this.subscriber.setLocalDescription(answer);
    await this.request('subscriber.answer', {
      offerId: data.offerId,
      sdp: { type: 'answer', sdp: requireSdp(answer) } satisfies SessionDescription
    });
  }

  private async handleIceCandidate(target: 'publisher' | 'subscriber', candidate: RTCIceCandidateInit | null): Promise<void> {
    if (!candidate) return;
    const pc = target === 'publisher' ? this.publisher : this.subscriber;
    if (!pc) return;
    if (!pc.remoteDescription) {
      this.pendingRemoteIce[target].push(candidate);
      return;
    }
    await pc.addIceCandidate(candidate);
  }

  private async flushIce(target: 'publisher' | 'subscriber'): Promise<void> {
    const pc = target === 'publisher' ? this.publisher : this.subscriber;
    if (!pc?.remoteDescription) return;
    for (const candidate of this.pendingRemoteIce[target].splice(0)) {
      await pc.addIceCandidate(candidate);
    }
  }

  private handleRemoteTrack(event: RTCTrackEvent): void {
    debug('remote.track', { mid: event.transceiver.mid, id: event.track.id, kind: event.track.kind });
    const mid = event.transceiver.mid;
    const binding = mid ? this.remoteTrackMids.get(mid) : undefined;
    if (!binding) return;
    const peer = this.peers.get(binding.peerId);
    const info = peer?.tracks.get(binding.trackSid);
    if (info && peer) {
      this.emit('trackSubscribed', event.track, info, peer);
    }
  }

  private handleMessage(raw: string): void {
    debug('ws.message', raw);
    const message = JSON.parse(raw) as ResponseEnvelope | NotificationEnvelope;
    if (message.type === 'response') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      globalThis.clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.ok) pending.resolve(message.data);
      else pending.reject(new Error(`${message.error.code}: ${message.error.message}`));
      return;
    }
    void this.handleNotification(message).catch((error) => this.emit('error', error));
  }

  private request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('websocket is not open'));
    }
    const id = this.requestId++;
    const envelope: RequestEnvelope = { type: 'request', id, method, params };
    this.ws.send(JSON.stringify(envelope));
    return new Promise((resolve, reject) => {
      const timer = globalThis.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 10_000) as unknown as number;
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  private upsertPeer(info: PeerInfo): void {
    this.peers.set(info.peerId, {
      peerId: info.peerId,
      displayName: info.displayName,
      tracks: new Map(info.tracks.map((track) => [track.trackSid, track]))
    });
  }

  private emit(event: EventName, ...args: any[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }
}

function once(target: EventTarget, event: string): Promise<void> {
  return new Promise((resolve) => target.addEventListener(event, () => resolve(), { once: true }));
}

function requireSdp(description: RTCSessionDescriptionInit): string {
  if (!description.sdp) throw new Error('missing SDP');
  return description.sdp;
}

function preferCodecs(pc: RTCPeerConnection): void {
  for (const transceiver of pc.getTransceivers()) {
    if (typeof transceiver.setCodecPreferences !== 'function') continue;
    const kind = transceiver.receiver.track?.kind ?? transceiver.sender.track?.kind;
    if (!kind) continue;
    const caps = RTCRtpSender.getCapabilities(kind);
    if (!caps) continue;
    const preferred = caps.codecs.filter((codec) =>
      kind === 'audio' ? /opus/i.test(codec.mimeType) : /vp8/i.test(codec.mimeType)
    );
    if (preferred.length) transceiver.setCodecPreferences(preferred);
  }
}

function debug(event: string, data: unknown): void {
  const target = globalThis as unknown as { __miniSfuDebug?: unknown[] };
  target.__miniSfuDebug ??= [];
  target.__miniSfuDebug.push({ event, data });
}
