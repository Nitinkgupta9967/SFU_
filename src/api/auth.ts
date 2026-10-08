import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';

export interface RoomTokenClaims {
  roomId: string;
  displayName?: string;
  exp: number;
}

export function signRoomToken(claims: RoomTokenClaims, secret: string): string {
  const header = base64urlJson({ alg: 'HS256', typ: 'JWT' });
  const payload = base64urlJson(claims);
  const signature = sign(`${header}.${payload}`, secret);
  return `${header}.${payload}.${signature}`;
}

export function verifyRoomToken(token: string, secret: string): RoomTokenClaims {
  const [header, payload, signature] = token.split('.');
  if (!header || !payload || !signature) throw new Error('malformed token');
  const expected = sign(`${header}.${payload}`, secret);
  if (!safeEqual(signature, expected)) throw new Error('bad token signature');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as RoomTokenClaims;
  if (!claims.roomId || !claims.exp) throw new Error('invalid token claims');
  if (Date.now() / 1000 >= claims.exp) throw new Error('token expired');
  return claims;
}

export function requireAdmin(config: AppConfig) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!config.adminApiKey) return;
    const authorization = request.headers.authorization;
    if (authorization !== `Bearer ${config.adminApiKey}`) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'missing or invalid admin API key' } });
    }
  };
}

function sign(input: string, secret: string): string {
  return createHmac('sha256', secret).update(input).digest('base64url');
}

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
