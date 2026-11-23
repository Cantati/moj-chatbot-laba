import assert from "node:assert/strict";
import test from "node:test";
import { isCompleteTravelSummary, withDashboardSummaryReasoning } from "./dashboard-summary.ts";

test("rejects one-word and unfinished travel summaries", () => {
  assert.equal(isCompleteTravelSummary("Chmurno"), false);
  assert.equal(isCompleteTravelSummary("Na pochmurny dzień"), false);
});

test("accepts a complete two-sentence travel summary", () => {
  assert.equal(isCompleteTravelSummary("Zabierz parasol na deszczowy dzień. Sprawdź prognozę przed wyjazdem."), true);
});

test("adds low reasoning only to the dashboard summary generation options", () => {
  const options = withDashboardSummaryReasoning({
    model: "offline-model",
    instructions: "Napisz krótkie podsumowanie.",
    prompt: "Dane dashboardu",
    maxOutputTokens: 400,
    abortSignal: undefined,
  });

  assert.deepEqual(options.providerOptions, {
    openrouter: { reasoning: { effort: "low" } },
  });
  assert.equal(options.model, "offline-model");
  assert.equal(options.maxOutputTokens, 400);
  assert.equal(options.instructions, "Napisz krótkie podsumowanie.");
  assert.equal(options.prompt, "Dane dashboardu");
  assert.equal(options.abortSignal, undefined);
});
