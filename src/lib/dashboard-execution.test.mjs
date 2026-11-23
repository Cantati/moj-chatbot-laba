import assert from "node:assert/strict";
import test from "node:test";
import { runDashboardTool } from "./dashboard-execution.ts";

test("records receipt time only for a successful tool result", async () => {
  const startedAt = Date.now();
  const success = await runDashboardTool({ execute: async () => ({ value: "dane", fetchedAt: "old-start-time" }) }, {}, "success");
  assert.equal(success.value, "dane");
  assert.ok(Date.parse(success.fetchedAt) >= startedAt);

  const failure = await runDashboardTool({ execute: async () => ({ error: "Brak danych", fetchedAt: "old-start-time" }) }, {}, "failure");
  assert.equal(failure.error, "Brak danych");
  assert.equal(failure.fetchedAt, undefined);

  const exception = await runDashboardTool({ execute: async () => { throw new Error("provider detail"); } }, {}, "exception", "Nie udało się pobrać kursu z NBP.");
  assert.deepEqual(exception, { error: "Nie udało się pobrać kursu z NBP." });
});
