export function estimateTokens(text: string): number {
  if (!text.trim()) return 0;
  const words = text.trim().split(/\s+/).length;
  return Math.max(1, Math.ceil(words * 1.33));
}

export function truncateToTokenBudget(text: string, tokenBudget: number): string {
  const words = text.trim().split(/\s+/);
  const approxWords = Math.max(1, Math.floor(tokenBudget / 1.33));
  if (words.length <= approxWords) return text;
  return `${words.slice(0, approxWords).join(" ")}...`;
}
