import websocket from '@fastify/websocket';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { RawData, WebSocket } from 'ws';
import { ZodError } from 'zod';
import type { AppConfig } from '../config.js';
import { verifyRoomToken } from '../api/auth.js';
import type { Peer, PeerSession } from '../sfu/Peer.js';
import type { Room } from '../sfu/Room.js';
import type { RoomManager } from '../sfu/RoomManager.js';
import type { IncomingTrack, Unsubscribe } from '../transport/IMediaTransport.js';
import type {
  ErrorCode,
  IceCandidateInit,
  OutboundEnvelope,
  RequestEnvelope,
  SessionDescription
} from './protocol.js';
import {
  fail,
  iceCandidateParamsSchema,
  iceRestartParamsSchema,
  joinParamsSchema,
  ok,
  parseRequest,
  publisherOfferParamsSchema,
  subscriberAnswerParamsSchema,
  subscriptionUpdateParamsSchema,
  trackMuteParamsSchema,
  trackPublishParamsSchema,
  trackUnpublishParamsSchema
} from './protocol.js';
import { SlidingWindowRateLimiter } from './rateLimit.js';

interface SignalingServerOptions {
  app: FastifyInstance;
  roomManager: RoomManager;
  config: AppConfig;
}

type ClientState =
  | { joined: false; roomId: string }
  | { joined: true; roomId: string; room: Room; peer: Peer };

export async function registerSignalingServer(options: SignalingServerOptions): Promise<void> {
  await options.app.register(websocket, { options: { maxPayload: 256 * 1024 } });

  options.app.get('/ws', { websocket: true }, (socket, request) => {
    const session = new SignalingSession(socket, request, options.roomManager, options.config);
    session.start();
  });
}

class SignalingSession {
  private state: ClientState;
  private queue = Promise.resolve();
  private heartbeatTimer?: NodeJS.Timeout;
  private lastTrafficAt = Date.now();
  private closed = false;
  private intentionalLeave = false;
  private publisherTrackUnsub?: Unsubscribe;
  private readonly pendingMidToCid = new Map<string, string>();
  private readonly rateLimiter: SlidingWindowRateLimiter;
  private readonly sink: PeerSession;

  constructor(
    private readonly socket: WebSocket,
    request: FastifyRequest,
    private readonly roomManager: RoomManager,
    private readonly config: AppConfig
  ) {
    const url = new URL(request.url, 'http://localhost');
    const roomId = url.searchParams.get('room') || 'default';
    if (config.authMode === 'jwt') {
      const token = url.searchParams.get('token');
      if (!token || !config.jwtSecret) {
        socket.close(4001, 'unauthorized');
      } else {
        try {
          const claims = verifyRoomToken(token, config.jwtSecret);
          if (claims.roomId !== roomId) {
            socket.close(4001, 'unauthorized');
          }
        } catch {
          socket.close(4001, 'unauthorized');
        }
      }
    }
    this.state = { joined: false, roomId };
    this.rateLimiter = new SlidingWindowRateLimiter(config.rateLimitPerSec);
    this.sink = {
      send: (message) => this.send(message),
      close: (code, reason) => this.socket.close(code, reason)
    };
  }

  start(): void {
    this.socket.on('message', (data) => {
      this.lastTrafficAt = Date.now();
      this.queue = this.queue.then(() => this.handleRawMessage(data)).catch(() => undefined);
    });
    this.socket.on('close', () => this.close('socket-close'));
    this.heartbeatTimer = setInterval(() => {
      if (Date.now() - this.lastTrafficAt > 45_000) {
        this.socket.close(4008, 'heartbeat timeout');
      }
    }, 5_000);
  }

  private async handleRawMessage(data: RawData): Promise<void> {
    if (!this.rateLimiter.allow()) {
      this.send(fail(0, 'RATE_LIMITED', 'too many requests'));
      return;
    }

    let request: RequestEnvelope;
    try {
      request = parseRequest(data.toString('utf8'));
    } catch (error) {
      this.send(fail(0, 'INVALID_MESSAGE', validationMessage(error)));
      return;
    }

    try {
      const response = await this.handleRequest(request);
      this.send(ok(request.id, response));
    } catch (error) {
      const mapped = mapError(error);
      this.send(fail(request.id, mapped.code, mapped.message));
      if (mapped.closeCode) {
        this.socket.close(mapped.closeCode, mapped.message);
      }
    }
  }

  private async handleRequest(request: RequestEnvelope): Promise<Record<string, unknown>> {
    if (request.method === 'ping') {
      return { ts: Date.now() };
    }
    if (request.method === 'join') {
      return this.handleJoin(request);
    }
    if (!this.state.joined) {
      throw new SignalingError('NOT_JOINED', 'join must be the first request');
    }

    switch (request.method) {
      case 'leave':
        this.intentionalLeave = true;
        this.state.room.removePeer(this.state.peer.id, 'left');
        setTimeout(() => this.socket.close(1000, 'left'), 0);
        return {};
      case 'track.publish':
        return this.handleTrackPublish(request, this.state.room, this.state.peer);
      case 'publisher.offer':
        return this.handlePublisherOffer(request, this.state.peer);
      case 'subscriber.answer':
        return this.handleSubscriberAnswer(request, this.state.peer);
      case 'ice.candidate':
        return this.handleIceCandidate(request, this.state.peer);
      case 'ice.restart':
        return this.handleIceRestart(request, this.state.peer);
      case 'track.mute':
        return this.handleTrackMute(request, this.state.room, this.state.peer);
      case 'track.unpublish':
        return this.handleTrackUnpublish(request, this.state.room, this.state.peer);
      case 'subscription.update':
        return this.handleSubscriptionUpdate(request, this.state.peer);
      default:
        throw new SignalingError('INVALID_MESSAGE', `unknown method: ${request.method}`);
    }
  }

  private handleJoin(request: RequestEnvelope): Record<string, unknown> {
    if (this.state.joined) {
      throw new SignalingError('ALREADY_JOINED', 'peer is already joined');
    }
    const params = joinParamsSchema.parse(request.params);
    const room = this.roomManager.getOrCreate(this.state.roomId);
    let peer = params.reconnectToken ? room.reconnectPeer(params.reconnectToken, this.sink) : undefined;
    if (!peer) {
      peer = room.addPeer(params.displayName, (message) => this.send(message), {
        autoSubscribe: params.autoSubscribe
      });
      peer.bindSession(this.sink);
    }
    this.state = { joined: true, roomId: room.id, room, peer };
    this.attachMediaListeners(peer);

    return {
      peerId: peer.id,
      roomId: room.id,
      iceServers: this.config.iceServers,
      serverConfig: {
        codecs: { audio: 'opus', video: 'vp8' },
        pingIntervalMs: 15_000,
        maxVideoBitrateKbps: 1500
      },
      peers: [...room.peers.values()].filter((p) => p.id !== peer.id).map((p) => p.toPeerInfo()),
      reconnectToken: peer.reconnectToken
    };
  }

  private attachMediaListeners(peer: Peer): void {
    this.publisherTrackUnsub?.();
    this.publisherTrackUnsub = peer.publisher.onTrack((track) => this.handleIncomingTrack(track));
    peer.publisher.onIceCandidate((candidate) => this.sendIceCandidate('publisher', candidate));
    peer.subscriber.onIceCandidate((candidate) => this.sendIceCandidate('subscriber', candidate));
  }

  private async handleTrackPublish(request: RequestEnvelope, room: Room, peer: Peer): Promise<Record<string, unknown>> {
    const params = trackPublishParamsSchema.parse(request.params);
    const trackSid = room.registerPendingTrack(peer.id, {
      cid: params.cid,
      kind: params.kind,
      source: params.source
    });
    return { trackSid };
  }

  private async handlePublisherOffer(request: RequestEnvelope, peer: Peer): Promise<Record<string, unknown>> {
    const params = publisherOfferParamsSchema.parse(request.params);
    this.pendingMidToCid.clear();
    for (const binding of params.mids) {
      this.pendingMidToCid.set(binding.mid, binding.cid);
    }
    await peer.publisher.setRemoteDescription(params.sdp as SessionDescription);
    const answer = await peer.publisher.createAnswer();
    return { sdp: answer };
  }

  private async handleSubscriberAnswer(request: RequestEnvelope, peer: Peer): Promise<Record<string, unknown>> {
    const params = subscriberAnswerParamsSchema.parse(request.params);
    const accepted = await peer.negotiator.onAnswer(params.offerId, params.sdp as { type: 'answer'; sdp: string });
    if (!accepted) {
      throw new SignalingError('NEGOTIATION_FAILED', 'stale or unexpected subscriber answer');
    }
    return {};
  }

  private async handleIceCandidate(request: RequestEnvelope, peer: Peer): Promise<Record<string, unknown>> {
    const params = iceCandidateParamsSchema.parse(request.params);
    if (!params.candidate) return {};
    const target = params.target === 'publisher' ? peer.publisher : peer.subscriber;
    await target.addIceCandidate(params.candidate);
    return {};
  }

  private async handleIceRestart(request: RequestEnvelope, peer: Peer): Promise<Record<string, unknown>> {
    const params = iceRestartParamsSchema.parse(request.params);
    if (params.target === 'subscriber') {
      const { offerId, sdp } = await peer.negotiator.restartIce();
      return { offerId, sdp };
    }
    if (!params.sdp || params.sdp.type !== 'offer') {
      throw new SignalingError('INVALID_MESSAGE', 'publisher ice.restart requires an offer');
    }
    await peer.publisher.setRemoteDescription(params.sdp as SessionDescription);
    const answer = await peer.publisher.createAnswer();
    return { sdp: answer };
  }

  private handleTrackMute(request: RequestEnvelope, room: Room, peer: Peer): Record<string, unknown> {
    const params = trackMuteParamsSchema.parse(request.params);
    room.muteTrack(peer.id, params.trackSid, params.muted);
    return {};
  }

  private handleTrackUnpublish(request: RequestEnvelope, room: Room, peer: Peer): Record<string, unknown> {
    const params = trackUnpublishParamsSchema.parse(request.params);
    room.unpublishTrack(peer.id, params.trackSid);
    return {};
  }

  private handleSubscriptionUpdate(request: RequestEnvelope, peer: Peer): Record<string, unknown> {
    const params = subscriptionUpdateParamsSchema.parse(request.params);
    const consumer = peer.consumers.get(params.trackSid);
    if (!consumer) {
      throw new SignalingError('TRACK_NOT_FOUND', 'subscription track not found');
    }
    if (params.subscribed === false) {
      peer.removeConsumer(params.trackSid);
      return { trackSid: params.trackSid, subscribed: false, paused: true };
    }
    if (params.paused === true) {
      consumer.pause();
    } else if (params.paused === false) {
      consumer.resume();
    }
    return { trackSid: params.trackSid, paused: consumer.paused };
  }

  private handleIncomingTrack(track: IncomingTrack): void {
    if (!this.state.joined) return;
    const cid = this.pendingMidToCid.get(track.mid) ?? this.findPendingCidByKind(track.kind);
    if (!cid) return;
    const pending = this.state.peer.pendingTracksByCid.get(cid);
    if (!pending) return;
    this.state.room.addProducerFromIncomingTrack(this.state.peer.id, pending.trackSid, cid, track);
  }

  private findPendingCidByKind(kind: IncomingTrack['kind']): string | undefined {
    if (!this.state.joined) return undefined;
    const matches = [...this.state.peer.pendingTracksByCid.values()].filter((track) => track.kind === kind);
    return matches.length === 1 ? matches[0]?.cid : undefined;
  }

  private sendIceCandidate(target: 'publisher' | 'subscriber', candidate: IceCandidateInit): void {
    this.send({ type: 'notification', event: 'ice.candidate', data: { target, candidate } });
  }

  private send(message: OutboundEnvelope): void {
    if (this.socket.readyState !== this.socket.OPEN) return;
    this.socket.send(JSON.stringify(message));
  }

  private close(_reason: string): void {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    this.publisherTrackUnsub?.();
    if (!this.state.joined || this.intentionalLeave) return;
    if (!this.state.peer.isCurrentSession(this.sink)) return;
    this.state.room.disconnectPeer(this.state.peer.id);
  }
}

class SignalingError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly closeCode?: number
  ) {
    super(message);
  }
}

function mapError(error: unknown): { code: ErrorCode; message: string; closeCode?: number } {
  if (error instanceof SignalingError) {
    return { code: error.code, message: error.message, closeCode: error.closeCode };
  }
  if (error instanceof ZodError) {
    return { code: 'INVALID_MESSAGE', message: validationMessage(error) };
  }
  if (error instanceof Error) {
    if (error.message === 'ROOM_FULL') {
      return { code: 'ROOM_FULL', message: 'room is full', closeCode: 4003 };
    }
    if (error.message === 'ROOM_CLOSED') {
      return { code: 'ROOM_CLOSED', message: 'room is closed', closeCode: 4002 };
    }
    if (error.message === 'TRACK_NOT_FOUND') {
      return { code: 'TRACK_NOT_FOUND', message: 'track not found' };
    }
  }
  return { code: 'INTERNAL', message: 'internal error' };
}

function validationMessage(error: unknown): string {
  if (error instanceof ZodError) {
    return error.issues.map((issue) => `${issue.path.join('.') || 'message'}: ${issue.message}`).join('; ');
  }
  if (error instanceof SyntaxError) {
    return 'message must be valid JSON';
  }
  return 'invalid message';
}
