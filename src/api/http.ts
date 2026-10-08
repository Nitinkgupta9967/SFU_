import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config.js';
import type { RoomManager } from '../sfu/RoomManager.js';
import { requireAdmin, signRoomToken } from './auth.js';

export function registerHttpRoutes(app: FastifyInstance, roomManager: RoomManager, config: AppConfig): void {
  const startedAt = Date.now();

  app.get('/healthz', async () => ({
    status: 'ok',
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000)
  }));

  const admin = { preHandler: requireAdmin(config) };

  app.post<{ Body: { roomId?: string; maxPeers?: number } }>('/api/rooms', admin, async (request, reply) => {
    try {
      const room = roomManager.create(request.body?.roomId, request.body?.maxPeers);
      return reply.code(201).send({
        roomId: room.id,
        maxPeers: request.body?.maxPeers,
        createdAt: room.createdAt.toISOString()
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'ROOM_EXISTS') {
        return reply.code(409).send({ error: { code: 'ROOM_EXISTS', message: 'room already exists' } });
      }
      throw error;
    }
  });

  app.get('/api/rooms', admin, async () => ({
    rooms: [...roomManager.rooms.values()].map((room) => room.stats())
  }));

  app.get<{ Params: { roomId: string } }>('/api/rooms/:roomId', admin, async (request, reply) => {
    const room = roomManager.rooms.get(request.params.roomId);
    if (!room) {
      return reply.code(404).send({ error: { code: 'ROOM_NOT_FOUND', message: 'room not found' } });
    }
    return room.detail();
  });

  app.delete<{ Params: { roomId: string } }>('/api/rooms/:roomId', admin, async (request, reply) => {
    if (!roomManager.close(request.params.roomId)) {
      return reply.code(404).send({ error: { code: 'ROOM_NOT_FOUND', message: 'room not found' } });
    }
    return reply.code(204).send();
  });

  app.post<{ Params: { roomId: string }; Body: { displayName?: string; ttlSec?: number } }>(
    '/api/rooms/:roomId/token',
    admin,
    async (request, reply) => {
      if (!config.jwtSecret) {
        return reply.code(400).send({ error: { code: 'AUTH_DISABLED', message: 'JWT_SECRET is not configured' } });
      }
      const ttlSec = request.body?.ttlSec ?? 3600;
      const expiresAt = Math.floor(Date.now() / 1000) + ttlSec;
      return {
        token: signRoomToken(
          {
            roomId: request.params.roomId,
            displayName: request.body?.displayName,
            exp: expiresAt
          },
          config.jwtSecret
        ),
        expiresAt: new Date(expiresAt * 1000).toISOString()
      };
    }
  );

  app.delete<{ Params: { roomId: string; peerId: string } }>(
    '/api/rooms/:roomId/peers/:peerId',
    admin,
    async (request, reply) => {
      const room = roomManager.rooms.get(request.params.roomId);
      if (!room || !room.peers.has(request.params.peerId)) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'peer not found' } });
      }
      room.removePeer(request.params.peerId, 'kicked');
      return reply.code(204).send();
    }
  );

  app.get('/api/stats', admin, async () => roomManager.stats());

  app.get('/metrics', admin, async (_request, reply) => {
    const stats = roomManager.stats();
    return reply.type('text/plain; version=0.0.4').send(
      [
        '# HELP mini_sfu_rooms Active rooms',
        '# TYPE mini_sfu_rooms gauge',
        `mini_sfu_rooms ${stats.rooms}`,
        '# HELP mini_sfu_peers Active peers',
        '# TYPE mini_sfu_peers gauge',
        `mini_sfu_peers ${stats.peers}`,
        '# HELP mini_sfu_producers Active producers',
        '# TYPE mini_sfu_producers gauge',
        `mini_sfu_producers ${stats.producers}`,
        '# HELP mini_sfu_consumers Active consumers',
        '# TYPE mini_sfu_consumers gauge',
        `mini_sfu_consumers ${stats.consumers}`,
        '# HELP mini_sfu_cpu_load Process CPU load (0-1)',
        '# TYPE mini_sfu_cpu_load gauge',
        `mini_sfu_cpu_load ${stats.cpuLoad}`,
        '# HELP mini_sfu_rss_mb Resident set size in megabytes',
        '# TYPE mini_sfu_rss_mb gauge',
        `mini_sfu_rss_mb ${stats.rssMb}`,
        '# HELP mini_sfu_event_loop_lag_ms Event loop lag in milliseconds',
        '# TYPE mini_sfu_event_loop_lag_ms gauge',
        `mini_sfu_event_loop_lag_ms ${stats.eventLoopLagMs}`,
        ''
      ].join('\n')
    );
  });
}
