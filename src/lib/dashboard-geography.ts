const currencyByCountry: Record<string, string> = {
  AD: "EUR", AT: "EUR", BE: "EUR", BG: "EUR", CY: "EUR", DE: "EUR", EE: "EUR", ES: "EUR", FI: "EUR", FR: "EUR", GR: "EUR", HR: "EUR", IE: "EUR", IT: "EUR", LT: "EUR", LU: "EUR", LV: "EUR", MC: "EUR", MT: "EUR", NL: "EUR", PT: "EUR", SI: "EUR", SK: "EUR", SM: "EUR", VA: "EUR",
  AE: "AED", AL: "ALL", AR: "ARS", AU: "AUD", BA: "BAM", BR: "BRL", CA: "CAD", CH: "CHF", CL: "CLP", CN: "CNY", CO: "COP", CZ: "CZK", DK: "DKK", EG: "EGP", GB: "GBP", HK: "HKD", HU: "HUF", ID: "IDR", IL: "ILS", IN: "INR", IS: "ISK", JP: "JPY", KR: "KRW", MA: "MAD", MX: "MXN", MY: "MYR", NO: "NOK", NZ: "NZD", PH: "PHP", PK: "PKR", PL: "PLN", RO: "RON", RS: "RSD", RU: "RUB", SA: "SAR", SE: "SEK", SG: "SGD", TH: "THB", TR: "TRY", TW: "TWD", UA: "UAH", US: "USD", VN: "VND", ZA: "ZAR",
};

export function readDashboardGeography(weather: Record<string, unknown>) {
  const countryCode = typeof weather.countryCode === "string" ? weather.countryCode.toUpperCase() : "";
  const timeZone = typeof weather.timeZone === "string" ? weather.timeZone : "";
  return { countryCode, timeZone, currencyCode: currencyByCountry[countryCode] ?? "" };
}
