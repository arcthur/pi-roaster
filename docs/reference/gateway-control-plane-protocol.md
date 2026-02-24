# Reference: Gateway Control Plane Protocol

Implementation entry point: `packages/brewva-gateway/src/protocol/schema.ts`.

## Transport and Addressing

- Transport: WebSocket.
- Address shape: `ws://<loopback-host>:<port>`.
- Security rule: server accepts loopback hosts only (see `packages/brewva-gateway/src/network.ts`).

## Frame Model

The protocol uses three frame types:

- `req`: request frame (`id`, `method`, `params`, optional `traceId`).
- `res`: response frame (`id`, `ok`, `payload`/`error`, optional `traceId`).
- `event`: event frame (`event`, optional `payload`, optional `seq`).

Error payload structure:

- `code`: for example `invalid_request`, `unauthorized`, `bad_state`.
- `message`: human-readable error message.
- `retryable`: optional retry hint.
- `details`: optional machine-readable metadata.

## Handshake Flow

1. Client opens WebSocket connection.
2. Server emits `connect.challenge` with `nonce`.
3. Client sends `connect`:
   - `protocol` must exactly match server protocol version.
   - `challengeNonce` must match the nonce from step 2.
   - `auth.token` must match the current gateway token.
4. On success, server returns `hello-ok` with methods, events, and policy limits (for example `maxPayloadBytes`).

Client implementation: `packages/brewva-gateway/src/client.ts`.  
Server implementation: `packages/brewva-gateway/src/daemon/gateway-daemon.ts`.

## Methods (`GatewayMethods`)

- `connect`
- `health`
- `status.deep`
- `sessions.open`
- `sessions.subscribe`
- `sessions.unsubscribe`
- `sessions.send`
- `sessions.abort`
- `sessions.close`
- `heartbeat.reload`
- `gateway.rotate-token`
- `gateway.stop`

Parameter summary (current semantics):

- `connect`: `{ protocol, client, auth: { token }, challengeNonce }`
- `health`: `{}`
- `status.deep`: `{}`
- `sessions.open`: `{ sessionId?, cwd?, configPath?, model?, agentId?, enableExtensions? }`
- `sessions.subscribe`: `{ sessionId }`
- `sessions.unsubscribe`: `{ sessionId }`
- `sessions.send`: `{ sessionId, prompt, turnId? }`
- `sessions.abort`: `{ sessionId }`
- `sessions.close`: `{ sessionId }`
- `heartbeat.reload`: `{}`
- `gateway.rotate-token`: `{}`
- `gateway.stop`: `{ reason? }`

## Response Semantics (Key Methods)

- `connect`: `hello-ok` payload with `protocol`, `server`, `features`, and `policy`.
- `sessions.send`: immediate ack payload `{ sessionId, agentSessionId?, turnId, accepted: true }`; final output arrives via `session.turn.*` events.
- `gateway.rotate-token`: `{ rotated: true, rotatedAt, revokedConnections }`.
- `gateway.stop`: `{ stopping: true, reason }`.

## Events (`GatewayEvents`)

- `connect.challenge`
- `tick`
- `session.turn.start`
- `session.turn.chunk`
- `session.turn.error`
- `session.turn.end`
- `heartbeat.fired`
- `shutdown`

Session-scoped events (`session.turn.*`) are routed by subscription scope, not broadcast to every authenticated connection.

## Latest-Only Compatibility Policy

The current protocol intentionally does not keep legacy compatibility branches:

- `connect` does not accept protocol ranges; single-value `protocol` only.
- `sessions.send` is stream-first only; response is acknowledgment (`accepted`, `turnId`), with output streamed through `session.turn.*` events.
- `gateway.rotate-token` does not accept `graceMs`; rotation takes effect immediately.

## CLI JSON Output Contracts (Automation)

`brewva gateway` subcommands emit stable `schema` fields:

- `brewva.gateway.lifecycle.v1`
- `brewva.gateway.status.v1`
- `brewva.gateway.stop.v1`
- `brewva.gateway.heartbeat-reload.v1`
- `brewva.gateway.rotate-token.v1`
- `brewva.gateway.logs.v1`
- `brewva.gateway.install.v1`
- `brewva.gateway.uninstall.v1`

Optional HTTP probe endpoint (`--health-http-port`, default path `/healthz`) responds with:

- `brewva.gateway.health-http.v1`

Implementation: `packages/brewva-gateway/src/cli.ts`.
