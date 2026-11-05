"use client";

import { useChat } from "@ai-sdk/react";
import { useEffect, useState, type FormEvent } from "react";

export default function Home() {
  const [authenticated, setAuthenticated] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [authPending, setAuthPending] = useState(false);
  const [input, setInput] = useState("");
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
      )}
    </main>
  );
}
