import type { IMediaTransport } from '../transport/IMediaTransport.js';
import type { EngineMetrics } from '../util/metrics.js';
import { newRoomId } from '../util/ids.js';
import { Room } from './Room.js';

export interface RoomManagerOptions {
  maxPeersPerRoom: number;
  emptyRoomTtlMs: number;
  pliThrottleMs: number;
  negotiationDebounceMs: number;
  speakerThreshold: number;
  packetCacheSize: number;
  reconnectGraceMs?: number;
  lastNVideo?: number;
  metrics?: EngineMetrics;
  createTransport: (role: 'publisher' | 'subscriber') => IMediaTransport;
}

export class RoomManager {
  readonly rooms = new Map<string, Room>();

  constructor(private readonly options: RoomManagerOptions) {}

  getOrCreate(roomId = newRoomId()): Room {
    let room = this.rooms.get(roomId);
    if (room) return room;
    room = this.makeRoom(roomId, this.options.maxPeersPerRoom);
    this.rooms.set(roomId, room);
    return room;
  }

  create(roomId = newRoomId(), maxPeers?: number): Room {
    if (this.rooms.has(roomId)) {
      throw new Error('ROOM_EXISTS');
    }
    const room = this.makeRoom(roomId, maxPeers ?? this.options.maxPeersPerRoom);
    this.rooms.set(roomId, room);
    return room;
  }

  close(roomId: string): boolean {
    const room = this.rooms.get(roomId);
    if (!room) return false;
    room.close('admin');
    this.rooms.delete(roomId);
    return true;
  }

  stats(): {
    rooms: number;
    peers: number;
    producers: number;
    consumers: number;
    cpuLoad: number;
    rssMb: number;
    eventLoopLagMs: number;
  } {
    let peers = 0;
    let producers = 0;
    let consumers = 0;
    for (const room of this.rooms.values()) {
      for (const peer of room.peers.values()) {
        peers += 1;
        producers += peer.producers.size;
        consumers += peer.consumers.size;
      }
    }
    return {
      rooms: this.rooms.size,
      peers,
      producers,
      consumers,
      ...(this.options.metrics?.snapshot() ?? { cpuLoad: 0, rssMb: 0, eventLoopLagMs: 0 })
    };
  }

  private makeRoom(id: string, maxPeers: number): Room {
    return new Room({
      id,
      maxPeers,
      emptyRoomTtlMs: this.options.emptyRoomTtlMs,
      pliThrottleMs: this.options.pliThrottleMs,
      negotiationDebounceMs: this.options.negotiationDebounceMs,
      speakerThreshold: this.options.speakerThreshold,
      packetCacheSize: this.options.packetCacheSize,
      reconnectGraceMs: this.options.reconnectGraceMs,
      lastNVideo: this.options.lastNVideo,
      createTransport: this.options.createTransport,
      onEmptyExpired: (empty) => this.rooms.delete(empty.id)
    });
  }
}
