const BUILTIN_CHANNEL_ALIASES: Record<string, string> = {
  tg: "telegram",
};

export function normalizeChannelId(raw: string): string {
  const normalized = raw.trim().toLowerCase();
  if (!normalized) {
    return "";
  }
  return BUILTIN_CHANNEL_ALIASES[normalized] ?? normalized;
}
