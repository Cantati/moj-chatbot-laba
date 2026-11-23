type ToolCallOptions = { toolCallId: string; messages: never[]; context: Record<string, unknown> };

export async function runDashboardTool(
  entry: unknown,
  input: unknown,
  toolCallId: string,
  fallbackError = "Nie udało się pobrać danych ze źródła.",
): Promise<Record<string, unknown>> {
  const execute = (entry as { execute?: (input: never, options: ToolCallOptions) => Promise<unknown> }).execute;
  if (!execute) return { error: "Narzędzie jest chwilowo niedostępne." };

  let output: unknown;
  try {
    output = await execute(input as never, { toolCallId, messages: [], context: {} });
  } catch {
    return { error: fallbackError };
  }
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return { error: "Źródło zwróciło nieprawidłowe dane." };
  }

  const result = output as Record<string, unknown>;
  if (typeof result.error === "string") {
    const { fetchedAt: _discardedFetchTime, ...errorResult } = result;
    return errorResult;
  }
  return { ...result, fetchedAt: new Date().toISOString() };
}


type DashboardSources = {
  weather: Record<string, unknown>;
  currency: Record<string, unknown>;
  holidays: Record<string, unknown>;
  wikipedia: Record<string, unknown>;
  time: Record<string, unknown>;
};

type DashboardToolSet = {
  pogoda: unknown;
  waluty: unknown;
  swieta: unknown;
  wikipedia: unknown;
  aktualnyCzas: unknown;
};

export type DashboardCard = {
  id: string;
  title: string;
  value?: string;
  url?: string;
  source: string;
  fetchedAt?: string;
  error?: string;
};

export type DashboardData = {
  city: string;
  date: string;
  cards: DashboardCard[];
  sources: DashboardSources;
};

function text(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sentences(summary: string) {
  const found = summary.match(/[^.!?]+[.!?]+(?:[”"']|\s|$)/g)?.map((part) => part.trim()) ?? [];
  return found.slice(0, 2).join(" ") || summary.trim();
}

function offsetMinutes(instant: Date, timeZone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(instant).filter((part) => part.type !== "literal").map(({ type, value }) => [type, Number(value)]));
  const zoneAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  return Math.round((zoneAsUtc - Math.floor(instant.getTime() / 60_000) * 60_000) / 60_000);
}

function offsetDifferenceLabel(destination: string) {
  const instant = new Date();
  const difference = offsetMinutes(instant, destination) - offsetMinutes(instant, "Europe/Warsaw");
  const sign = difference > 0 ? "+" : difference < 0 ? "−" : "";
  const absolute = Math.abs(difference);
  const hours = Math.floor(absolute / 60);
  const minutes = absolute % 60;
  return `${sign}${hours}${minutes ? ` godz. ${minutes} min` : " godz."} względem Polski`;
}

export async function loadDashboardData(
  tools: DashboardToolSet,
  city: string,
  date: string,
  readDashboardGeography: (weather: Record<string, unknown>) => { countryCode: string; timeZone: string; currencyCode: string },
): Promise<DashboardData> {
  const weather = await runDashboardTool(tools.pogoda, { city, day: date }, "dashboard-weather", "Nie udało się pobrać prognozy pogody.");
  const { countryCode, timeZone, currencyCode } = readDashboardGeography(weather);
  const year = Number(date.slice(0, 4));
  const [currency, holidays, wikipedia] = await Promise.all([
    currencyCode
      ? runDashboardTool(tools.waluty, { code: currencyCode, amount: 1 }, "dashboard-currency", "Nie udało się pobrać kursu z NBP.")
      : Promise.resolve<Record<string, unknown>>({ error: countryCode ? `Nie mamy przypisanej waluty dla kraju ${countryCode}.` : "Nie udało się ustalić kraju docelowego." }),
    countryCode
      ? runDashboardTool(tools.swieta, { countryCode, year }, "dashboard-holidays", "Nie udało się pobrać kalendarza świąt.")
      : Promise.resolve<Record<string, unknown>>({ error: "Nie udało się ustalić kraju docelowego." }),
    runDashboardTool(tools.wikipedia, { title: city }, "dashboard-wikipedia", "Nie udało się pobrać streszczenia z Wikipedii."),
  ]);
  const time = timeZone
    ? await runDashboardTool(tools.aktualnyCzas, { timeZone }, "dashboard-time", "Nie udało się ustalić czasu lokalnego.")
    : { error: "Nie udało się ustalić strefy czasowej miasta." };

  const weatherValue = typeof weather.error === "string"
    ? undefined
    : `${text(weather.weather)} · ${number(weather.temperatureMinC) ?? "—"}–${number(weather.temperatureMaxC) ?? "—"} °C${number(weather.precipitationSumMm) !== undefined ? ` · opady ${weather.precipitationSumMm} mm` : ""}${number(weather.precipitationProbabilityMaxPercent) !== undefined ? ` · ryzyko opadów ${weather.precipitationProbabilityMaxPercent}%` : ""}`;
  const rate = number(currency.rateToPLN);
  const holidayList = Array.isArray(holidays.holidays)
    ? holidays.holidays
      .filter((item): item is { date: string; name: string } => Boolean(item && typeof item === "object" && typeof (item as { date?: unknown }).date === "string" && typeof (item as { name?: unknown }).name === "string"))
      .filter((item) => item.date >= date)
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(0, 3)
    : [];
  const wikipediaSummary = text(wikipedia.summary);
  const destinationTime = text(time.time);

  const cards: DashboardCard[] = [
    {
      id: "weather", title: "Pogoda", value: weatherValue, error: text(weather.error) || undefined,
      source: "Open-Meteo", fetchedAt: text(weather.fetchedAt) || undefined,
    },
    {
      id: "currency", title: "Waluta",
      value: rate !== undefined ? `1 ${text(currency.code, currencyCode || "")} = ${rate.toLocaleString("pl-PL", { minimumFractionDigits: 4, maximumFractionDigits: 4 })} zł${text(currency.rateDate) ? ` (kurs z ${currency.rateDate})` : ""}` : undefined,
      error: text(currency.error) || undefined, source: "NBP", fetchedAt: text(currency.fetchedAt) || undefined,
    },
    {
      id: "holidays", title: "Najbliższe dni wolne",
      value: holidayList.length ? holidayList.map((holiday) => `${holiday.date}: ${holiday.name}`).join(" · ") : typeof holidays.error !== "string" ? `Brak kolejnych dni wolnych w ${year} według Nager.Date.` : undefined,
      error: text(holidays.error) || undefined, source: "Nager.Date", fetchedAt: text(holidays.fetchedAt) || undefined,
    },
    {
      id: "wikipedia", title: "O mieście", value: wikipediaSummary ? sentences(wikipediaSummary) : undefined,
      url: text(wikipedia.url) || undefined, error: text(wikipedia.error) || undefined,
      source: "Wikipedia (PL)", fetchedAt: text(wikipedia.fetchedAt) || undefined,
    },
    {
      id: "time", title: "Czas na miejscu",
      value: destinationTime ? `${destinationTime} (${offsetDifferenceLabel(timeZone)})` : undefined,
      error: text(time.error) || undefined, source: timeZone ? `Zegar lokalny · ${timeZone}` : "Zegar lokalny",
      fetchedAt: text(time.fetchedAt) || undefined,
    },
  ];

  return { city: text(weather.city, city), date, cards, sources: { weather, currency, holidays, wikipedia, time } };
}

export function createDashboardSummaryPrompt(data: DashboardData) {
  return JSON.stringify({
    miasto: data.city,
    data: data.date,
    sources: [
      { name: "Open-Meteo", data: data.sources.weather },
      { name: "NBP", data: data.sources.currency },
      { name: "Nager.Date", data: data.sources.holidays },
      { name: "Wikipedia (PL)", data: data.sources.wikipedia },
      { name: "Czas lokalny", data: data.sources.time },
    ],
  });
}

export function getDashboardCardNoDataLabel(card: Pick<DashboardCard, "value" | "error">) {
  return card.error || !card.value?.trim() ? "Brak danych" : undefined;
}

export function formatDashboardFetchedAt(value?: string) {
  if (!value) return "Nie pobrano";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Nie pobrano";
  return `Pobrano: ${date.toLocaleString("pl-PL", { dateStyle: "short", timeStyle: "short" })}`;
}
