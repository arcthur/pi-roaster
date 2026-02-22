import { randomBytes } from "node:crypto";
import { FileGatewayStateStore, type GatewayStateStore } from "./state-store.js";

const defaultStateStore = new FileGatewayStateStore();

export function readGatewayToken(
  tokenFilePath: string,
  stateStore: Pick<GatewayStateStore, "readToken"> = defaultStateStore,
): string | undefined {
  return stateStore.readToken(tokenFilePath);
}

export function loadOrCreateGatewayToken(
  tokenFilePath: string,
  stateStore: Pick<GatewayStateStore, "readToken" | "writeToken"> = defaultStateStore,
): string {
  const existing = readGatewayToken(tokenFilePath, stateStore);
  if (existing) {
    return existing;
  }

  const token = randomBytes(24).toString("hex");
  stateStore.writeToken(tokenFilePath, token);
  return token;
}

export function rotateGatewayToken(
  tokenFilePath: string,
  stateStore: Pick<GatewayStateStore, "writeToken"> = defaultStateStore,
): string {
  const token = randomBytes(24).toString("hex");
  stateStore.writeToken(tokenFilePath, token);
  return token;
}
