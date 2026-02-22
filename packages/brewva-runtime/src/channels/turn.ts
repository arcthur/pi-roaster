export type TurnKind = "user" | "assistant" | "tool" | "approval";

export type TurnPart =
  | { type: "text"; text: string }
  | { type: "image"; uri: string; mimeType?: string }
  | { type: "file"; uri: string; name?: string; mimeType?: string };

export interface ApprovalAction {
  id: string;
  label: string;
  style?: "primary" | "neutral" | "danger";
}

export interface ApprovalPayload {
  requestId: string;
  title: string;
  detail?: string;
  actions: ApprovalAction[];
}

export interface TurnEnvelope {
  schema: "brewva.turn.v1";
  kind: TurnKind;
  sessionId: string;
  turnId: string;
  channel: string;
  conversationId: string;
  messageId?: string;
  threadId?: string;
  timestamp: number;
  parts: TurnPart[];
  approval?: ApprovalPayload;
  meta?: Record<string, unknown>;
}
