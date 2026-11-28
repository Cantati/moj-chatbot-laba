"use client";

import { useEffect, useState, type FormEvent } from "react";

const MAX_CONTENT_LENGTH = 20_000;

export default function UploadPage() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  useEffect(() => {
    let active = true;
    fetch("/api/auth/session", { cache: "no-store" })
      .then(async (response) => response.ok ? response.json() as Promise<{ authenticated?: boolean }> : { authenticated: false })
      .then((session) => { if (active) setAuthenticated(session.authenticated === true); })
      .catch(() => { if (active) setError("Nie udało się sprawdzić sesji. Odśwież stronę."); })
      .finally(() => { if (active) setAuthenticated((current) => current ?? false); });
    return () => { active = false; };
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const cleanTitle = title.trim();
    const cleanContent = content.trim();
    setError("");
    setSuccess("");
    if (!cleanTitle) { setError("Wpisz tytuł dokumentu."); return; }
    if (!cleanContent) { setError("Wpisz treść dokumentu."); return; }
    if (cleanContent.length > MAX_CONTENT_LENGTH) { setError("Treść może mieć maksymalnie 20 000 znaków."); return; }

    setPending(true);
    try {
      const response = await fetch("/api/knowledge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: cleanTitle, content: cleanContent }),
      });
      const data = await response.json() as { title?: string; chunkCount?: number; error?: string };
      if (!response.ok) throw new Error(data.error ?? "Nie udało się zapisać dokumentu.");
      setSuccess(`Zapisano dokument „${data.title ?? cleanTitle}”: ${data.chunkCount ?? 0} fragmentów`);
      setTitle("");
      setContent("");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Nie udało się zapisać dokumentu. Spróbuj ponownie.");
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="history-page">
      <header className="history-header">
        <div>
          <p className="profile-eyebrow">Własna baza wiedzy</p>
          <h1>Dodaj dokument</h1>
        </div>
        <a href="/">Powrót do czatu</a>
      </header>

      {authenticated === null ? <p className="status" role="status">Sprawdzam sesję…</p> : !authenticated ? (
        <p className="error" role="alert">Zaloguj się, aby dodawać dokumenty. <a href="/">Przejdź do logowania</a>.</p>
      ) : (
        <form className="knowledge-form" onSubmit={handleSubmit}>
          <label htmlFor="knowledge-title">Tytuł</label>
          <input id="knowledge-title" name="title" value={title} onChange={(event) => setTitle(event.target.value)} disabled={pending} />
          <label htmlFor="knowledge-content">Treść</label>
          <textarea id="knowledge-content" name="content" value={content} onChange={(event) => setContent(event.target.value)} maxLength={MAX_CONTENT_LENGTH} rows={14} disabled={pending} />
          <p className="knowledge-counter">{content.length.toLocaleString("pl-PL")} / 20 000 znaków</p>
          <button type="submit" disabled={pending}>{pending ? "Zapisuję…" : "Dodaj do bazy wiedzy"}</button>
        </form>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      {success && <p className="profile-notice" role="status">{success}</p>}
    </main>
  );
}
