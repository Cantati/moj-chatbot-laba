import { tool } from "ai";
import { z } from "zod";

type WorkshopToolOptions = {
  modelId: string;
  environment: { openrouterApiKey: boolean; openrouterModel: boolean; chatPassword: boolean; sessionSecret: boolean };
  fetchImpl?: typeof fetch;
  now?: () => Date;
};
type SavedNote = { id: number; text: string; savedAt: string };
const memory = globalThis as typeof globalThis & { __labaAgentNotes?: SavedNote[]; __labaAgentNextNoteId?: number };
memory.__labaAgentNotes ??= [];
memory.__labaAgentNextNoteId ??= 1;

const timestamp = (now: () => Date) => now().toISOString();
const dateParts = (date: Date, timeZone: string) =>
  Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date).filter((part) => part.type !== "literal").map(({ type, value }) => [type, value])) as {
    year: string; month: string; day: string;
  };
const dateInZone = (date: Date, timeZone: string) => {
  const parts = dateParts(date, timeZone);
  return parts.year + "-" + parts.month + "-" + parts.day;
};

function decimalParts(value: number) {
  const [mantissa, exponentText] = value.toString().toLowerCase().split("e");
  const exponent = exponentText ? Number(exponentText) : 0;
  const [integerPart, fractionPart = ""] = mantissa.split(".");
  let coefficient = BigInt(integerPart + fractionPart);
  let scale = fractionPart.length - exponent;
  if (scale < 0) {
    coefficient *= BigInt(10) ** BigInt(-scale);
    scale = 0;
  }
  return { coefficient, scale };
}

function multiplyDecimalAndRoundToCents(amount: number, rate: number) {
  const amountParts = decimalParts(amount);
  const rateParts = decimalParts(rate);
  const product = amountParts.coefficient * rateParts.coefficient;
  const scale = amountParts.scale + rateParts.scale;
  let cents: bigint;
  if (scale <= 2) {
    cents = product * BigInt(10) ** BigInt(2 - scale);
  } else {
    const divisor = BigInt(10) ** BigInt(scale - 2);
    const wholeCents = product / divisor;
    const remainder = product % divisor;
    cents = wholeCents + (remainder * BigInt(2) >= divisor ? BigInt(1) : BigInt(0));
  }
  const digits = cents.toString().padStart(3, "0");
  return Number(digits.slice(0, -2) + "." + digits.slice(-2));
}

function resolveForecastDate(value: string, now: () => Date) {
  const input = value.trim().toLocaleLowerCase("pl-PL");
  const base = dateInZone(now(), "Europe/Warsaw");
  const offsets: Record<string, number> = { "dziś": 0, dzis: 0, dzisiaj: 0, jutro: 1, pojutrze: 2 };
  if (input in offsets) {
    const [year, month, day] = base.split("-").map(Number);
    return new Date(Date.UTC(year, month - 1, day + offsets[input])).toISOString().slice(0, 10);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) return null;
  const parsed = new Date(input + "T00:00:00.000Z");
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== input ? null : input;
}

type JsonResult = { ok: true; data: unknown } | { ok: false; status?: number };
async function fetchJson(url: URL, fetchImpl: typeof fetch): Promise<JsonResult> {
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: "application/json", "User-Agent": "moj-chatbot-laba/1.0" },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return { ok: false, status: response.status };
    return { ok: true, data: await response.json() };
  } catch {
    return { ok: false };
  }
}

const weatherDescriptions: Record<number, string> = {
  0: "bezchmurnie", 1: "przeważnie słonecznie", 2: "częściowe zachmurzenie", 3: "pochmurno",
  45: "mgła", 48: "mgła osadzająca szadź", 51: "lekka mżawka", 53: "umiarkowana mżawka",
  55: "intensywna mżawka", 56: "lekka marznąca mżawka", 57: "intensywna marznąca mżawka",
  61: "lekki deszcz", 63: "umiarkowany deszcz", 65: "intensywny deszcz",
  66: "lekki marznący deszcz", 67: "intensywny marznący deszcz", 71: "lekki śnieg",
  73: "umiarkowane opady śniegu", 75: "intensywne opady śniegu", 77: "ziarna śniegu",
  80: "przelotne, słabe opady deszczu", 81: "przelotne opady deszczu",
  82: "silne przelotne opady deszczu", 85: "przelotne opady śniegu",
  86: "silne przelotne opady śniegu", 95: "burza", 96: "burza z lekkim gradem",
  99: "burza z silnym gradem",
};

const weatherSchema = z.strictObject({ city: z.string().trim().min(1).max(100), day: z.string().trim().min(1).max(30) });
const currencySchema = z.strictObject({ code: z.string().trim().regex(/^[A-Za-z]{3}$/), amount: z.number().finite().min(0).max(1_000_000_000_000) });
const holidaysSchema = z.strictObject({ countryCode: z.string().trim().regex(/^[A-Za-z]{2}$/), year: z.number().int().min(1900).max(2100) });
const wikipediaSchema = z.strictObject({ title: z.string().trim().min(1).max(120) });
const calculatorSchema = z.strictObject({
  operation: z.enum(["dodaj", "odejmij", "pomnóż", "podziel"]),
  a: z.number().finite().max(1e100).min(-1e100), b: z.number().finite().max(1e100).min(-1e100),
});
export const currentTimeInputSchema = z.strictObject({ timeZone: z.string().trim().min(1).max(64).optional() });
const notesSchema = z.strictObject({ action: z.enum(["zapisz", "pokaz"]), text: z.string().trim().min(1).max(1000).optional() });
const emptySchema = z.strictObject({});

export function createWorkshopTools(options: WorkshopToolOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  return {
    pogoda: tool({
      description: "Sprawdza prognozę pogody dla miasta i dnia. Użyj, gdy pytanie dotyczy pogody w konkretnej miejscowości dziś, jutro lub wskazanego dnia. Podaj miasto i dzień jako dziś/jutro/pojutrze albo datę RRRR-MM-DD; nie zgaduj prognozy.",
      inputSchema: weatherSchema,
      execute: async ({ city, day }) => {
        const fetchedAt = timestamp(now);
        const date = resolveForecastDate(day, now);
        if (!date) return { error: "Podaj dzień jako dziś, jutro, pojutrze lub datę RRRR-MM-DD.", fetchedAt };
        const geocodeUrl = new URL("https://geocoding-api.open-meteo.com/v1/search");
        geocodeUrl.search = new URLSearchParams({ name: city, count: "1", language: "pl", format: "json" }).toString();
        const geocode = await fetchJson(geocodeUrl, fetchImpl);
        if (!geocode.ok) return { error: "Nie udało się połączyć z usługą wyszukiwania miejscowości.", fetchedAt };
        const locations = (geocode.data as { results?: unknown })?.results;
        const place = Array.isArray(locations) ? locations[0] as {
          name?: unknown; country?: unknown; country_code?: unknown; timezone?: unknown;
          latitude?: unknown; longitude?: unknown;
        } | undefined : undefined;
        if (!place || typeof place.latitude !== "number" || typeof place.longitude !== "number") return { error: "Nie znaleziono miejscowości „" + city + "”.", fetchedAt };
        const placeDetails = {
          city: typeof place.name === "string" ? place.name : city,
          ...(typeof place.country === "string" ? { country: place.country } : {}),
          ...(typeof place.country_code === "string" ? { countryCode: place.country_code.toUpperCase() } : {}),
          ...(typeof place.timezone === "string" ? { timeZone: place.timezone } : {}),
        };
        const forecastUrl = new URL("https://api.open-meteo.com/v1/forecast");
        forecastUrl.search = new URLSearchParams({
          latitude: String(place.latitude), longitude: String(place.longitude),
          daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum",
          forecast_days: "16", timezone: "auto",
        }).toString();
        const forecast = await fetchJson(forecastUrl, fetchImpl);
        if (!forecast.ok) return { ...placeDetails, error: "Nie udało się pobrać prognozy pogody.", fetchedAt };
        const daily = (forecast.data as { daily?: Record<string, unknown> })?.daily;
        const dates = daily?.time;
        const index = Array.isArray(dates) ? dates.indexOf(date) : -1;
        if (index < 0) return { ...placeDetails, error: "Brak prognozy dla dnia " + date + "; prognoza obejmuje ograniczony zakres najbliższych dni.", fetchedAt };
        const at = (key: string) => Array.isArray(daily?.[key]) ? (daily?.[key] as unknown[])[index] : undefined;
        const code = at("weather_code");
        const temperatureMaxC = at("temperature_2m_max");
        const temperatureMinC = at("temperature_2m_min");
        if (typeof code !== "number" || typeof temperatureMaxC !== "number" || typeof temperatureMinC !== "number") {
          return { ...placeDetails, error: "Prognoza nie zawiera kompletnych danych dla wybranego dnia.", fetchedAt };
        }
        const precipitationProbabilityMaxPercent = at("precipitation_probability_max");
        const precipitationSumMm = at("precipitation_sum");
        return {
          ...placeDetails,
          date, weather: weatherDescriptions[code] ?? "kod zjawiska WMO " + code,
          temperatureMaxC, temperatureMinC,
          ...(typeof precipitationProbabilityMaxPercent === "number" ? { precipitationProbabilityMaxPercent } : {}),
          ...(typeof precipitationSumMm === "number" ? { precipitationSumMm } : {}),
          fetchedAt,
        };
      },
    }),
    waluty: tool({
      description: "Pobiera aktualny średni kurs waluty obcej wobec PLN z tabeli A NBP i przelicza podaną kwotę tej waluty na złote. Użyj przy pytaniach o bieżący kurs lub przeliczenie kwoty. Kwota wejściowa jest wyrażona w podanej walucie; wynik to PLN. Nie wymyślaj kursu.",
      inputSchema: currencySchema,
      execute: async ({ code, amount }) => {
        const fetchedAt = timestamp(now);
        const normalizedCode = code.toUpperCase();
        if (normalizedCode === "PLN") return { code: "PLN", rateToPLN: 1, amount, amountPLN: amount, rateDate: dateInZone(now(), "Europe/Warsaw"), fetchedAt };
        const url = new URL("https://api.nbp.pl/api/exchangerates/rates/a/" + encodeURIComponent(normalizedCode.toLowerCase()) + "/");
        url.searchParams.set("format", "json");
        const result = await fetchJson(url, fetchImpl);
        if (!result.ok) return { error: result.status === 404 ? "NBP nie ma obecnie notowania waluty " + normalizedCode + "." : "Nie udało się pobrać kursu z NBP.", fetchedAt };
        const data = result.data as { rates?: unknown };
        const rate = Array.isArray(data.rates) ? data.rates[0] as { mid?: unknown; effectiveDate?: unknown } | undefined : undefined;
        if (typeof rate?.mid !== "number" || !Number.isFinite(rate.mid) || typeof rate.effectiveDate !== "string") return { error: "Brak prawidłowego notowania waluty " + normalizedCode + " w odpowiedzi NBP.", fetchedAt };
        return { code: normalizedCode, rateToPLN: rate.mid, amount, amountPLN: multiplyDecimalAndRoundToCents(amount, rate.mid), rateDate: rate.effectiveDate, fetchedAt };
      },
    }),
    swieta: tool({
      description: "Pobiera listę dni wolnych/świąt publicznych z Nager.Date dla kraju i roku. Użyj przy pytaniach o święta państwowe, dni wolne od pracy lub kalendarz świąt danego kraju; kraj podaj jako kod ISO 3166-1 alpha-2.",
      inputSchema: holidaysSchema,
      execute: async ({ countryCode, year }) => {
        const fetchedAt = timestamp(now);
        const country = countryCode.toUpperCase();
        const result = await fetchJson(new URL("https://date.nager.at/api/v3/PublicHolidays/" + year + "/" + encodeURIComponent(country)), fetchImpl);
        if (!result.ok) return { error: result.status === 404 ? "Nie znaleziono danych o świętach dla kraju " + country + " i roku " + year + "." : "Nie udało się pobrać kalendarza świąt.", fetchedAt };
        if (!Array.isArray(result.data)) return { error: "Usługa kalendarza świąt zwróciła nieprawidłowe dane.", fetchedAt };
        const holidays = result.data.flatMap((item: unknown) => {
          if (!item || typeof item !== "object") return [];
          const holiday = item as { date?: unknown; localName?: unknown; name?: unknown; global?: unknown };
          if (typeof holiday.date !== "string") return [];
          return [{ date: holiday.date, name: typeof holiday.localName === "string" ? holiday.localName : typeof holiday.name === "string" ? holiday.name : "Święto", ...(typeof holiday.global === "boolean" ? { nationwide: holiday.global } : {}) }];
        });
        return holidays.length ? { countryCode: country, year, holidays, fetchedAt } : { error: "Brak danych o dniach wolnych dla kraju " + country + " i roku " + year + ".", fetchedAt };
      },
    }),
    wikipedia: tool({
      description: "Pobiera krótkie streszczenie hasła z polskiej Wikipedii wraz z linkiem do artykułu. Użyj, gdy użytkownik pyta o ogólną wiedzę lub prosi o wyjaśnienie konkretnego hasła; jeśli hasło jest niejednoznaczne albo nie istnieje, poinformuj o tym zamiast dopowiadać.",
      inputSchema: wikipediaSchema,
      execute: async ({ title }) => {
        const fetchedAt = timestamp(now);
        const url = new URL("https://pl.wikipedia.org/api/rest_v1/page/summary/" + encodeURIComponent(title));
        const result = await fetchJson(url, fetchImpl);
        if (!result.ok) return { error: result.status === 404 ? "Nie znaleziono hasła „" + title + "” w polskiej Wikipedii." : "Nie udało się pobrać streszczenia z polskiej Wikipedii.", fetchedAt };
        const data = result.data as { title?: unknown; extract?: unknown; description?: unknown; content_urls?: { desktop?: { page?: unknown } } };
        const link = data.content_urls?.desktop?.page;
        if (typeof data.extract !== "string" || !data.extract.trim() || typeof link !== "string") return { error: "Brak krótkiego streszczenia hasła „" + title + "” w polskiej Wikipedii.", fetchedAt };
        return { title: typeof data.title === "string" ? data.title : title, ...(typeof data.description === "string" ? { description: data.description } : {}), summary: data.extract, url: link, fetchedAt };
      },
    }),
    kalkulator: tool({
      description: "Wykonuje proste działanie arytmetyczne na dwóch osobnych liczbach. Użyj przy obliczeniach dodawania, odejmowania, mnożenia lub dzielenia; przekaż operation, a i b. Nie przyjmuj ani nie wykonuj kodu lub wyrażeń tekstowych.",
      inputSchema: calculatorSchema,
      execute: async ({ operation, a, b }) => {
        const fetchedAt = timestamp(now);
        if (operation === "podziel" && b === 0) return { error: "Nie można dzielić przez zero.", fetchedAt };
        const result = operation === "dodaj" ? a + b : operation === "odejmij" ? a - b : operation === "pomnóż" ? a * b : a / b;
        if (!Number.isFinite(result)) return { error: "Wynik działania wykracza poza obsługiwany zakres.", fetchedAt };
        return { operation, a, b, result, fetchedAt };
      },
    }),
    aktualnyCzas: tool({
      description: "Zwraca aktualną datę, dzień tygodnia i godzinę w podanej strefie czasowej (domyślnie Europe/Warsaw). Użyj przy pytaniach o dziś, teraz, jutro, konkretną datę lub wyliczenia „za ile dni”; przy pytaniu o czas w innym kraju podaj jego strefę IANA, np. Europe/London. Nie zgaduj aktualnego czasu.",
      inputSchema: currentTimeInputSchema,
      execute: async ({ timeZone }) => {
        const fetchedAt = timestamp(now);
        const zone = timeZone ?? "Europe/Warsaw";
        try {
          const instant = now();
          return {
            date: new Intl.DateTimeFormat("pl-PL", { timeZone: zone, day: "2-digit", month: "2-digit", year: "numeric" }).format(instant),
            weekday: new Intl.DateTimeFormat("pl-PL", { timeZone: zone, weekday: "long" }).format(instant),
            time: new Intl.DateTimeFormat("pl-PL", { timeZone: zone, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(instant),
            timeZone: zone, fetchedAt,
          };
        } catch {
          return { error: "Nieprawidłowa strefa czasowa „" + zone + "”. Podaj nazwę IANA, na przykład Europe/Warsaw.", fetchedAt };
        }
      },
    }),
    notatki: tool({
      description: "Zapisuje krótką notatkę w pamięci serwera albo pokazuje zapisane notatki. Użyj, gdy użytkownik prosi o zapamiętanie informacji lub o wyświetlenie wcześniejszych notatek. Do zapisu przekaż action=zapisz i text; do odczytu action=pokaz. Notatki są tymczasowe i mogą zniknąć po restarcie serwera.",
      inputSchema: notesSchema,
      execute: async ({ action, text }) => {
        const fetchedAt = timestamp(now);
        const notes = memory.__labaAgentNotes!;
        if (action === "zapisz") {
          if (!text?.trim()) return { error: "Podaj treść notatki do zapisania.", fetchedAt };
          if (notes.length >= 100) return { error: "Osiągnięto limit 100 notatek w pamięci serwera.", fetchedAt };
          const note: SavedNote = { id: memory.__labaAgentNextNoteId!, text: text.trim(), savedAt: fetchedAt };
          memory.__labaAgentNextNoteId! += 1;
          notes.push(note);
          return { message: "Notatka została zapisana w pamięci serwera.", note, fetchedAt };
        }
        if (text !== undefined) return { error: "Przy wyświetlaniu notatek nie podawaj pola text.", fetchedAt };
        return { notes: notes.map((note) => ({ ...note })), fetchedAt };
      },
    }),
    diagnostyka: tool({
      description: "Pokazuje bezpieczną diagnostykę agenta: skonfigurowaną nazwę modelu, dostępne narzędzia, limit kroków i wyłącznie informację tak/nie o ustawieniu wymaganych zmiennych środowiskowych. Użyj, gdy użytkownik pyta o konfigurację lub możliwości agenta; nigdy nie ujawniaj wartości sekretów.",
      inputSchema: emptySchema,
      execute: async () => ({
        model: options.modelId,
        tools: ["web_search", "pogoda", "waluty", "swieta", "wikipedia", "kalkulator", "aktualnyCzas", "notatki", "diagnostyka", "generateImage", "cennikUslug", "przygotowanieDoUslugi"],
        stepLimit: 6,
        environment: {
          OPENROUTER_API_KEY: options.environment.openrouterApiKey ? "tak" : "nie",
          OPENROUTER_MODEL: options.environment.openrouterModel ? "tak" : "nie",
          CHAT_PASSWORD: options.environment.chatPassword ? "tak" : "nie",
          SESSION_SECRET: options.environment.sessionSecret ? "tak" : "nie",
        },
        fetchedAt: timestamp(now),
      }),
    }),
  };
}
