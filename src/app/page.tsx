"use client";

import { useChat } from "@ai-sdk/react";
import { useEffect, useRef, useState, type FormEvent } from "react";

type AnalysisResult = {
  category: "sales" | "support" | "billing" | "unknown";
  priority: "normal" | "high";
  draft: string;
  needs_review: boolean;
};

export default function Home() {
  const [authenticated, setAuthenticated] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [authPending, setAuthPending] = useState(false);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<"chat" | "analysis">("chat");
  const [analysisPending, setAnalysisPending] = useState(false);
  const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null);
  const [analysisError, setAnalysisError] = useState("");
  const analysisController = useRef<AbortController | null>(null);
  const { messages, sendMessage, status, error, clearError, setMessages, stop } = useChat();
  const isWaiting = status === "submitted" || status === "streaming";

  useEffect(() => {
    let active = true;
    fetch("/api/auth/session", { cache: "no-store" })
      .then(async (response) => (response.ok ? response.json() : { authenticated: false }))
      .then((data: { authenticated?: boolean }) => {
        if (active) setAuthenticated(data.authenticated === true);
      })
      .catch(() => {
        if (active) setAuthError("Nie udało się sprawdzić sesji. Odśwież stronę.");
      })
      .finally(() => {
        if (active) setCheckingSession(false);
      });
    return () => { active = false; };
  }, []);

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!password || authPending) return;

    setAuthPending(true);
    setAuthError("");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        setAuthError(data.error ?? "Nie udało się zalogować.");
        return;
      }
      setPassword("");
      setAuthenticated(true);
    } catch {
      setAuthError("Nie udało się połączyć z serwerem. Spróbuj ponownie.");
    } finally {
      setAuthPending(false);
    }
  }

  async function handleLogout() {
    stop();
    analysisController.current?.abort();
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (!response.ok) throw new Error("logout failed");
    } catch {
      setAuthError("Nie udało się zakończyć sesji. Spróbuj ponownie.");
      return;
    }
    setMessages([]);
    clearError();
    setInput("");
    setAuthenticated(false);
    setAuthError("");
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = input.trim();
    if (!text || isWaiting) return;

    clearError();
    setInput("");
    void sendMessage({ text });
  }

  async function handleAnalysisSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = input.trim();
    if (!message || analysisPending) return;

    const controller = new AbortController();
    analysisController.current = controller;
    setAnalysisPending(true);
    setAnalysisResult(null);
    setAnalysisError("");
    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
        signal: controller.signal,
      });
      const data = (await response.json()) as AnalysisResult & { error?: string };
      if (!response.ok) {
        setAnalysisError(data.error ?? "Nie udało się przeanalizować wiadomości.");
        return;
      }
      setAnalysisResult(data);
    } catch (requestError) {
      setAnalysisError(
        requestError instanceof Error && requestError.name === "AbortError"
          ? "Analiza została przerwana. Nie utworzono wyniku."
          : "Nie udało się połączyć z serwerem. Nie utworzono wyniku.",
      );
    } finally {
      if (analysisController.current === controller) analysisController.current = null;
      setAnalysisPending(false);
    }
  }

  function cancelAnalysis() {
    analysisController.current?.abort();
  }

  return (
    <main className="chat">
      {checkingSession ? (
        <p className="status" role="status">Sprawdzam sesję…</p>
      ) : !authenticated ? (
        <>
          <h1>Wpisz hasło</h1>
          <form className="auth-form" onSubmit={handleLogin}>
            <label className="sr-only" htmlFor="password">Hasło</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              placeholder="Hasło warsztatowe"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={authPending}
            />
            <button type="submit" disabled={!password || authPending}>
              {authPending ? "Sprawdzam…" : "Wejdź"}
            </button>
          </form>
          {authError && <p className="error" role="alert">{authError}</p>}
        </>
      ) : (
        <>
          <header className="chat-header">
            <h1>Mój chatbot</h1>
            <button className="logout-button" type="button" onClick={handleLogout}>Wyjdź</button>
          </header>
          {authError && <p className="error" role="alert">{authError}</p>}
          <nav className="mode-switch" aria-label="Tryb pracy">
            <button
              className={mode === "chat" ? "mode-button active" : "mode-button"}
              type="button"
              onClick={() => setMode("chat")}
              disabled={isWaiting || analysisPending}
            >
              Zwykły czat
            </button>
            <button
              className={mode === "analysis" ? "mode-button active" : "mode-button"}
              type="button"
              onClick={() => setMode("analysis")}
              disabled={isWaiting || analysisPending}
            >
              Analiza Studio Nova
            </button>
          </nav>
          {mode === "chat" ? (
            <>
          <section className="conversation" aria-label="Rozmowa" aria-live="polite">
            {messages.map((message) => (
              <article className={`message ${message.role}`} key={message.id}>
                <strong>{message.role === "user" ? "Ty" : "Chatbot"}</strong>
                <div>
                  {message.parts.map((part, index) =>
                    part.type === "text" ? <span key={index}>{part.text}</span> : null,
                  )}
                </div>
              </article>
            ))}
            {isWaiting && <p className="status" role="status">Chatbot pisze…</p>}
            {error && (
              <p className="error" role="alert">
                Nie udało się uzyskać odpowiedzi. {error.message}
              </p>
            )}
          </section>
          <form className="message-form" onSubmit={handleSubmit}>
            <label className="sr-only" htmlFor="message">Wiadomość</label>
            <input
              id="message"
              name="message"
              type="text"
              placeholder="Napisz wiadomość…"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              disabled={isWaiting}
            />
            <button type="submit" disabled={!input.trim() || isWaiting}>
              {isWaiting ? "Czekaj…" : "Wyślij"}
            </button>
          </form>
            </>
          ) : (
            <section className="analysis-panel" aria-label="Analiza wiadomości Studio Nova">
              <p>Wynik pozostaje szkicem. Wiadomości nie są wysyłane.</p>
              <form className="analysis-form" onSubmit={handleAnalysisSubmit}>
                <label htmlFor="analysis-message">Wiadomość klienta</label>
                <textarea
                  id="analysis-message"
                  name="analysis-message"
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  placeholder="Wklej wiadomość do analizy…"
                  maxLength={12000}
                  disabled={analysisPending}
                />
                <div className="analysis-actions">
                  <button type="submit" disabled={!input.trim() || analysisPending || isWaiting}>
                    {analysisPending ? "Analizuję…" : "Analizuj wiadomość"}
                  </button>
                  {analysisPending && (
                    <button className="cancel-button" type="button" onClick={cancelAnalysis}>
                      Przerwij
                    </button>
                  )}
                </div>
              </form>
              {analysisError && <p className="error" role="alert">{analysisError}</p>}
              {analysisPending && <p className="status" role="status">Trwa analiza…</p>}
              {analysisResult && (
                <article className="analysis-result" aria-live="polite">
                  <h2>Wynik analizy</h2>
                  <dl>
                    <div><dt>Kategoria</dt><dd>{analysisResult.category}</dd></div>
                    <div><dt>Priorytet</dt><dd>{analysisResult.priority === "high" ? "Wysoki" : "Normalny"}</dd></div>
                    <div><dt>Szkic odpowiedzi</dt><dd className="analysis-draft">{analysisResult.draft}</dd></div>
                    <div>
                      <dt>Status sprawdzenia</dt>
                      <dd>{analysisResult.needs_review ? "Wymaga sprawdzenia przez pracownika" : "Nie wymaga sprawdzenia według analizy"}</dd>
                    </div>
                  </dl>
                </article>
              )}
            </section>
          )}
        </>
      )}
    </main>
  );
}
