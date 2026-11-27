"use client";

import { useEffect, useState } from "react";

type Conversation = { id: string; title: string; createdAt: string; messageCount: number };

export default function HistoryPage() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;

    async function loadHistory() {
      try {
        const sessionResponse = await fetch("/api/auth/session", { cache: "no-store" });
        const session = sessionResponse.ok
          ? (await sessionResponse.json()) as { authenticated?: boolean }
          : { authenticated: false };
        if (!active) return;
        if (session.authenticated !== true) {
          setAuthenticated(false);
          setError("Zaloguj się, aby zobaczyć zapisane rozmowy.");
          return;
        }

        setAuthenticated(true);
        const response = await fetch("/api/conversations?view=list", { cache: "no-store" });
        const data = (await response.json()) as { error?: string; conversations?: Conversation[] };
        if (!response.ok) throw new Error(data.error ?? "Nie udało się wczytać historii rozmów.");
        if (active) setConversations(Array.isArray(data.conversations) ? data.conversations : []);
      } catch (loadError) {
        if (active) setError(loadError instanceof Error ? loadError.message : "Nie udało się wczytać historii rozmów.");
      } finally {
        if (active) setLoading(false);
      }
    }

    void loadHistory();
    return () => { active = false; };
  }, []);

  async function startNewConversation() {
    if (!authenticated || creating) return;
    setCreating(true);
    setError("");
    try {
      const response = await fetch("/api/conversations", { method: "POST" });
      const data = (await response.json()) as { error?: string; conversation?: { id?: string } };
      if (!response.ok || !data.conversation?.id) {
        throw new Error(data.error ?? "Nie udało się rozpocząć nowej rozmowy.");
      }
      window.location.assign(`/?conversationId=${encodeURIComponent(data.conversation.id)}`);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Nie udało się rozpocząć nowej rozmowy.");
      setCreating(false);
    }
  }

  return (
    <main className="history-page">
      <header className="history-header">
        <div>
          <p className="history-eyebrow">Zapisane rozmowy</p>
          <h1>Historia</h1>
        </div>
        <div className="history-actions">
          <a href="/">Powrót do czatu</a>
          <button type="button" onClick={() => void startNewConversation()} disabled={!authenticated || creating || loading}>
            {creating ? "Tworzę…" : "Nowa rozmowa"}
          </button>
        </div>
      </header>

      {loading && <p className="status" role="status">Wczytuję historię…</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {!loading && authenticated && conversations.length === 0 && !error && (
        <p className="history-empty">Nie ma jeszcze zapisanych rozmów.</p>
      )}
      {conversations.length > 0 && (
        <ul className="history-list">
          {conversations.map((conversation) => (
            <li key={conversation.id}>
              <a className="history-item" href={`/?conversationId=${encodeURIComponent(conversation.id)}`}>
                <strong>{conversation.title}</strong>
                <span>
                  {new Date(conversation.createdAt).toLocaleString("pl-PL", { dateStyle: "medium", timeStyle: "short" })}
                  {" · "}{conversation.messageCount} {conversation.messageCount === 1 ? "wiadomość" : "wiadomości"}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
