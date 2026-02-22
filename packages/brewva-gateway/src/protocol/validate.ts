import { Ajv, type ErrorObject } from "ajv";
import {
  ConnectParamsSchema,
  type GatewayMethod,
  GatewayStopParamsSchema,
  GatewayRotateTokenParamsSchema,
  GatewayFrameSchema,
  HeartbeatReloadParamsSchema,
  HealthParamsSchema,
  RequestFrameSchema,
  ResponseFrameSchema,
  EventFrameSchema,
  SessionsAbortParamsSchema,
  SessionsCloseParamsSchema,
  SessionsOpenParamsSchema,
  SessionsSubscribeParamsSchema,
  SessionsSendParamsSchema,
  SessionsUnsubscribeParamsSchema,
  StatusDeepParamsSchema,
  type GatewayParamsByMethod,
} from "./schema.js";

const ajv = new Ajv({
  allErrors: true,
  strict: false,
  removeAdditional: false,
});

export const validateRequestFrame = ajv.compile(RequestFrameSchema);
export const validateResponseFrame = ajv.compile(ResponseFrameSchema);
export const validateEventFrame = ajv.compile(EventFrameSchema);
export const validateGatewayFrame = ajv.compile(GatewayFrameSchema);

export const validateConnectParams = ajv.compile(ConnectParamsSchema);
export const validateHealthParams = ajv.compile(HealthParamsSchema);
export const validateStatusDeepParams = ajv.compile(StatusDeepParamsSchema);
export const validateSessionsOpenParams = ajv.compile(SessionsOpenParamsSchema);
export const validateSessionsSubscribeParams = ajv.compile(SessionsSubscribeParamsSchema);
export const validateSessionsUnsubscribeParams = ajv.compile(SessionsUnsubscribeParamsSchema);
export const validateSessionsSendParams = ajv.compile(SessionsSendParamsSchema);
export const validateSessionsAbortParams = ajv.compile(SessionsAbortParamsSchema);
export const validateSessionsCloseParams = ajv.compile(SessionsCloseParamsSchema);
export const validateHeartbeatReloadParams = ajv.compile(HeartbeatReloadParamsSchema);
export const validateGatewayStopParams = ajv.compile(GatewayStopParamsSchema);
export const validateGatewayRotateTokenParams = ajv.compile(GatewayRotateTokenParamsSchema);

const methodValidators: {
  [K in GatewayMethod]: {
    validate: (value: unknown) => boolean;
    errors: () => ErrorObject[] | null | undefined;
  };
} = {
  connect: {
    validate: validateConnectParams,
    errors: () => validateConnectParams.errors,
  },
  health: {
    validate: validateHealthParams,
    errors: () => validateHealthParams.errors,
  },
  "status.deep": {
    validate: validateStatusDeepParams,
    errors: () => validateStatusDeepParams.errors,
  },
  "sessions.open": {
    validate: validateSessionsOpenParams,
    errors: () => validateSessionsOpenParams.errors,
  },
  "sessions.subscribe": {
    validate: validateSessionsSubscribeParams,
    errors: () => validateSessionsSubscribeParams.errors,
  },
  "sessions.unsubscribe": {
    validate: validateSessionsUnsubscribeParams,
    errors: () => validateSessionsUnsubscribeParams.errors,
  },
  "sessions.send": {
    validate: validateSessionsSendParams,
    errors: () => validateSessionsSendParams.errors,
  },
  "sessions.abort": {
    validate: validateSessionsAbortParams,
    errors: () => validateSessionsAbortParams.errors,
  },
  "sessions.close": {
    validate: validateSessionsCloseParams,
    errors: () => validateSessionsCloseParams.errors,
  },
  "heartbeat.reload": {
    validate: validateHeartbeatReloadParams,
    errors: () => validateHeartbeatReloadParams.errors,
  },
  "gateway.rotate-token": {
    validate: validateGatewayRotateTokenParams,
    errors: () => validateGatewayRotateTokenParams.errors,
  },
  "gateway.stop": {
    validate: validateGatewayStopParams,
    errors: () => validateGatewayStopParams.errors,
  },
};

export function validateParamsForMethod<K extends GatewayMethod>(
  method: K,
  params: unknown,
): { ok: true; params: GatewayParamsByMethod[K] } | { ok: false; error: string } {
  const validator = methodValidators[method];
  if (validator.validate(params)) {
    return {
      ok: true,
      params: params as GatewayParamsByMethod[K],
    };
  }
  return {
    ok: false,
    error: formatValidationErrors(validator.errors()),
  };
}

export function formatValidationErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) {
    return "unknown validation error";
  }

  const messages: string[] = [];
  for (const error of errors) {
    const path =
      typeof error.instancePath === "string" && error.instancePath
        ? `at ${error.instancePath}`
        : "at root";
    const message = typeof error.message === "string" ? error.message : "validation error";
    if (error.keyword === "additionalProperties") {
      const params = error.params as { additionalProperty?: unknown } | undefined;
      const prop =
        typeof params?.additionalProperty === "string" ? params.additionalProperty : null;
      if (prop) {
        messages.push(`${path}: unexpected property '${prop}'`);
        continue;
      }
    }
    messages.push(`${path}: ${message}`);
  }
  return Array.from(new Set(messages)).join("; ");
}
