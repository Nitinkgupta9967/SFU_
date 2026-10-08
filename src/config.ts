import { z } from 'zod';

const iceServerSchema = z.object({
  urls: z.union([z.string(), z.array(z.string()).min(1)]),
  username: z.string().optional(),
  credential: z.string().optional()
});

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  PUBLIC_IP: z.string().optional().transform((v) => (v && v.length > 0 ? v : undefined)),
  RTC_MIN_PORT: z.coerce.number().int().positive().default(40000),
  RTC_MAX_PORT: z.coerce.number().int().positive().default(40100),
  ICE_SERVERS: z
    .string()
    .default('[{"urls":["stun:stun.l.google.com:19302"]}]')
    .transform((raw, ctx) => {
      try {
        return z.array(iceServerSchema).parse(JSON.parse(raw));
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'ICE_SERVERS must be a JSON array' });
        return z.NEVER;
      }
    }),
  MAX_PEERS_PER_ROOM: z.coerce.number().int().positive().default(16),
  EMPTY_ROOM_TTL_MS: z.coerce.number().int().nonnegative().default(30000),
  AUTH_MODE: z.enum(['none', 'jwt']).default('none'),
  JWT_SECRET: z.string().optional(),
  ADMIN_API_KEY: z.string().optional(),
  PLI_THROTTLE_MS: z.coerce.number().int().nonnegative().default(500),
  NEGOTIATION_DEBOUNCE_MS: z.coerce.number().int().nonnegative().default(50),
  RECONNECT_GRACE_MS: z.coerce.number().int().nonnegative().default(10000),
  SPEAKER_THRESHOLD: z.coerce.number().int().min(0).max(127).default(50),
  PACKET_CACHE_SIZE: z.coerce.number().int().positive().default(256),
  LAST_N_VIDEO: z.coerce.number().int().nonnegative().default(0),
  RATE_LIMIT_PER_SEC: z.coerce.number().int().positive().default(50),
  LOG_LEVEL: z.string().default('info')
});

export type IceServerConfig = z.infer<typeof iceServerSchema>;

export interface AppConfig {
  port: number;
  publicIp?: string;
  rtcPortRange: { min: number; max: number };
  iceServers: IceServerConfig[];
  maxPeersPerRoom: number;
  emptyRoomTtlMs: number;
  authMode: 'none' | 'jwt';
  jwtSecret?: string;
  adminApiKey?: string;
  pliThrottleMs: number;
  negotiationDebounceMs: number;
  reconnectGraceMs: number;
  speakerThreshold: number;
  packetCacheSize: number;
  lastNVideo: number;
  rateLimitPerSec: number;
  logLevel: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);
  if (parsed.RTC_MIN_PORT > parsed.RTC_MAX_PORT) {
    throw new Error('RTC_MIN_PORT must be less than or equal to RTC_MAX_PORT');
  }
  if (parsed.AUTH_MODE === 'jwt' && !parsed.JWT_SECRET) {
    throw new Error('JWT_SECRET is required when AUTH_MODE=jwt');
  }

  return {
    port: parsed.PORT,
    publicIp: parsed.PUBLIC_IP,
    rtcPortRange: { min: parsed.RTC_MIN_PORT, max: parsed.RTC_MAX_PORT },
    iceServers: parsed.ICE_SERVERS,
    maxPeersPerRoom: parsed.MAX_PEERS_PER_ROOM,
    emptyRoomTtlMs: parsed.EMPTY_ROOM_TTL_MS,
    authMode: parsed.AUTH_MODE,
    jwtSecret: parsed.JWT_SECRET,
    adminApiKey: parsed.ADMIN_API_KEY,
    pliThrottleMs: parsed.PLI_THROTTLE_MS,
    negotiationDebounceMs: parsed.NEGOTIATION_DEBOUNCE_MS,
    reconnectGraceMs: parsed.RECONNECT_GRACE_MS,
    speakerThreshold: parsed.SPEAKER_THRESHOLD,
    packetCacheSize: parsed.PACKET_CACHE_SIZE,
    lastNVideo: parsed.LAST_N_VIDEO,
    rateLimitPerSec: parsed.RATE_LIMIT_PER_SEC,
    logLevel: parsed.LOG_LEVEL
  };
}
