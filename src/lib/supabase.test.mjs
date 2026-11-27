import test from "node:test";
import assert from "node:assert/strict";
import { createConversationRepository, serializeMessageContent } from "./supabase.ts";
import { requireActiveSession } from "./auth.ts";
import { completeProfileInputFromLatestMessage, newConversationGreeting, profileInstructions, validateExplicitProfileFacts } from "./user-profile.ts";

function makeMemorySupabase({ numericIds = true } = {}) {
  const tables = { conversations: [], messages: [], user_profiles: [] };
  let nextId = 1;
  let nextTime = 1;

  function execute(table, query) {
    if (query.operation === "insert") {
      const rows = Array.isArray(query.values) ? query.values : [query.values];
      const inserted = rows.map((row) => ({
        ...row,
        id: numericIds ? nextId++ : `row-${nextId++}`,
        ...(numericIds && table === "messages" && typeof row.conversation_id === "string" && /^\d+$/.test(row.conversation_id)
          ? { conversation_id: Number.isSafeInteger(Number(row.conversation_id)) ? Number(row.conversation_id) : row.conversation_id }
          : {}),
        created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, nextTime++)).toISOString(),
      }));
      tables[table].push(...inserted);
      return { data: query.single ? inserted[0] : null, error: null };
    }

    let rows = [...tables[table]];
    for (const [column, value] of Object.entries(query.filters)) {
      rows = rows.filter((row) => String(row[column]) === String(value));
    }
    if (query.operation === "update") {
      for (const row of rows) Object.assign(row, query.values);
      return { data: query.single ? rows[0] ?? null : rows, error: null };
    }
    for (const [column, values] of Object.entries(query.inFilters ?? {})) {
      rows = rows.filter((row) => values.some((value) => String(row[column]) === String(value)));
    }
    if (query.orderColumn) {
      rows.sort((left, right) => {
        const comparison = String(left[query.orderColumn]).localeCompare(String(right[query.orderColumn]));
        return query.ascending ? comparison : -comparison;
      });
    }
    if (query.limit !== undefined) rows = rows.slice(0, query.limit);
    return { data: query.single ? rows[0] ?? null : rows, error: null };
  }

  return {
    tables,
    from(table) {
      const query = { operation: "select", filters: {}, ascending: true };
      const builder = {
        insert(values) { query.operation = "insert"; query.values = values; return this; },
        select() { if (query.operation !== "insert" && query.operation !== "update") query.operation = "select"; return this; },
        eq(column, value) { query.filters[column] = value; return this; },
        in(column, values) { query.inFilters ??= {}; query.inFilters[column] = values; return this; },
        update(values) { query.operation = "update"; query.values = values; return this; },
        order(column, options) { query.orderColumn = column; query.ascending = options.ascending; return this; },
        limit(value) { query.limit = value; return this; },
        single() { query.single = true; return Promise.resolve(execute(table, query)); },
        maybeSingle() { query.single = true; return Promise.resolve(execute(table, query)); },
        then(resolve, reject) { return Promise.resolve(execute(table, query)).then(resolve, reject); },
      };
      return builder;
    },
  };
}

test("offline conversation repository writes user and completed assistant messages and restores them in order", async () => {
  const database = makeMemorySupabase();
  const repository = createConversationRepository(database);
  const conversation = await repository.createConversation();

  await repository.saveMessage(conversation.id, "user", {
    parts: [{ type: "text", text: "Opisz to zdjęcie" }, { type: "file", mediaType: "image/png", url: "data:image/png;base64,SECRET_IMAGE_BYTES" }],
  });
  await repository.saveMessage(conversation.id, "assistant", {
    parts: [{ type: "text", text: "Widzę krajobraz." }],
  });

  const restored = await repository.loadLatestConversation();
  assert.equal(restored.conversation.id, conversation.id);
  assert.deepEqual(restored.messages.map((message) => message.role), ["user", "assistant"]);
  assert.equal(restored.messages[0].parts[0].text, "Opisz to zdjęcie\n[Załączono obraz]");
  assert.equal(restored.messages[1].parts[0].text, "Widzę krajobraz.");
  assert.equal(JSON.stringify(database.tables).includes("SECRET_IMAGE_BYTES"), false);
});

test("image and generated-image content is reduced to short markers without base64", () => {
  const content = serializeMessageContent({
    parts: [
      { type: "text", text: "Analizuję zdjęcie." },
      { type: "file", mediaType: "image/webp", url: "data:image/webp;base64,PRIVATE_BYTES" },
      { type: "tool-generateImage", state: "output-available", output: { image: "PRIVATE_BYTES" } },
    ],
  });

  assert.equal(content, "Analizuję zdjęcie.\n[Załączono obraz]\n[Wygenerowano obraz]");
  assert.equal(content.includes("PRIVATE_BYTES"), false);
});

test("loading with no stored conversations returns an empty result", async () => {
  const repository = createConversationRepository(makeMemorySupabase());
  assert.deepEqual(await repository.loadLatestConversation(), { conversation: null, messages: [] });
});

test("conversation creation normalizes an automatically generated numeric int8 id", async () => {
  const repository = createConversationRepository(makeMemorySupabase({ numericIds: true }));
  assert.deepEqual(await repository.createConversation(), { id: "1" });
});

test("latest conversation and message rows with numeric int8 ids are restored as text ids", async () => {
  const database = makeMemorySupabase({ numericIds: true });
  database.tables.conversations.push({ id: 23, title: "Rozmowa", created_at: "2026-01-01T00:00:02.000Z" });
  database.tables.messages.push({
    id: 51,
    conversation_id: 23,
    role: "assistant",
    content: "Odpowiedź",
    created_at: "2026-01-01T00:00:03.000Z",
  });

  const restored = await createConversationRepository(database).loadLatestConversation();
  assert.deepEqual(restored.conversation, { id: "23" });
  assert.equal(restored.messages[0].id, "51");
  assert.equal(restored.messages[0].parts[0].text, "Odpowiedź");
});

test("messages linked to a numeric int8 conversation can be saved and read back", async () => {
  const database = makeMemorySupabase({ numericIds: true });
  const repository = createConversationRepository(database);
  const conversation = await repository.createConversation();
  await repository.saveMessage(conversation.id, "user", { parts: [{ type: "text", text: "Pytanie" }] });
  await repository.saveMessage(conversation.id, "assistant", { parts: [{ type: "text", text: "Odpowiedź" }] });

  const restored = await repository.loadLatestConversation();
  assert.deepEqual(restored.messages.map((message) => [message.id, message.role, message.parts[0].text]), [
    ["2", "user", "Pytanie"],
    ["3", "assistant", "Odpowiedź"],
  ]);
  assert.equal(database.tables.messages[0].conversation_id, 1);
});

test("invalid conversation identifiers are rejected before a message insert", async () => {
  const database = makeMemorySupabase({ numericIds: true });
  const repository = createConversationRepository(database);

  await assert.rejects(
    repository.saveMessage("12.5", "user", { parts: [{ type: "text", text: "Pytanie" }] }),
    /invalid int8 identifier/i,
  );
  await assert.rejects(
    repository.saveMessage("9223372036854775808", "user", { parts: [{ type: "text", text: "Pytanie" }] }),
    /invalid int8 identifier/i,
  );
  await assert.rejects(
    repository.saveMessage(9007199254740992, "user", { parts: [{ type: "text", text: "Pytanie" }] }),
    /invalid int8 identifier/i,
  );
  assert.equal(database.tables.messages.length, 0);
});

test("large int8 decimal strings remain exact instead of passing through JavaScript number", async () => {
  const database = makeMemorySupabase();
  const repository = createConversationRepository(database);
  const largeId = "9007199254740993";
  await repository.saveMessage(largeId, "user", { parts: [{ type: "text", text: "Pytanie" }] });
  assert.equal(database.tables.messages[0].conversation_id, largeId);
});

test("history is newest first, counts messages, and selects only the requested conversation in message order", async () => {
  const database = makeMemorySupabase({ numericIds: true });
  const repository = createConversationRepository(database);
  const older = await repository.createConversation();
  await repository.saveMessage(older.id, "user", { parts: [{ type: "text", text: "Starsze pytanie" }] });
  await repository.saveMessage(older.id, "assistant", { parts: [{ type: "text", text: "Starsza odpowiedź" }] });
  const newer = await repository.createConversation();
  await repository.saveMessage(newer.id, "user", { parts: [{ type: "text", text: "Nowsze pytanie" }] });
  await repository.saveMessage(newer.id, "assistant", { parts: [{ type: "text", text: "Nowsza odpowiedź" }] });

  const history = await repository.listConversations();
  assert.deepEqual(history.map(({ id, title, messageCount }) => [id, title, messageCount]), [
    [newer.id, "Nowsze pytanie", 2],
    [older.id, "Starsze pytanie", 2],
  ]);

  const selected = await repository.loadConversation(older.id);
  assert.equal(selected.conversation.id, older.id);
  assert.deepEqual(selected.messages.map((message) => message.parts[0].text), ["Starsze pytanie", "Starsza odpowiedź"]);
  assert.equal(selected.messages.length, 2);
  assert.equal(database.tables.messages.length, 4);
  assert.deepEqual(database.tables.messages.filter((message) => String(message.conversation_id) === older.id).map((message) => message.content), [
    "Starsze pytanie",
    "Starsza odpowiedź",
  ]);
  assert.deepEqual(database.tables.messages.filter((message) => String(message.conversation_id) === newer.id).map((message) => message.content), [
    "Nowsze pytanie",
    "Nowsza odpowiedź",
  ]);
});

test("the profile API session guard rejects missing sessions with HTTP 401 before database access", () => {
  const response = requireActiveSession(null);
  assert.ok(response);
  assert.equal(response.status, 401);
});

test("a new conversation greeting uses the profile name or asks how to address the user", () => {
  assert.equal(newConversationGreeting("Ada"), "Cześć, Ada! Miło Cię widzieć. W czym mogę Ci dzisiaj pomóc?");
  assert.equal(newConversationGreeting(null), "Cześć! Jak mam się do Ciebie zwracać? W czym mogę Ci pomóc?");
  assert.equal(newConversationGreeting("  "), "Cześć! Jak mam się do Ciebie zwracać? W czym mogę Ci pomóc?");
});

test("profile management updates the existing row, removes one preference, and clears profile values", async () => {
  const database = makeMemorySupabase();
  const repository = createConversationRepository(database);
  const created = await repository.saveUserProfile({
    name: "Ada",
    city: "Toruń",
    favoriteFood: "pizza",
    responseStyle: "krótko",
  });

  const renamed = await repository.updateUserProfileName("Ada Nowak");
  assert.equal(renamed.id, created.id);
  assert.equal(database.tables.user_profiles.length, 1);
  assert.equal(renamed.name, "Ada Nowak");
  assert.deepEqual(renamed.preferences, { city: "Toruń", favoriteFood: "pizza", responseStyle: "krótko" });

  const afterDelete = await repository.deleteUserProfileEntry("favoriteFood");
  assert.equal(database.tables.user_profiles.length, 1);
  assert.deepEqual(afterDelete.preferences, { city: "Toruń", responseStyle: "krótko" });

  const cleared = await repository.clearUserProfile();
  assert.equal(database.tables.user_profiles.length, 1);
  assert.equal(cleared.id, created.id);
  assert.equal(cleared.name, null);
  assert.deepEqual(cleared.preferences, {});
});

test("profile memory saves explicit facts, merges updates into one row, and is available in a new conversation", async () => {
  const database = makeMemorySupabase();
  const repository = createConversationRepository(database);
  const userMessage = "Mam na imię Ada, mieszkam w Toruniu, a moim ulubionym jedzeniem jest pizza.";
  const userMessages = [userMessage];
  const initial = validateExplicitProfileFacts({
    name: { value: "Ada", evidence: "Mam na imię Ada" },
    city: { value: "Toruniu", evidence: "mieszkam w Toruniu" },
    favoriteFood: { value: "pizza", evidence: "moim ulubionym jedzeniem jest pizza" },
  }, userMessages);
  assert.deepEqual(initial.savedFields, ["name", "city", "favoriteFood"]);
  assert.deepEqual(initial.rejectedFields, []);
  await repository.saveUserProfile(initial.facts);

  const update = validateExplicitProfileFacts({
    responseStyle: { value: "krótkie odpowiedzi", evidence: "Wolę krótkie odpowiedzi" },
  }, [...userMessages, "Wolę krótkie odpowiedzi"]);
  assert.deepEqual(update.savedFields, ["responseStyle"]);
  await repository.saveUserProfile(update.facts);

  assert.equal(database.tables.user_profiles.length, 1);
  const profile = await createConversationRepository(database).getUserProfile();
  assert.deepEqual(profile, {
    id: "1",
    name: "Ada",
    preferences: {
      city: "Toruniu",
      favoriteFood: "pizza",
      responseStyle: "krótkie odpowiedzi",
    },
  });

  await repository.createConversation();
  const profileInNewConversation = await createConversationRepository(database).getUserProfile();
  const instructions = profileInstructions(profileInNewConversation);
  assert.match(instructions, /"name":"Ada"/);
  assert.match(instructions, /"city":"Toruniu"/);
  assert.match(instructions, /"favoriteFood":"pizza"/);
  assert.match(instructions, /"responseStyle":"krótkie odpowiedzi"/);
});

test("profile tool fills omitted direct facts from the latest message before saving", async () => {
  const database = makeMemorySupabase();
  const repository = createConversationRepository(database);
  const message = "Mam na imię Ada, mieszkam w Toruniu, a moim ulubionym jedzeniem jest pizza.";
  const modelInput = {
    name: { value: "Ada", evidence: "Mam na imię Ada" },
    favoriteFood: { value: "pizza", evidence: "moim ulubionym jedzeniem jest pizza" },
  };

  const completed = completeProfileInputFromLatestMessage(modelInput, message, [message]);
  assert.deepEqual(completed, {
    ...modelInput,
    city: { value: "Toruniu", evidence: "mieszkam w Toruniu" },
  });
  const checked = validateExplicitProfileFacts(completed, [message]);
  assert.deepEqual(checked.savedFields, ["name", "city", "favoriteFood"]);
  assert.deepEqual(checked.rejectedFields, []);
  await repository.saveUserProfile(checked.facts);
  assert.equal(database.tables.user_profiles.length, 1);
  assert.deepEqual((await repository.getUserProfile()).preferences, {
    city: "Toruniu",
    favoriteFood: "pizza",
  });

  const inflectedModelInput = {
    ...modelInput,
    city: { value: "Toruń", evidence: "mieszkam w Toruniu" },
  };
  const correctedToQuotedForm = completeProfileInputFromLatestMessage(inflectedModelInput, message, [message]);
  assert.equal(correctedToQuotedForm.city.value, "Toruniu");
  assert.equal(correctedToQuotedForm.city.evidence, "mieszkam w Toruniu");
});

test("profile memory recognizes direct Polish favorite-food declarations", () => {
  for (const evidence of [
    "moim ulubionym jedzeniem jest pizza",
    "moje ulubione danie to pizza",
    "najbardziej lubię jeść pizzę",
  ]) {
    const result = validateExplicitProfileFacts({ favoriteFood: { value: evidence.endsWith("pizzę") ? "pizzę" : "pizza", evidence } }, [evidence]);
    assert.deepEqual(result.savedFields, ["favoriteFood"]);
    assert.deepEqual(result.rejectedFields, []);
  }
});

test("profile memory rejects inferred, unquoted, and sensitive values", () => {
  const result = validateExplicitProfileFacts({
    city: { value: "Kraków", evidence: "Planuję przeprowadzkę do Krakowa" },
    name: { value: "tajnehaslo", evidence: "Moje hasło to tajnehaslo" },
  }, ["Planuję przeprowadzkę do Krakowa", "Moje hasło to tajnehaslo"]);
  assert.deepEqual(result.facts, {});
  assert.deepEqual(result.savedFields, []);
  assert.deepEqual(result.rejectedFields, ["name", "city"]);

  for (const text of ["Może mieszkam w Toruniu.", "Planuję, że mieszkam w Toruniu.", "Nie mieszkam w Toruniu."]) {
    const city = validateExplicitProfileFacts({ city: { value: "Toruniu", evidence: "mieszkam w Toruniu" } }, [text]);
    assert.deepEqual(city.facts, {});
    assert.deepEqual(city.rejectedFields, ["city"]);
    const completed = completeProfileInputFromLatestMessage(
      { favoriteFood: { value: "pizza", evidence: "lubię pizzę" } },
      text,
      [text],
    );
    assert.equal(Object.hasOwn(completed, "city"), false);
  }

  const sensitiveDirectFact = validateExplicitProfileFacts({
    name: { value: "sekret", evidence: "Mam na imię sekret" },
  }, ["Mam na imię sekret"]);
  assert.deepEqual(sensitiveDirectFact.facts, {});
  assert.deepEqual(sensitiveDirectFact.rejectedFields, ["name"]);
});
