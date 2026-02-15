export const DEFAULT_CHARS_PER_TOKEN = 3.5;

export function estimateTokenCount(text: string, charsPerToken = DEFAULT_CHARS_PER_TOKEN): number {
  return Math.max(0, Math.ceil(text.length / charsPerToken));
}

export function truncateTextToTokenBudget(
  text: string,
  tokenBudget: number,
  charsPerToken = DEFAULT_CHARS_PER_TOKEN,
): string {
  const maxChars = Math.floor(Math.max(0, tokenBudget) * charsPerToken);
  if (text.length <= maxChars) return text;
  if (maxChars <= 3) {
    return text.slice(0, maxChars);
  }
  return `${text.slice(0, maxChars - 3)}...`;
}
