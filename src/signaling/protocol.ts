import { z } from 'zod';

export const mediaKindSchema = z.enum(['audio', 'video']);
export type MediaKind = z.infer<typeof mediaKindSchema>;

export const trackSourceSchema = z.enum(['microphone', 'camera', 'screen']);
export type TrackSource = z.infer<typeof trackSourceSchema>;

export const errorCodeSchema = z.enum([
  'INVALID_MESSAGE',
  'NOT_JOINED',
  'ALREADY_JOINED',
  'UNAUTHORIZED',
  'ROOM_FULL',
  'ROOM_CLOSED',
  'TRACK_NOT_FOUND',
  'NEGOTIATION_FAILED',
  'RATE_LIMITED',
  'INTERNAL'
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const iceCandidateSchema = z.object({
  candidate: z.string(),
  sdpMid: z.string().nullable().optional(),
  sdpMLineIndex: z.number().int().nullable().optional()
});
export type IceCandidateInit = z.infer<typeof iceCandidateSchema>;

export const sessionDescriptionSchema = z.object({
  type: z.enum(['offer', 'answer']),
  sdp: z.string().min(1).max(256 * 1024)
});
export type SessionDescription = z.infer<typeof sessionDescriptionSchema>;

export const trackInfoSchema = z.object({
  trackSid: z.string(),
  peerId: z.string(),
  kind: mediaKindSchema,
  source: trackSourceSchema,
  muted: z.boolean()
});
export type TrackInfo = z.infer<typeof trackInfoSchema>;

export const peerInfoSchema = z.object({
  peerId: z.string(),
  displayName: z.string(),
  tracks: z.array(trackInfoSchema)
});
export type PeerInfo = z.infer<typeof peerInfoSchema>;

export const requestEnvelopeSchema = z.object({
  type: z.literal('request'),
  id: z.number().int().nonnegative(),
  method: z.string().min(1),
  params: z.record(z.unknown()).default({})
});
export type RequestEnvelope = z.infer<typeof requestEnvelopeSchema>;

export const responseEnvelopeSchema = z.discriminatedUnion('ok', [
  z.object({
    type: z.literal('response'),
    id: z.number().int().nonnegative(),
    ok: z.literal(true),
    data: z.record(z.unknown())
  }),
  z.object({
    type: z.literal('response'),
    id: z.number().int().nonnegative(),
    ok: z.literal(false),
    error: z.object({ code: errorCodeSchema, message: z.string() })
  })
]);
export type ResponseEnvelope = z.infer<typeof responseEnvelopeSchema>;

export const notificationEnvelopeSchema = z.object({
  type: z.literal('notification'),
  event: z.string().min(1),
  data: z.record(z.unknown())
});
export type NotificationEnvelope = z.infer<typeof notificationEnvelopeSchema>;

export const inboundEnvelopeSchema = requestEnvelopeSchema;
export type InboundEnvelope = z.infer<typeof inboundEnvelopeSchema>;

export const outboundEnvelopeSchema = z.union([responseEnvelopeSchema, notificationEnvelopeSchema]);
export type OutboundEnvelope = ResponseEnvelope | NotificationEnvelope;

export const joinParamsSchema = z.object({
  displayName: z.string().min(1).max(80),
  autoSubscribe: z.boolean().default(true),
  reconnectToken: z.string().nullable().optional().default(null)
});
export type JoinParams = z.infer<typeof joinParamsSchema>;

export const trackPublishParamsSchema = z.object({
  cid: z.string().min(1).max(128),
  kind: mediaKindSchema,
  source: trackSourceSchema,
  simulcast: z.boolean().default(false)
});
export type TrackPublishParams = z.infer<typeof trackPublishParamsSchema>;

export const publisherOfferParamsSchema = z.object({
  sdp: sessionDescriptionSchema.refine((s) => s.type === 'offer', 'publisher.offer requires an offer'),
  mids: z.array(z.object({ mid: z.string(), cid: z.string() })).min(1)
});

export const subscriberAnswerParamsSchema = z.object({
  offerId: z.number().int().positive(),
  sdp: sessionDescriptionSchema.refine((s) => s.type === 'answer', 'subscriber.answer requires an answer')
});

export const iceCandidateParamsSchema = z.object({
  target: z.enum(['publisher', 'subscriber']),
  candidate: iceCandidateSchema.nullable().optional()
});

export const iceRestartParamsSchema = z.object({
  target: z.enum(['publisher', 'subscriber']),
  sdp: sessionDescriptionSchema.optional()
});

export const trackMuteParamsSchema = z.object({
  trackSid: z.string(),
  muted: z.boolean()
});

export const trackUnpublishParamsSchema = z.object({
  trackSid: z.string()
});

export const subscriptionUpdateParamsSchema = z.object({
  trackSid: z.string(),
  subscribed: z.boolean().optional(),
  paused: z.boolean().optional(),
  preferredLayer: z.string().optional()
});

export function parseRequest(raw: string): RequestEnvelope {
  return inboundEnvelopeSchema.parse(JSON.parse(raw));
}

export function ok(id: number, data: Record<string, unknown> = {}): ResponseEnvelope {
  return { type: 'response', id, ok: true, data };
}

export function fail(id: number, code: ErrorCode, message: string): ResponseEnvelope {
  return { type: 'response', id, ok: false, error: { code, message } };
}

export function notification(event: string, data: Record<string, unknown>): NotificationEnvelope {
  return { type: 'notification', event, data };
}
