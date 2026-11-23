import assert from "node:assert/strict";
import test from "node:test";
import { createWorkshopTools } from "./workshop-tools.ts";
import { createDashboardSummaryPrompt, formatDashboardFetchedAt, getDashboardCardNoDataLabel, loadDashboardData } from "./dashboard-execution.ts";
import { readDashboardGeography } from "./dashboard-geography.ts";

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status });

test("keeps the other dashboard cards and summary input when NBP returns 503", async () => {
  const requestedHosts = [];
  const tools = createWorkshopTools({
    modelId: "offline-test/model",
    environment: { openrouterApiKey: false, openrouterModel: false, chatPassword: false, sessionSecret: false },
    now: () => new Date("2026-11-23T11:15:00.000Z"),
    fetchImpl: async (input) => {
      const url = new URL(input.toString());
      requestedHosts.push(url.hostname);
      if (url.hostname === "geocoding-api.open-meteo.com") {
        return jsonResponse({ results: [{ name: "Alicante", country: "Hiszpania", country_code: "ES", timezone: "Europe/Madrid", latitude: 38.3452, longitude: -0.481 }] });
      }
      if (url.hostname === "api.open-meteo.com") {
        return jsonResponse({ daily: { time: ["2026-11-25"], weather_code: [3], temperature_2m_max: [18], temperature_2m_min: [12], precipitation_probability_max: [5], precipitation_sum: [0] } });
      }
      if (url.hostname === "api.nbp.pl") return jsonResponse({ message: "unavailable" }, 503);
      if (url.hostname === "date.nager.at") {
        return jsonResponse([{ date: "2026-12-06", localName: "Święto testowe", name: "Test Holiday", global: true }]);
      }
      if (url.hostname === "pl.wikipedia.org") {
        return jsonResponse({ title: "Alicante", extract: "Alicante leży nad Morzem Śródziemnym. Miasto znajduje się w Hiszpanii.", content_urls: { desktop: { page: "https://pl.wikipedia.org/wiki/Alicante" } } });
      }
      throw new Error("Unexpected offline test URL: " + url.hostname);
    },
  });

  const dashboard = await loadDashboardData(tools, "Alicante", "2026-11-25", readDashboardGeography);
  const byId = Object.fromEntries(dashboard.cards.map((card) => [card.id, card]));

  assert.match(byId.weather.value, /pochmurno/);
  assert.match(byId.holidays.value, /Święto testowe/);
  assert.match(byId.wikipedia.value, /Alicante/);
  assert.match(byId.time.value, /\d{2}:\d{2}/);
  assert.ok(byId.weather.fetchedAt);
  assert.ok(byId.holidays.fetchedAt);
  assert.ok(byId.wikipedia.fetchedAt);
  assert.ok(byId.time.fetchedAt);

  assert.equal(byId.currency.value, undefined);
  assert.equal(byId.currency.error, "Nie udało się pobrać kursu z NBP.");
  assert.equal(byId.currency.fetchedAt, undefined);
  assert.equal(getDashboardCardNoDataLabel(byId.currency), "Brak danych");
  assert.equal(formatDashboardFetchedAt(byId.currency.fetchedAt), "Nie pobrano");
  assert.ok(requestedHosts.includes("api.nbp.pl"));

  const summaryInput = JSON.parse(createDashboardSummaryPrompt(dashboard));
  const nbpSource = summaryInput.sources.find((source) => source.name === "NBP");
  assert.equal(nbpSource.data.error, "Nie udało się pobrać kursu z NBP.");
  assert.equal(nbpSource.data.rateToPLN, undefined);

  const throwingDashboard = await loadDashboardData({
    ...tools,
    waluty: { execute: async () => { throw new Error("offline failure"); } },
  }, "Alicante", "2026-11-25", readDashboardGeography);
  const throwingCards = Object.fromEntries(throwingDashboard.cards.map((card) => [card.id, card]));
  assert.ok(throwingCards.weather.value);
  assert.ok(throwingCards.holidays.value);
  assert.ok(throwingCards.wikipedia.value);
  assert.ok(throwingCards.time.value);
  assert.equal(throwingCards.currency.value, undefined);
  assert.match(throwingCards.currency.error, /NBP/);
});
