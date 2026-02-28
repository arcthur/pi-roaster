export interface ExternalRecallHit {
  topic: string;
  excerpt: string;
  score?: number;
  confidence?: number;
  metadata?: Record<string, unknown>;
}

export interface ExternalRecallPort {
  search(input: { sessionId: string; query: string; limit: number }): Promise<ExternalRecallHit[]>;
}
