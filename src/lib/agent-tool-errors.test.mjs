import assert from "node:assert/strict";
import test from "node:test";
import { getToolOutputErrorMessage } from "./agent-tool-errors.ts";

test("shows a Polish image-generation error without provider details", () => {
  assert.equal(
    getToolOutputErrorMessage("generateImage"),
    "Nie udało się wygenerować obrazu. Spróbuj ponownie.",
  );
});

test("shows a generic Polish error for other tools", () => {
  assert.equal(getToolOutputErrorMessage("web_search"), "Nie udało się wykonać narzędzia. Spróbuj ponownie.");
});
