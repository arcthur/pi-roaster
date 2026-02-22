export function resolveRequestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (typeof error === "number" || typeof error === "boolean" || typeof error === "bigint") {
    return error.toString();
  }
  if (typeof error === "symbol") {
    return error.description ?? "unknown symbol error";
  }
  if (error === null || error === undefined) {
    return "unknown error";
  }
  try {
    const serialized = JSON.stringify(error);
    return serialized ?? "unknown error";
  } catch {
    return "unknown error";
  }
}

export async function assertRejectsWithMessage(
  run: () => Promise<unknown>,
  messagePart: string,
): Promise<void> {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  if (!caught) {
    throw new Error(`expected rejection containing: ${messagePart}`);
  }

  const message = toErrorMessage(caught);
  if (!message.includes(messagePart)) {
    throw new Error(`expected rejection containing: ${messagePart}; received: ${message}`);
  }
}
