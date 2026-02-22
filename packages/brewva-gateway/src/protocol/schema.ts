import { Type, type Static } from "@sinclair/typebox";

export const PROTOCOL_VERSION = 1 as const;

const NonEmptyString = Type.String({ minLength: 1 });

export const ErrorCodes = {
  INVALID_REQUEST: "invalid_request",
  UNAUTHORIZED: "unauthorized",
  METHOD_NOT_FOUND: "method_not_found",
  INTERNAL: "internal_error",
  TIMEOUT: "timeout",
  BAD_STATE: "bad_state",
} as const;

export type GatewayErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export const GatewayMethods = [
  "connect",
  "health",
  "status.deep",
  "sessions.open",
  "sessions.subscribe",
  "sessions.unsubscribe",
  "sessions.send",
  "sessions.abort",
  "sessions.close",
  "heartbeat.reload",
  "gateway.rotate-token",
  "gateway.stop",
] as const;

export type GatewayMethod = (typeof GatewayMethods)[number];

export const GatewayEvents = [
  "connect.challenge",
  "tick",
  "session.turn.start",
  "session.turn.chunk",
  "session.turn.error",
  "session.turn.end",
  "heartbeat.fired",
  "shutdown",
] as const;

export type GatewayEvent = (typeof GatewayEvents)[number];

export const GatewayErrorShapeSchema = Type.Object(
  {
    code: Type.String({ minLength: 1 }),
    message: Type.String({ minLength: 1 }),
    retryable: Type.Optional(Type.Boolean()),
    details: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

export type GatewayErrorShape = Static<typeof GatewayErrorShapeSchema>;

export const ConnectParamsSchema = Type.Object(
  {
    protocol: Type.Integer({ minimum: 1 }),
    client: Type.Object(
      {
        id: NonEmptyString,
        version: NonEmptyString,
        mode: Type.Optional(NonEmptyString),
      },
      { additionalProperties: false },
    ),
    auth: Type.Object(
      {
        token: NonEmptyString,
      },
      { additionalProperties: false },
    ),
    challengeNonce: NonEmptyString,
  },
  { additionalProperties: false },
);

export type ConnectParams = Static<typeof ConnectParamsSchema>;

export const ConnectChallengePayloadSchema = Type.Object(
  {
    nonce: NonEmptyString,
    ts: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export type ConnectChallengePayload = Static<typeof ConnectChallengePayloadSchema>;

export const HelloOkPayloadSchema = Type.Object(
  {
    type: Type.Literal("hello-ok"),
    protocol: Type.Integer({ minimum: 1 }),
    server: Type.Object(
      {
        version: NonEmptyString,
        connId: NonEmptyString,
        pid: Type.Integer({ minimum: 1 }),
      },
      { additionalProperties: false },
    ),
    features: Type.Object(
      {
        methods: Type.Array(NonEmptyString),
        events: Type.Array(NonEmptyString),
      },
      { additionalProperties: false },
    ),
    policy: Type.Object(
      {
        maxPayloadBytes: Type.Integer({ minimum: 1024 }),
        tickIntervalMs: Type.Integer({ minimum: 1000 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type HelloOkPayload = Static<typeof HelloOkPayloadSchema>;

export const RequestFrameSchema = Type.Object(
  {
    type: Type.Literal("req"),
    id: NonEmptyString,
    traceId: Type.Optional(NonEmptyString),
    method: NonEmptyString,
    params: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

export type RequestFrame = Static<typeof RequestFrameSchema>;

export const ResponseFrameSchema = Type.Object(
  {
    type: Type.Literal("res"),
    id: NonEmptyString,
    traceId: Type.Optional(NonEmptyString),
    ok: Type.Boolean(),
    payload: Type.Optional(Type.Unknown()),
    error: Type.Optional(GatewayErrorShapeSchema),
  },
  { additionalProperties: false },
);

export type ResponseFrame = Static<typeof ResponseFrameSchema>;

export const EventFrameSchema = Type.Object(
  {
    type: Type.Literal("event"),
    event: NonEmptyString,
    payload: Type.Optional(Type.Unknown()),
    seq: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export type EventFrame = Static<typeof EventFrameSchema>;

export const GatewayFrameSchema = Type.Union(
  [RequestFrameSchema, ResponseFrameSchema, EventFrameSchema],
  {
    discriminator: "type",
  },
);

export type GatewayFrame = Static<typeof GatewayFrameSchema>;

export const HealthParamsSchema = Type.Object({}, { additionalProperties: false });
export type HealthParams = Static<typeof HealthParamsSchema>;

export const StatusDeepParamsSchema = Type.Object({}, { additionalProperties: false });
export type StatusDeepParams = Static<typeof StatusDeepParamsSchema>;

export const SessionsOpenParamsSchema = Type.Object(
  {
    sessionId: Type.Optional(NonEmptyString),
    cwd: Type.Optional(NonEmptyString),
    configPath: Type.Optional(NonEmptyString),
    model: Type.Optional(NonEmptyString),
    enableExtensions: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type SessionsOpenParams = Static<typeof SessionsOpenParamsSchema>;

export const SessionsSendParamsSchema = Type.Object(
  {
    sessionId: NonEmptyString,
    prompt: NonEmptyString,
    turnId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);
export type SessionsSendParams = Static<typeof SessionsSendParamsSchema>;

export const SessionsSubscribeParamsSchema = Type.Object(
  {
    sessionId: NonEmptyString,
  },
  { additionalProperties: false },
);
export type SessionsSubscribeParams = Static<typeof SessionsSubscribeParamsSchema>;

export const SessionsUnsubscribeParamsSchema = Type.Object(
  {
    sessionId: NonEmptyString,
  },
  { additionalProperties: false },
);
export type SessionsUnsubscribeParams = Static<typeof SessionsUnsubscribeParamsSchema>;

export const SessionsAbortParamsSchema = Type.Object(
  {
    sessionId: NonEmptyString,
  },
  { additionalProperties: false },
);
export type SessionsAbortParams = Static<typeof SessionsAbortParamsSchema>;

export const SessionsCloseParamsSchema = Type.Object(
  {
    sessionId: NonEmptyString,
  },
  { additionalProperties: false },
);
export type SessionsCloseParams = Static<typeof SessionsCloseParamsSchema>;

export const HeartbeatReloadParamsSchema = Type.Object({}, { additionalProperties: false });
export type HeartbeatReloadParams = Static<typeof HeartbeatReloadParamsSchema>;

export const GatewayStopParamsSchema = Type.Object(
  {
    reason: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);
export type GatewayStopParams = Static<typeof GatewayStopParamsSchema>;

export const GatewayRotateTokenParamsSchema = Type.Object({}, { additionalProperties: false });
export type GatewayRotateTokenParams = Static<typeof GatewayRotateTokenParamsSchema>;

export type GatewayParamsByMethod = {
  connect: ConnectParams;
  health: HealthParams;
  "status.deep": StatusDeepParams;
  "sessions.open": SessionsOpenParams;
  "sessions.subscribe": SessionsSubscribeParams;
  "sessions.unsubscribe": SessionsUnsubscribeParams;
  "sessions.send": SessionsSendParams;
  "sessions.abort": SessionsAbortParams;
  "sessions.close": SessionsCloseParams;
  "heartbeat.reload": HeartbeatReloadParams;
  "gateway.rotate-token": GatewayRotateTokenParams;
  "gateway.stop": GatewayStopParams;
};

export function gatewayError(
  code: GatewayErrorCode,
  message: string,
  options: { retryable?: boolean; details?: unknown } = {},
): GatewayErrorShape {
  return {
    code,
    message,
    retryable: options.retryable,
    details: options.details,
  };
}
