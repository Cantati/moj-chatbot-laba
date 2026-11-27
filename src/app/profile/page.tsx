"use client";

import { useEffect, useState } from "react";

type Profile = { id: string; name: string | null; preferences: Record<string, unknown> };

function profileDrafts(preferences: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(preferences).map(([key, value]) => [
    key,
    typeof value === "string" ? value : JSON.stringify(value) ?? "",
  ]));
}

export default function ProfilePage() {
  const [authenticated, setAuthenticated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [profile, setProfile] = useState<Profile | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [preferenceDrafts, setPreferenceDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let active = true;
    async function loadProfile() {
      try {
        const sessionResponse = await fetch("/api/auth/session", { cache: "no-store" });
        const session = sessionResponse.ok
          ? (await sessionResponse.json()) as { authenticated?: boolean }
          : { authenticated: false };
        if (!active) return;
        if (session.authenticated !== true) {
          setError("Zaloguj się, aby zobaczyć i edytować profil.");
          return;
        }

        setAuthenticated(true);
        const response = await fetch("/api/profile", { cache: "no-store" });
        const data = (await response.json()) as { error?: string; profile?: Profile | null };
        if (!response.ok) throw new Error(data.error ?? "Nie udało się wczytać profilu.");
        if (!active) return;
        const nextProfile = data.profile ?? null;
        setProfile(nextProfile);
        setNameDraft(nextProfile?.name ?? "");
        setPreferenceDrafts(profileDrafts(nextProfile?.preferences ?? {}));
      } catch (loadError) {
        if (active) setError(loadError instanceof Error ? loadError.message : "Nie udało się wczytać profilu.");
      } finally {
        if (active) setLoading(false);
      }
    }

    void loadProfile();
    return () => { active = false; };
  }, []);

  async function applyChange(key: string, url: string, request: RequestInit, successMessage: string) {
    if (!authenticated || busy) return;
    setBusy(key);
    setError("");
    setNotice("");
    try {
      const response = await fetch(url, request);
      const data = (await response.json()) as { error?: string; profile?: Profile | null };
      if (!response.ok) throw new Error(data.error ?? "Nie udało się zapisać zmian profilu.");
      const nextProfile = data.profile ?? null;
      setProfile(nextProfile);
      setNameDraft(nextProfile?.name ?? "");
      setPreferenceDrafts(profileDrafts(nextProfile?.preferences ?? {}));
      setNotice(successMessage);
    } catch (changeError) {
      setError(changeError instanceof Error ? changeError.message : "Nie udało się zapisać zmian profilu.");
    } finally {
      setBusy("");
    }
  }

  function saveName() {
    return applyChange("name", "/api/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "name", value: nameDraft }),
    }, "Imię zostało zapisane.");
  }

  function clearProfile() {
    return applyChange("clear", "/api/profile", { method: "DELETE" }, "Profil został wyczyszczony.");
  }

  async function removeEntry(key: string, label: string) {
    const query = key === "name" ? "entry=name" : `preference=${encodeURIComponent(key)}`;
    await applyChange(key, `/api/profile?${query}`, { method: "DELETE" }, `Usunięto: ${label}.`);
  }

  async function updatePreference(key: string) {
    await applyChange(key, "/api/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "preference", key, value: preferenceDrafts[key] ?? "" }),
    }, `Zaktualizowano: ${key}.`);
  }

  return (
    <main className="profile-page">
      <header className="profile-header">
        <div>
          <p className="profile-eyebrow">Pamięć użytkownika</p>
          <h1>Profil</h1>
        </div>
        <a href="/">Powrót do czatu</a>
      </header>

      {loading && <p className="status" role="status">Wczytuję profil…</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {!authenticated && !loading && <p><a href="/">Przejdź do logowania</a></p>}
      {notice && <p className="profile-notice" role="status">{notice}</p>}

      {authenticated && !loading && (
        <>
          <section className="profile-section" aria-labelledby="profile-name-heading">
            <h2 id="profile-name-heading">Imię</h2>
            {profile?.name && <p className="profile-saved-value">Zapisane imię: <strong>{profile.name}</strong></p>}
            <form className="profile-edit-row" onSubmit={(event) => { event.preventDefault(); void saveName(); }}>
              <label className="sr-only" htmlFor="profile-name">Imię</label>
              <input id="profile-name" value={nameDraft} onChange={(event) => setNameDraft(event.target.value)} maxLength={120} placeholder="Wpisz imię" />
              <button type="submit" disabled={!nameDraft.trim() || busy !== ""}>{busy === "name" ? "Zapisuję…" : "Zapisz imię"}</button>
              {profile?.name && <button className="profile-delete-button" type="button" disabled={busy !== ""} onClick={() => void removeEntry("name", "imię")}>Usuń imię</button>}
            </form>
          </section>

          <section className="profile-section" aria-labelledby="profile-preferences-heading">
            <h2 id="profile-preferences-heading">Preferencje</h2>
            {Object.entries(profile?.preferences ?? {}).length === 0 ? (
              <p className="profile-empty">Brak zapisanych preferencji.</p>
            ) : (
              <ul className="profile-preference-list">
                {Object.entries(profile?.preferences ?? {}).map(([key, value]) => (
                  <li className="profile-preference" key={key}>
                    <label htmlFor={`preference-${key}`}>{key}</label>
                    <div className="profile-edit-row">
                      <input
                        id={`preference-${key}`}
                        value={preferenceDrafts[key] ?? ""}
                        onChange={(event) => setPreferenceDrafts((current) => ({ ...current, [key]: event.target.value }))}
                        maxLength={120}
                      />
                      <button type="button" disabled={!preferenceDrafts[key]?.trim() || busy !== ""} onClick={() => void updatePreference(key)}>
                        {busy === key ? "Zapisuję…" : "Zapisz"}
                      </button>
                      <button className="profile-delete-button" type="button" disabled={busy !== ""} onClick={() => void removeEntry(key, key)}>Usuń</button>
                    </div>
                    {typeof value !== "string" && <small>Wartość była zapisana jako JSON; edycja zapisze ją jako tekst.</small>}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <button className="profile-clear-button" type="button" disabled={busy !== "" || (!profile?.name && Object.keys(profile?.preferences ?? {}).length === 0)} onClick={() => void clearProfile()}>
            {busy === "clear" ? "Wyczyszczam…" : "Wyczyść cały profil"}
          </button>
        </>
      )}
    </main>
  );
}
