import type { TurnEnvelope } from "@brewva/brewva-runtime/channels";

type SenderIdentity = {
  senderId?: string;
  senderUsername?: string;
};

function extractSenderIdentity(turn: TurnEnvelope): SenderIdentity {
  const meta = turn.meta;
  if (!meta || typeof meta !== "object") {
    return {};
  }
  const senderIdRaw = (meta as { senderId?: unknown }).senderId;
  const senderUsernameRaw = (meta as { senderUsername?: unknown }).senderUsername;
  const senderId =
    typeof senderIdRaw === "string"
      ? senderIdRaw.trim()
      : typeof senderIdRaw === "number"
        ? String(senderIdRaw)
        : undefined;
  const senderUsername =
    typeof senderUsernameRaw === "string" ? senderUsernameRaw.trim().replace(/^@/, "") : undefined;
  return {
    senderId: senderId && senderId.length > 0 ? senderId : undefined,
    senderUsername: senderUsername && senderUsername.length > 0 ? senderUsername : undefined,
  };
}

export function isOwnerAuthorized(
  turn: TurnEnvelope,
  owners: string[],
  modeWhenOwnersEmpty: "open" | "closed",
): boolean {
  if (owners.length === 0) {
    return modeWhenOwnersEmpty === "open";
  }

  const sender = extractSenderIdentity(turn);
  const senderId = sender.senderId;
  const senderUsername = sender.senderUsername?.toLowerCase();

  if (!senderId && !senderUsername) {
    return false;
  }

  for (const rawOwner of owners) {
    const owner = rawOwner.trim();
    if (!owner) continue;
    if (owner.startsWith("@")) {
      if (senderUsername && `@${senderUsername}` === owner.toLowerCase()) {
        return true;
      }
      continue;
    }
    if (senderId && owner === senderId) {
      return true;
    }
    if (senderUsername && owner.toLowerCase() === senderUsername) {
      return true;
    }
  }

  return false;
}
