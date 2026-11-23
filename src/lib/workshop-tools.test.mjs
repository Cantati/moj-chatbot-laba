import assert from "node:assert/strict";
import test from "node:test";
import { createWorkshopTools, currentTimeInputSchema } from "./workshop-tools.ts";

const fixedNow = () => new Date("2026-11-23T11:15:00.000Z");
const options = {
  modelId: "example/model",
  environment: { openrouterApiKey: true, openrouterModel: true, chatPassword: false, sessionSecret: false },
  now: fixedNow,
};
const execute = (tool) => tool.execute;
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status });
const convertOffline = async (amount, mid) => {
  const tools = createWorkshopTools({
    ...options,
    fetchImpl: async () => jsonResponse({ code: "EUR", rates: [{ effectiveDate: "2026-11-23", mid }] }),
  });
  return execute(tools.waluty)({ code: "EUR", amount }, {});
};

test("exposes the seven new tools and reuses aktualnyCzas with an optional timezone", () => {
  const tools = createWorkshopTools(options);
  assert.deepEqual(
    Object.keys(tools),
    ["pogoda", "waluty", "swieta", "wikipedia", "kalkulator", "aktualnyCzas", "notatki", "diagnostyka"],
  );
  assert.equal(currentTimeInputSchema.safeParse({ timeZone: "Europe/Warsaw" }).success, true);
  assert.equal(currentTimeInputSchema.safeParse({ timeZone: "" }).success, false);
});

test("pogoda geocodes a city and reads only the requested daily forecast", async () => {
  const requested = [];
  const tools = createWorkshopTools({
    ...options,
    fetchImpl: async (url) => {
      requested.push(new URL(url));
      if (requested.length === 1) return jsonResponse({ results: [{ name: "Warszawa", country: "Polska", latitude: 52.23, longitude: 21.01 }] });
      return jsonResponse({ daily: {
        time: ["2026-11-23"], weather_code: [3], temperature_2m_max: [4], temperature_2m_min: [-1],
        precipitation_probability_max: [20], precipitation_sum: [0.2],
      } });
    },
  });
  const result = await execute(tools.pogoda)({ city: "Warszawa", day: "dziś" }, {});
  assert.equal(requested[0].hostname, "geocoding-api.open-meteo.com");
  assert.equal(requested[0].searchParams.get("language"), "pl");
  assert.equal(requested[1].searchParams.get("daily"), "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum");
  assert.equal(result.weather, "pochmurno");
  assert.equal(result.date, "2026-11-23");
  assert.equal(result.fetchedAt, "2026-11-23T11:15:00.000Z");
});

test("waluty uses the NBP table A mid-rate and converts the requested amount to PLN", async () => {
  let requestedUrl;
  const tools = createWorkshopTools({
    ...options,
    fetchImpl: async (url) => {
      requestedUrl = new URL(url);
      return jsonResponse({ code: "USD", rates: [{ effectiveDate: "2026-11-20", mid: 4 }] });
    },
  });
  const result = await execute(tools.waluty)({ code: "usd", amount: 12.5 }, {});
  assert.equal(requestedUrl.pathname, "/api/exchangerates/rates/a/usd/");
  assert.equal(requestedUrl.searchParams.get("format"), "json");
  assert.equal(result.amountPLN, 50);
  assert.equal(result.rateDate, "2026-11-20");
});

test("waluty rounds exact decimal half-grosz cases half up", async () => {
  const cases = [
    { amount: 250, rate: 4.4559, expected: 1113.98 },
    { amount: 1, rate: 1.005, expected: 1.01 },
    { amount: 1, rate: 2.675, expected: 2.68 },
    { amount: 1, rate: 0.015, expected: 0.02 },
    { amount: 1, rate: 10.075, expected: 10.08 },
    { amount: 1, rate: 100.005, expected: 100.01 },
  ];
  for (const { amount, rate, expected } of cases) {
    const result = await convertOffline(amount, rate);
    assert.equal(result.amountPLN, expected, amount + " × " + rate);
  }
});

test("waluty preserves ordinary decimal amounts that do not land on half a grosz", async () => {
  const result = await convertOffline(12.34, 1.2345);
  assert.equal(result.amountPLN, 15.23);
});

test("swieta and wikipedia map the documented response fields", async () => {
  const requested = [];
  const tools = createWorkshopTools({
    ...options,
    fetchImpl: async (url) => {
      requested.push(new URL(url));
      return requested.length === 1
        ? jsonResponse([{ date: "2026-01-01", localName: "Nowy Rok", name: "New Year's Day", global: true }])
        : jsonResponse({
            title: "Warszawa", description: "Stolica Polski", extract: "Warszawa jest stolicą Polski.",
            content_urls: { desktop: { page: "https://pl.wikipedia.org/wiki/Warszawa" } },
          });
    },
  });
  const holidays = await execute(tools.swieta)({ countryCode: "pl", year: 2026 }, {});
  assert.equal(requested[0].pathname, "/api/v3/PublicHolidays/2026/PL");
  assert.equal(holidays.holidays[0].name, "Nowy Rok");
  assert.equal(holidays.holidays[0].nationwide, true);
  const article = await execute(tools.wikipedia)({ title: "Warszawa" }, {});
  assert.equal(requested[1].pathname, "/api/rest_v1/page/summary/Warszawa");
  assert.equal(article.summary, "Warszawa jest stolicą Polski.");
  assert.equal(article.url, "https://pl.wikipedia.org/wiki/Warszawa");
});

test("kalkulator performs numeric operations without evaluating expressions and rejects division by zero", async () => {
  const tools = createWorkshopTools(options);
  const result = await execute(tools.kalkulator)({ operation: "pomnóż", a: 6, b: 7 }, {});
  assert.equal(result.result, 42);
  const division = await execute(tools.kalkulator)({ operation: "podziel", a: 2, b: 0 }, {});
  assert.match(division.error, /dzielić przez zero/);
  assert.equal(tools.kalkulator.inputSchema.safeParse({ operation: "dodaj", a: "1+2", b: 1 }).success, false);
});

test("aktualnyCzas formats the date and time in the requested timezone", async () => {
  const tools = createWorkshopTools(options);
  const result = await execute(tools.aktualnyCzas)({ timeZone: "Europe/Warsaw" }, {});
  assert.equal(result.date, "23.11.2026");
  assert.equal(result.weekday, "poniedziałek");
  assert.equal(result.time, "12:15:00");
  const invalid = await execute(tools.aktualnyCzas)({ timeZone: "Not/AZone" }, {});
  assert.match(invalid.error, /Nieprawidłowa strefa/);
});

test("notatki save and return server-memory notes", async () => {
  const tools = createWorkshopTools(options);
  const text = "offline-test-" + Date.now();
  const saved = await execute(tools.notatki)({ action: "zapisz", text }, {});
  assert.equal(saved.note.text, text);
  const listed = await execute(tools.notatki)({ action: "pokaz" }, {});
  assert.ok(listed.notes.some((note) => note.text === text));
});

test("diagnostyka reports model, tool list, step limit, and boolean-like env status only", async () => {
  const tools = createWorkshopTools(options);
  const result = await execute(tools.diagnostyka)({}, {});
  assert.equal(result.model, "example/model");
  assert.equal(result.stepLimit, 6);
  assert.ok(result.tools.includes("aktualnyCzas"));
  assert.ok(result.tools.includes("pogoda"));
  assert.deepEqual(result.environment, {
    OPENROUTER_API_KEY: "tak", OPENROUTER_MODEL: "tak", CHAT_PASSWORD: "nie", SESSION_SECRET: "nie",
  });
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("API failures return readable Polish errors without throwing", async () => {
  const tools = createWorkshopTools({ ...options, fetchImpl: async () => jsonResponse({}, 503) });
  const weather = await execute(tools.pogoda)({ city: "Warszawa", day: "dziś" }, {});
  assert.match(weather.error, /Nie udało się/);
  const exchange = await execute(tools.waluty)({ code: "USD", amount: 1 }, {});
  assert.match(exchange.error, /Nie udało się/);
});
