import fastify from 'fastify';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/config.js';
import { registerHttpRoutes } from '../src/api/http.js';
import { registerSignalingServer } from '../src/signaling/SignalingServer.js';
import type { OutboundEnvelope } from '../src/signaling/protocol.js';
import { RoomManager } from '../src/sfu/RoomManager.js';
import { FakeTransport } from '../src/transport/FakeTransport.js';
import { newTransportId } from '../src/util/ids.js';

const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('SignalingServer', () => {
  it('requires join before other requests', async () => {
    const { url } = await startServer();
    const client = await connect(`${url}/ws?room=demo`);
    const response = await request(client, 1, 'track.publish', { cid: 'x', kind: 'audio', source: 'microphone' });

    expect(response).toEqual({
      type: 'response',
      id: 1,
      ok: false,
      error: { code: 'NOT_JOINED', message: 'join must be the first request' }
    });
    client.close();
  });

  it('joins peers and broadcasts peer lifecycle notifications', async () => {
    const { url } = await startServer();
    const alice = await connect(`${url}/ws?room=demo`);
    const bob = await connect(`${url}/ws?room=demo`);

    const aliceJoin = await request(alice, 1, 'join', { displayName: 'Alice', autoSubscribe: true, reconnectToken: null });
    expect(aliceJoin.ok).toBe(true);
    if (!aliceJoin.ok) throw new Error('join failed');
    expect(aliceJoin.data.peerId).toEqual(expect.any(String));
    expect(aliceJoin.data.peers).toEqual([]);

    const alicePeerJoinedPromise = nextMessage(alice);
    const bobJoinPromise = request(bob, 1, 'join', { displayName: 'Bob', autoSubscribe: true, reconnectToken: null });
    const alicePeerJoined = await alicePeerJoinedPromise;
    const bobJoin = await bobJoinPromise;

    expect(bobJoin.ok).toBe(true);
    if (!bobJoin.ok) throw new Error('join failed');
    expect(bobJoin.data.peers).toHaveLength(1);
    expect(alicePeerJoined).toMatchObject({
      type: 'notification',
      event: 'peer.joined',
      data: { peer: { displayName: 'Bob' } }
    });

    const alicePeerLeftPromise = nextMessage(alice);
    await request(bob, 2, 'leave', {});
    const alicePeerLeft = await alicePeerLeftPromise;
    expect(alicePeerLeft).toMatchObject({
      type: 'notification',
      event: 'peer.left',
      data: { reason: 'left' }
    });
    alice.close();
  });

  it('declares tracks and handles publisher offers', async () => {
    const { url } = await startServer();
    const client = await connect(`${url}/ws?room=demo`);

    await request(client, 1, 'join', { displayName: 'Alice', autoSubscribe: true, reconnectToken: null });
    const publish = await request(client, 2, 'track.publish', { cid: 'cam', kind: 'video', source: 'camera' });
    expect(publish.ok).toBe(true);
    if (!publish.ok) throw new Error('publish failed');
    expect(publish.data.trackSid).toMatch(/^TR_/);

    const offer = await request(client, 3, 'publisher.offer', {
      sdp: { type: 'offer', sdp: 'fake-offer' },
      mids: [{ mid: '0', cid: 'cam' }]
    });
    expect(offer).toMatchObject({
      type: 'response',
      id: 3,
      ok: true,
      data: { sdp: { type: 'answer', sdp: 'fake-answer' } }
    });
    client.close();
  });

  it('handles ping request with ts timestamp response', async () => {
    const { url } = await startServer();
    const client = await connect(`${url}/ws?room=demo`);

    const pingRes = await request(client, 1, 'ping', {});
    expect(pingRes.ok).toBe(true);
    if (!pingRes.ok) throw new Error('ping failed');
    expect(pingRes.data.ts).toEqual(expect.any(Number));
    client.close();
  });

  it('supports peer kick via DELETE REST API', async () => {
    const { url, httpUrl } = await startServer();
    const alice = await connect(`${url}/ws?room=kick-room`);
    const joinRes = await request(alice, 1, 'join', { displayName: 'Alice' });
    expect(joinRes.ok).toBe(true);
    if (!joinRes.ok) throw new Error('join failed');
    const peerId = joinRes.data.peerId as string;

    const res = await fetch(`${httpUrl}/api/rooms/kick-room/peers/${peerId}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
  });
});

async function startServer(): Promise<{ url: string; httpUrl: string }> {
  const app = fastify({ logger: false });
  const config = testConfig();
  const roomManager = new RoomManager({
    maxPeersPerRoom: config.maxPeersPerRoom,
    emptyRoomTtlMs: config.emptyRoomTtlMs,
    pliThrottleMs: config.pliThrottleMs,
    negotiationDebounceMs: config.negotiationDebounceMs,
    speakerThreshold: config.speakerThreshold,
    packetCacheSize: config.packetCacheSize,
    createTransport: (role) => new FakeTransport(newTransportId(), role)
  });
  registerHttpRoutes(app, roomManager, config);
  await registerSignalingServer({ app, roomManager, config });
  await app.listen({ port: 0, host: '127.0.0.1' });
  servers.push({ close: () => app.close() });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('server address unavailable');
  return { url: `ws://127.0.0.1:${address.port}`, httpUrl: `http://127.0.0.1:${address.port}` };
}

function testConfig(): AppConfig {
  return {
    port: 0,
    rtcPortRange: { min: 40000, max: 40100 },
    iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
    maxPeersPerRoom: 4,
    emptyRoomTtlMs: 30_000,
    authMode: 'none',
    pliThrottleMs: 0,
    negotiationDebounceMs: 0,
    reconnectGraceMs: 10_000,
    speakerThreshold: 50,
    packetCacheSize: 8,
    lastNVideo: 0,
    rateLimitPerSec: 50,
    logLevel: 'silent'
  };
}

async function connect(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return ws;
}

async function request(client: WebSocket, id: number, method: string, params: Record<string, unknown>): Promise<Extract<OutboundEnvelope, { type: 'response' }>> {
  client.send(JSON.stringify({ type: 'request', id, method, params }));
  const message = await nextMessage(client);
  if (message.type !== 'response') {
    throw new Error(`expected response, got ${message.type}`);
  }
  return message;
}

async function nextMessage(client: WebSocket): Promise<OutboundEnvelope> {
  return await new Promise((resolve, reject) => {
    client.once('message', (data) => {
      resolve(JSON.parse(data.toString()) as OutboundEnvelope);
    });
    client.once('error', reject);
  });
}
