import { describe, expect, test } from "bun:test";
import { resolveTelegramWebhookIngressConfig } from "@brewva/brewva-gateway";

describe("channel mode webhook ingress config", () => {
  test("returns null when webhook mode is not configured", () => {
    const resolved = resolveTelegramWebhookIngressConfig(undefined, {});
    expect(resolved).toBeNull();
  });

  test("enables webhook ingress from env with hmac auth", () => {
    const env: NodeJS.ProcessEnv = {
      BREWVA_TELEGRAM_INGRESS_PORT: "9100",
      BREWVA_TELEGRAM_INGRESS_HMAC_SECRET: "hmac-secret",
      BREWVA_TELEGRAM_INGRESS_HMAC_MAX_SKEW_MS: "30000",
      BREWVA_TELEGRAM_INGRESS_NONCE_TTL_MS: "45000",
    };

    const resolved = resolveTelegramWebhookIngressConfig(undefined, env);
    expect(resolved).not.toBeNull();
    expect(resolved).toEqual({
      host: "0.0.0.0",
      port: 9100,
      path: "/ingest/telegram",
      auth: {
        mode: "hmac",
        hmac: {
          secret: "hmac-secret",
          maxSkewMs: 30000,
          nonceTtlMs: 45000,
        },
      },
    });
  });

  test("prefers explicit channel config over environment defaults", () => {
    const channelConfig = {
      webhook: {
        enabled: true,
        host: "127.0.0.1",
        port: 9200,
        path: "/webhook/telegram",
        authMode: "bearer" as const,
        bearerToken: "config-token",
      },
    };
    const env: NodeJS.ProcessEnv = {
      BREWVA_TELEGRAM_INGRESS_PORT: "9300",
      BREWVA_TELEGRAM_INGRESS_BEARER_TOKEN: "env-token",
    };

    const resolved = resolveTelegramWebhookIngressConfig(channelConfig, env);
    expect(resolved).toEqual({
      host: "127.0.0.1",
      port: 9200,
      path: "/webhook/telegram",
      auth: {
        mode: "bearer",
        bearer: {
          token: "config-token",
        },
      },
    });
  });

  test("throws when webhook is enabled without auth material", () => {
    const channelConfig = {
      webhook: {
        enabled: true,
        port: 9101,
      },
    };

    expect(() => resolveTelegramWebhookIngressConfig(channelConfig, {})).toThrow(
      "telegram webhook auth is not configured",
    );
  });
});
