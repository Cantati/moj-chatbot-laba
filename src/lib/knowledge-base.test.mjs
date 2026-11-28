import test from "node:test";
import assert from "node:assert/strict";
import { createKnowledgeRepository, splitKnowledgeTextIntoChunks } from "./knowledge-base.ts";
import { normalizeInt8Id } from "./supabase.ts";

function makeKnowledgeDatabase({
  documentId = 2,
  existingDocuments = [],
  existingChunks = [],
  failChunkInsert = false,
  failBackfillUpdate = false,
} = {}) {
  const tables = {
    documents: structuredClone(existingDocuments),
    chunks: structuredClone(existingChunks),
  };

  function execute(table, query) {
    if (query.operation === "insert") {
      if (table === "chunks" && failChunkInsert === "throw") throw new Error("network failed");
      if (table === "chunks" && failChunkInsert) return { data: null, error: new Error("insert failed") };
      const rows = (Array.isArray(query.values) ? query.values : [query.values]).map((row) => ({ ...row }));
      if (table === "documents") rows[0].id = documentId;
      tables[table].push(...rows);
      return { data: query.single ? rows[0] : null, error: null };
    }

    const matches = (row) =>
      Object.entries(query.filters).every(([key, value]) => String(row[key]) === String(value)) &&
      Object.entries(query.isFilters ?? {}).every(([key, value]) => row[key] === value);

    if (query.operation === "select") {
      let rows = tables[table].filter(matches);
      if (query.orderColumn) {
        rows = [...rows].sort((left, right) => String(left[query.orderColumn]).localeCompare(String(right[query.orderColumn])));
      }
      if (query.range) rows = rows.slice(query.range[0], query.range[1] + 1);
      return { data: rows, error: null };
    }

    if (query.operation === "update") {
      if (table === "chunks" && failBackfillUpdate) return { data: null, error: new Error("update failed") };
      for (const row of tables[table].filter(matches)) Object.assign(row, query.values);
      return { data: null, error: null };
    }

    if (query.operation === "delete") {
      tables[table] = tables[table].filter((row) => !matches(row));
      return { data: null, error: null };
    }

    throw new Error("Unexpected database operation");
  }

  return {
    tables,
    from(table) {
      const query = { operation: "select", filters: {} };
      const builder = {
        insert(values) { query.operation = "insert"; query.values = values; return this; },
        update(values) { query.operation = "update"; query.values = values; return this; },
        delete() { query.operation = "delete"; return this; },
        select() { return this; },
        eq(column, value) { query.filters[column] = value; return this; },
        is(column, value) { query.isFilters ??= {}; query.isFilters[column] = value; return this; },
        order(column) { query.orderColumn = column; return this; },
        range(from, to) { query.range = [from, to]; return this; },
        single() { query.single = true; return Promise.resolve(execute(table, query)); },
        then(resolve, reject) { return Promise.resolve(execute(table, query)).then(resolve, reject); },
      };
      return builder;
    },
  };
}

function makeEmbeddingGenerator({ fail = false, dimensions = 1536 } = {}) {
  const calls = [];
  const generate = async (values) => {
    calls.push([...values]);
    if (fail) throw new Error("Embedding request failed");
    return values.map((_, index) => Array(dimensions).fill(index + 1));
  };
  return { calls, generate };
}

function repository(database, generateEmbeddings) {
  return createKnowledgeRepository(database, normalizeInt8Id, generateEmbeddings);
}

function cennikData() {
  return {
    documents: [{ id: 1, title: "Cennik 2026" }],
    chunks: Array.from({ length: 5 }, (_, index) => ({
      id: 101 + index,
      document_id: 1,
      chunk_index: index,
      content: `Akapit cennika ${index}`,
      embedding: null,
    })),
  };
}

test("keeps paragraphs separate and splits long paragraphs only between sentences", () => {
  assert.deepEqual(splitKnowledgeTextIntoChunks("krótki akapit\n\n drugi akapit \n\n\n trzeci"), [
    "krótki akapit", "drugi akapit", "trzeci",
  ]);
  const firstSentence = `${"A".repeat(390)}.`;
  const secondSentence = `${"B".repeat(410)}.`;
  assert.deepEqual(splitKnowledgeTextIntoChunks(`${firstSentence} ${secondSentence}`), [firstSentence, secondSentence]);
});

test("embeds new and existing NULL chunks in one call, saves vectors, and keeps prior documents", async () => {
  const existing = cennikData();
  const database = makeKnowledgeDatabase({ existingDocuments: existing.documents, existingChunks: existing.chunks, documentId: 2 });
  const embedder = makeEmbeddingGenerator();
  const saved = await repository(database, embedder.generate).saveDocument("Nowy dokument", "Nowy akapit 1.\n\nNowy akapit 2.");

  assert.deepEqual(saved, { id: "2", chunkCount: 2 });
  assert.equal(embedder.calls.length, 1);
  assert.deepEqual(embedder.calls[0], [
    "Nowy akapit 1.", "Nowy akapit 2.",
    ...existing.chunks.map((chunk) => chunk.content),
  ]);
  assert.deepEqual(database.tables.documents, [
    { id: 1, title: "Cennik 2026" },
    { title: "Nowy dokument", id: 2 },
  ]);
  assert.deepEqual(database.tables.chunks.slice(-2).map(({ document_id, chunk_index, content }) => ({ document_id, chunk_index, content })), [
    { document_id: "2", chunk_index: 0, content: "Nowy akapit 1." },
    { document_id: "2", chunk_index: 1, content: "Nowy akapit 2." },
  ]);
  assert.equal(database.tables.chunks.every((chunk) => Array.isArray(chunk.embedding) && chunk.embedding.length === 1536), true);
  assert.equal(database.tables.chunks.slice(-2)[0].embedding[0], 1);
  assert.equal(database.tables.chunks[0].embedding[0], 3);
});

test("preserves exact bigint IDs for new rows and NULL-chunk updates", async () => {
  const largeId = "9007199254740993";
  const database = makeKnowledgeDatabase({
    documentId: largeId,
    existingChunks: [{ id: "9007199254740992", document_id: "1", chunk_index: 0, content: "Stary fragment", embedding: null }],
  });
  const embedder = makeEmbeddingGenerator();
  const saved = await repository(database, embedder.generate).saveDocument("Nowy", "Nowy fragment.");

  assert.equal(saved.id, largeId);
  assert.equal(database.tables.chunks[0].embedding[0], 2);
  assert.equal(database.tables.chunks[1].document_id, largeId);
});

test("removes only the new document if embedding generation fails", async () => {
  const existing = cennikData();
  const database = makeKnowledgeDatabase({ existingDocuments: existing.documents, existingChunks: existing.chunks, documentId: 2 });
  const embedder = makeEmbeddingGenerator({ fail: true });

  await assert.rejects(repository(database, embedder.generate).saveDocument("Nieukończony", "Treść."), /embeddingów/);
  assert.deepEqual(database.tables.documents, existing.documents);
  assert.deepEqual(database.tables.chunks, existing.chunks);
  assert.equal(embedder.calls.length, 1);
});

test("removes only the new document if chunk insertion fails", async () => {
  const existing = cennikData();
  const database = makeKnowledgeDatabase({ existingDocuments: existing.documents, existingChunks: existing.chunks, documentId: 2, failChunkInsert: true });
  const embedder = makeEmbeddingGenerator();

  await assert.rejects(repository(database, embedder.generate).saveDocument("Nieukończony", "Treść."), /embeddingów/);
  assert.deepEqual(database.tables.documents, existing.documents);
  assert.deepEqual(database.tables.chunks, existing.chunks);
});

test("rolls back the new document if backfilling fails without deleting existing documents", async () => {
  const existing = cennikData();
  const database = makeKnowledgeDatabase({ existingDocuments: existing.documents, existingChunks: existing.chunks, documentId: 2, failBackfillUpdate: true });
  const embedder = makeEmbeddingGenerator();

  await assert.rejects(repository(database, embedder.generate).saveDocument("Nieukończony", "Treść."), /embeddingów/);
  assert.deepEqual(database.tables.documents, existing.documents);
  assert.deepEqual(database.tables.chunks, existing.chunks);
});

test("rejects invalid embedding dimensions and removes the new document", async () => {
  const database = makeKnowledgeDatabase({ documentId: 2 });
  const embedder = makeEmbeddingGenerator({ dimensions: 3 });

  await assert.rejects(repository(database, embedder.generate).saveDocument("Nieukończony", "Treść."), /embeddingów/);
  assert.deepEqual(database.tables.documents, []);
  assert.deepEqual(database.tables.chunks, []);
});
