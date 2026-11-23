"use client";

import { useState, type FormEvent } from "react";
import { formatDashboardFetchedAt, getDashboardCardNoDataLabel } from "../../lib/dashboard-execution";

type DashboardCard = {
  id: string;
  title: string;
  value?: string;
  url?: string;
  source: string;
  fetchedAt?: string;
  error?: string;
};
type DashboardResult = { city: string; date: string; cards: DashboardCard[]; summary?: string; summaryError?: string };

function todayInWarsaw() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Warsaw", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export default function DashboardClient() {
  const [city, setCity] = useState("");
  const [date, setDate] = useState(todayInWarsaw);
  const [result, setResult] = useState<DashboardResult | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function load(event?: FormEvent) {
    event?.preventDefault();
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/dashboard", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ city, date }),
      });
      const data = await response.json() as DashboardResult & { error?: string };
      if (!response.ok) throw new Error(data.error || "Nie udało się pobrać danych podróży.");
      setResult(data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Nie udało się pobrać danych podróży.");
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="dashboard">
      <header className="dashboard-header">
        <div><p className="dashboard-eyebrow">Plan podróży</p><h1>Asystent podróży</h1></div>
        <a href="/">Wróć do czatu</a>
      </header>
      <form className="dashboard-form" onSubmit={load}>
        <label>Dokąd jedziesz?<input value={city} onChange={(event) => setCity(event.target.value)} maxLength={100} required placeholder="np. Rzym" /></label>
        <label>Kiedy?<input type="date" value={date} onChange={(event) => setDate(event.target.value)} required /></label>
        <button type="submit" disabled={pending || !city.trim()}>{pending ? "Pobieram…" : result ? "Odśwież" : "Sprawdź"}</button>
      </form>
      {error && <p className="error" role="alert">{error}</p>}
      {result && <>
        <p className="dashboard-destination">{result.city} · {result.date}</p>
        <section className="dashboard-cards" aria-label="Informacje o podróży">
          {result.cards.map((card) => {
            const noDataLabel = getDashboardCardNoDataLabel(card);
            return <article className="dashboard-card" key={card.id}>
              <h2>{card.title}</h2>
              {noDataLabel ? <p className="dashboard-card-error"><strong>{noDataLabel}</strong>{card.error ? ` — ${card.error}` : ""}</p> : card.id === "wikipedia" && card.url ? <p>{card.value} <a href={card.url} target="_blank" rel="noreferrer">Czytaj w Wikipedii</a></p> : <p>{card.value}</p>}
              <small>Źródło: {card.source}</small>
              <small>{formatDashboardFetchedAt(card.fetchedAt)}</small>
            </article>;
          })}
        </section>
        <section className="dashboard-summary"><h2>Podsumowanie agenta</h2>
          {result.summary ? <p>{result.summary}</p> : <p role="status">{result.summaryError || "Nie udało się przygotować pełnego podsumowania na podstawie dostępnych danych."}</p>}
        </section>
      </>}
    </main>
  );
}
