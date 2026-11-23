import assert from "node:assert/strict";
import test from "node:test";
import { createWorkshopTools } from "./workshop-tools.ts";
import { runDashboardTool } from "./dashboard-execution.ts";
import { readDashboardGeography } from "./dashboard-geography.ts";

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status });
const options = {
  modelId: "offline-test/model",
  environment: { openrouterApiKey: false, openrouterModel: false, chatPassword: false, sessionSecret: false },
  now: () => new Date("2026-11-23T11:15:00.000Z"),
};

test("Alicante geocoding metadata reaches currency, holidays, and local-time tools offline", async () => {
  const requests = [];
  const tools = createWorkshopTools({
    ...options,
    fetchImpl: async (input) => {
      const url = new URL(input.toString());
      requests.push(url);
      if (url.hostname === "geocoding-api.open-meteo.com") {
        return jsonResponse({ results: [{ name: "Alicante", country: "Hiszpania", country_code: "ES", timezone: "Europe/Madrid", latitude: 38.3452, longitude: -0.481 }] });
      }
      if (url.hostname === "api.open-meteo.com") {
        return jsonResponse({ daily: { time: ["2026-11-25"], weather_code: [3], temperature_2m_max: [18], temperature_2m_min: [12], precipitation_probability_max: [5], precipitation_sum: [0] } });
      }
      if (url.hostname === "api.nbp.pl") return jsonResponse({ code: "EUR", rates: [{ effectiveDate: "2026-11-24", mid: 4.3 }] });
      if (url.hostname === "date.nager.at") return jsonResponse([{ date: "2026-12-06", localName: "Święto testowe", name: "Test Holiday", global: true }]);
      throw new Error("Unexpected offline test URL: " + url.hostname);
    },
  });

  const weather = await runDashboardTool(tools.pogoda, { city: "Alicante", day: "2026-11-25" }, "dashboard-weather");
  const destination = readDashboardGeography(weather);
  assert.equal(weather.weather, "pochmurno");
  assert.deepEqual(destination, { countryCode: "ES", timeZone: "Europe/Madrid", currencyCode: "EUR" });

  const [currency, holidays, localTime] = await Promise.all([
    tools.waluty.execute({ code: destination.currencyCode, amount: 1 }, {}),
    tools.swieta.execute({ countryCode: destination.countryCode, year: 2026 }, {}),
    tools.aktualnyCzas.execute({ timeZone: destination.timeZone }, {}),
  ]);
  assert.equal(currency.code, "EUR");
  assert.equal(currency.rateToPLN, 4.3);
  assert.equal(holidays.countryCode, "ES");
  assert.equal(holidays.holidays[0].name, "Święto testowe");
  assert.equal(localTime.timeZone, "Europe/Madrid");
  assert.ok(requests.some((url) => url.hostname === "api.nbp.pl" && url.pathname.endsWith("/eur/")));
  assert.ok(requests.some((url) => url.hostname === "date.nager.at" && url.pathname.endsWith("/ES")));
});

test("dashboard does not guess country, currency, or timezone when geocoding omits them", async () => {
  const tools = createWorkshopTools({
    ...options,
    fetchImpl: async (input) => new URL(input.toString()).hostname === "geocoding-api.open-meteo.com"
      ? jsonResponse({ results: [{ name: "Alicante", latitude: 38.3452, longitude: -0.481 }] })
      : jsonResponse({ daily: { time: ["2026-11-25"], weather_code: [3], temperature_2m_max: [18], temperature_2m_min: [12] } }),
  });
  const weather = await runDashboardTool(tools.pogoda, { city: "Alicante", day: "2026-11-25" }, "dashboard-weather");
  assert.deepEqual(readDashboardGeography(weather), { countryCode: "", timeZone: "", currencyCode: "" });
});
