import assert from "node:assert/strict";
import test from "node:test";
import { generateText, isStepCount } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import {
  pobierzPrzygotowanieDoUslugi,
  przygotowanieDoUslugiTool,
} from "./studio-nova-przygotowanie.ts";

test("returns only general, explicitly non-official consultation preparation tips", () => {
  assert.deepEqual(pobierzPrzygotowanieDoUslugi(), {
    charakter: "Ogólne wskazówki; nie są oficjalnymi wymaganiami ani procedurami Studio Nova.",
    wskazowki: [
      "Sprawdź połączenie internetowe.",
      "Sprawdź mikrofon i kamerę.",
      "Przygotuj pytania do konsultacji.",
      "Przygotuj spokojne miejsce do rozmowy.",
    ],
  });
});

test("executes the preparation tool offline with an empty argument object", async () => {
  const model = new MockLanguageModelV3({
    doGenerate: {
      content: [
        {
          type: "tool-call",
          toolCallId: "preparation-call-1",
          toolName: "przygotowanieDoUslugi",
          input: "{}",
        },
      ],
      finishReason: { unified: "tool-calls", raw: "tool_calls" },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
    },
  });

  const result = await generateText({
    model,
    prompt: "Jak przygotować się do konsultacji online?",
    tools: { przygotowanieDoUslugi: przygotowanieDoUslugiTool },
    stopWhen: isStepCount(1),
  });

  assert.deepEqual(result.steps[0].toolResults[0]?.output, pobierzPrzygotowanieDoUslugi());
});
