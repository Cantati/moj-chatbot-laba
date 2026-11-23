const sentencePattern = /[^.!?]+[.!?]+(?:[”\"'](?=\s|$))?/g;

export function withDashboardSummaryReasoning<TOptions extends Record<string, unknown>>(options: TOptions) {
  return {
    ...options,
    providerOptions: {
      openrouter: {
        reasoning: { effort: "low" as const },
      },
    },
  };
}

export function isCompleteTravelSummary(value: string) {
  const summary = value.trim();
  if (!summary) return false;

  const sentences = summary.match(sentencePattern);
  if (!sentences || sentences.length < 2 || sentences.length > 3) return false;

  const normalizedSummary = summary.replace(/\s+/g, " ");
  const normalizedSentences = sentences.join(" ").replace(/\s+/g, " ").trim();
  return normalizedSentences === normalizedSummary;
}
