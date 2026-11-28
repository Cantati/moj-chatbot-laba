import assert from "node:assert/strict";
import test from "node:test";
import { createKnowledgeSearchService, KNOWLEDGE_SEARCH_INSTRUCTIONS } from "./knowledge-search.ts";

const vector = Array(1536).fill(0.125);
const sample = [
  { title: "FAQ", content: "Firma działa w Polsce.", similarity: 0.91 },
  { title: "Cennik 2026", content: "Pakiet podstawowy kosztuje 100 zł.", similarity: 0.84 },
  { title: "FAQ", content: "Kontakt e-mail.", similarity: 0.77 },
  { title: "Nadmiar", content: "Nie powinien wrócić.", similarity: 0.2 },
];

test("poprawne wyszukiwanie używa embeddingu pytania i zwraca najwyżej trzy fragmenty", async () => {
  let receivedArgs;
  let embeddedQuestion;
  const service = createKnowledgeSearchService({
    rpc: async (name, args) => {
      assert.equal(name, "match_chunks");
      receivedArgs = args;
      return { data: sample, error: null };
    },
  }, async (question) => { embeddedQuestion = question; return vector; });

  const result = await service("  Jaka jest oferta?  ");
  assert.equal(embeddedQuestion, "Jaka jest oferta?");
  assert.deepEqual(Object.keys(receivedArgs).sort(), ["match_count", "query_embedding"]);
  assert.equal(receivedArgs.match_count, 3);
  assert.deepEqual(receivedArgs.query_embedding, vector);
  assert.deepEqual(result.matches, sample.slice(0, 3));
});

test("wynik zawiera czytelną linię źródła z tytułem dokumentu", async () => {
  const service = createKnowledgeSearchService({ rpc: async () => ({ data: sample, error: null }) }, async () => vector);
  const result = await service("cena?");
  assert.deepEqual(result.sources, ["Źródło: FAQ", "Źródło: Cennik 2026"]);
  assert.match(KNOWLEDGE_SEARCH_INSTRUCTIONS, /Źródło: \[tytuł dokumentu\]/);
});

test("brak trafień podaje wymagany komunikat i sugestię dodania informacji", async () => {
  const service = createKnowledgeSearchService({ rpc: async () => ({ data: [], error: null }) }, async () => vector);
  const result = await service("nieznana informacja?");
  assert.equal(result.noAnswer, "Nie mam tej informacji w bazie wiedzy. Możesz dodać odpowiedni dokument lub fragment do bazy wiedzy.");
  assert.deepEqual(result.matches, []);
  assert.match(KNOWLEDGE_SEARCH_INSTRUCTIONS, /Nie mam tej informacji w bazie wiedzy/);
});

test("błąd embeddingu lub wyszukiwania zwraca bezpieczny komunikat po polsku", async () => {
  const failingSearch = createKnowledgeSearchService({ rpc: async () => ({ data: null, error: new Error("private database detail") }) }, async () => vector);
  const failingEmbedding = createKnowledgeSearchService({ rpc: async () => ({ data: [], error: null }) }, async () => { throw new Error("private provider detail"); });
  for (const service of [failingSearch, failingEmbedding]) {
    const result = await service("pytanie");
    assert.equal(result.error, "Nie udało się przeszukać bazy wiedzy. Spróbuj ponownie.");
    assert.equal(JSON.stringify(result).includes("private"), false);
  }
});

test("raport diagnostyczny oznacza etap i sukces, nie przekazuje treści błędu", async () => {
  const events = [];
  const service = createKnowledgeSearchService({
    rpc: async () => ({ data: null, error: { code: "PGRST202", message: "secret question and document text" } }),
  }, async () => vector, (event) => events.push(event));

  const result = await service("pytanie prywatne");
  assert.equal(result.error, "Nie udało się przeszukać bazy wiedzy. Spróbuj ponownie.");
  assert.deepEqual(events.map(({ stage, success }) => [stage, success]), [
    ["embedding", true],
    ["RPC", false],
  ]);
  assert.equal(events[1].code, "PGRST202");
  assert.equal(JSON.stringify(events).includes("secret"), false);
  assert.equal(JSON.stringify(events).includes("pytanie"), false);
});

test("błędny format wiersza RPC jest raportowany jako błąd przetwarzania", async () => {
  const events = [];
  const service = createKnowledgeSearchService({ rpc: async () => ({ data: [{ title: "FAQ", content: "tekst", similarity: "0.8" }], error: null }) }, async () => vector, (event) => events.push(event));
  const result = await service("pytanie");
  assert.equal(result.error, "Nie udało się przeszukać bazy wiedzy. Spróbuj ponownie.");
  assert.deepEqual(events.map(({ stage, success }) => [stage, success]), [
    ["embedding", true],
    ["RPC", true],
    ["przetwarzanie_wynikow", false],
  ]);
  assert.equal(events.at(-1).code, "INVALID_RESULT_ROW");
});
