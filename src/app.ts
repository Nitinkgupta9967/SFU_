import fastify from 'fastify';
import type { AppConfig } from './config.js';
import { registerDemoRoutes } from './api/demo.js';
import { registerHttpRoutes } from './api/http.js';
import { registerSignalingServer } from './signaling/SignalingServer.js';
import { RoomManager } from './sfu/RoomManager.js';
import { WeriftTransport } from './transport/WeriftTransport.js';
import { EngineMetrics } from './util/metrics.js';

export async function createApp(config: AppConfig) {
  const metrics = new EngineMetrics();
  metrics.start();
  const roomManager = new RoomManager({
    maxPeersPerRoom: config.maxPeersPerRoom,
    emptyRoomTtlMs: config.emptyRoomTtlMs,
    pliThrottleMs: config.pliThrottleMs,
    negotiationDebounceMs: config.negotiationDebounceMs,
    speakerThreshold: config.speakerThreshold,
    packetCacheSize: config.packetCacheSize,
    reconnectGraceMs: config.reconnectGraceMs,
    lastNVideo: config.lastNVideo,
    metrics,
    createTransport: (role) => new WeriftTransport(role, config)
  });

  const app = fastify({ logger: { level: config.logLevel } });
  app.addHook('onClose', async () => metrics.stop());
  registerHttpRoutes(app, roomManager, config);
  registerDemoRoutes(app);
  await registerSignalingServer({ app, roomManager, config });
  return { app, roomManager };
}
