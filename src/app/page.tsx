"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type FileUIPart, type UIDataTypes, type UIMessage } from "ai";
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { getToolOutputErrorMessage } from "../lib/agent-tool-errors";

type GeneratedImage = { image: string; mediaType: string; modelId: string };
type StudioNovaPrice = { usluga: string; czasTrwania: string; cena: string };
type ConsultationPreparation = { charakter: string; wskazowki: string[] };
type ChatTools = {
  generateImage: { input: { prompt: string }; output: GeneratedImage };
  cennikUslug: { input: { usluga: "konsultacja online" }; output: StudioNovaPrice };
  przygotowanieDoUslugi: {
    input: {};
    output: ConsultationPreparation;
  };
};
type ChatMessage = UIMessage<{ retrievedAt?: string; modelId?: string }, UIDataTypes, ChatTools>;
const chatTransport = new DefaultChatTransport<ChatMessage>({
  api: "/api/agent",
  body: { mode: "chat" },
});

function getToolNameFromErrorPart(part: unknown): string | null {
  if (!part || typeof part !== "object") return null;
  const value = part as { type?: unknown; state?: unknown; toolName?: unknown };
  if (value.state !== "output-error") return null;
  if (value.type === "dynamic-tool") return typeof value.toolName === "string" ? value.toolName : "narzędzie";
  return typeof value.type === "string" && value.type.startsWith("tool-") ? value.type.slice(5) : null;
}

const MAX_IMAGE_SIZE = 4 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("Nie udało się odczytać zdjęcia."));
    };
    reader.onerror = () => reject(new Error("Nie udało się odczytać zdjęcia."));
    reader.readAsDataURL(file);
  });
}

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
  const [selectedImage, setSelectedImage] = useState<FileUIPart | null>(null);
  const [imageError, setImageError] = useState("");
  const [imageGenerationPending, setImageGenerationPending] = useState(false);
  const [imageGenerationError, setImageGenerationError] = useState("");
  const [mode, setMode] = useState<"chat" | "analysis">("chat");
  const [analysisPending, setAnalysisPending] = useState(false);
  const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null);
  const [analysisError, setAnalysisError] = useState("");
  const analysisController = useRef<AbortController | null>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const { messages, sendMessage, status, error, clearError, setMessages, stop } = useChat<ChatMessage>({
    transport: chatTransport,
  });
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
    if ((!text && !selectedImage) || isWaiting || imageGenerationPending) return;

    clearError();
    setImageError("");
    setInput("");
    const image = selectedImage;
    setSelectedImage(null);
    if (image) {
      void (text ? sendMessage({ text, files: [image] }) : sendMessage({ files: [image] }));
    } else {
      void sendMessage({ text });
    }
  }

  async function handleImageSelection(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
      setImageError("Wybierz zdjęcie w formacie JPG, PNG lub WebP.");
      return;
    }
    if (file.size > MAX_IMAGE_SIZE) {
      setImageError("Zdjęcie może mieć maksymalnie 4 MB.");
      return;
    }

    setImageError("");
    try {
      setSelectedImage({
        type: "file",
        mediaType: file.type,
        filename: file.name,
        url: await readFileAsDataUrl(file),
      });
    } catch {
      setImageError("Nie udało się wczytać zdjęcia. Spróbuj ponownie.");
    }
  }

  async function handleImageGeneration() {
    const prompt = input.trim();
    if (!prompt || prompt.length > 500 || isWaiting || imageGenerationPending) return;

    setImageGenerationPending(true);
    setImageGenerationError("");
    try {
      await sendMessage({ text: `Wygeneruj obraz na podstawie opisu: ${prompt}` });
      setInput("");
    } catch {
      setImageGenerationError("Nie udało się wygenerować obrazu. Spróbuj ponownie.");
    } finally {
      setImageGenerationPending(false);
    }
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
      const response = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "analyze", message }),
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
            {messages.map((message, messageIndex) => {
              const previousMessage = messages[messageIndex - 1];
              const answersImage =
                message.role === "assistant" &&
                previousMessage?.role === "user" &&
                previousMessage.parts.some(
                  (part) => part.type === "file" && part.mediaType.startsWith("image/"),
                );
              const containsImage =
                message.role === "assistant" &&
                message.parts.some((part) => part.type === "file" && part.mediaType.startsWith("image/"));
              const modelId =
                message.role === "assistant" && (answersImage || containsImage)
                  ? message.metadata?.modelId
                  : undefined;
              const sources =
                message.role === "assistant"
                  ? message.parts.filter((part) => part.type === "source-url")
                  : [];
              const toolNames =
                message.role === "assistant"
                  ? message.parts.flatMap((part) => {
                      if (part.type === "dynamic-tool") return [part.toolName];
                      return part.type.startsWith("tool-") ? [part.type.slice(5)] : [];
                    })
                  : [];
              if (sources.length > 0) toolNames.push("web_search");
              const usedTools = Array.from(new Set(toolNames));

              return (
                <article className={`message ${message.role}`} key={message.id}>
                  <strong>{message.role === "user" ? "Ty" : "Chatbot"}</strong>
                  {usedTools.length > 0 && (
                    <div className="tool-badges" aria-label="Użyte narzędzia">
                      {usedTools.map((name) => (
                        <span className="tool-badge" key={name}>
                          {name === "web_search"
                            ? "🔎 wyszukiwanie"
                            : name === "aktualnyCzas"
                              ? "🕒 aktualnyCzas"
                              : name === "cennikUslug"
                                ? "cennikUsług"
                                : name === "przygotowanieDoUslugi"
                                  ? "przygotowanieDoUsługi"
                              : name}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="message-content">
                    {message.parts.map((part, index) => {
                      const toolErrorName = getToolNameFromErrorPart(part);
                      if (toolErrorName) {
                        return (
                          <p className="error" role="alert" key={index}>
                            {getToolOutputErrorMessage(toolErrorName)}
                          </p>
                        );
                      }
                      if (part.type === "text") return <span key={index}>{part.text}</span>;
                      if (part.type === "file" && part.mediaType.startsWith("image/")) {
                        return (
                          <img
                            className="chat-image"
                            key={index}
                            src={part.url}
                            alt={part.filename || "Zdjęcie w rozmowie"}
                            loading="lazy"
                          />
                        );
                      }
                      if (part.type === "tool-generateImage" && part.state === "output-available") {
                        return (
                          <span className="generated-image-result" key={index}>
                            <img
                              className="chat-image"
                              src={`data:${part.output.mediaType};base64,${part.output.image}`}
                              alt="Obraz wygenerowany na podstawie opisu"
                              loading="lazy"
                            />
                            <small className="image-model-id">Model: {part.output.modelId}</small>
                          </span>
                        );
                      }
                      return null;
                    })}
                  </div>
                  {modelId && <small className="image-model-id">Model: {modelId}</small>}
                  {sources.length > 0 && (
                    <section className="message-sources" aria-label="Źródła odpowiedzi">
                      <strong>Źródła</strong>
                      <ul>
                        {sources.map((source, index) => (
                          <li key={`${source.sourceId}-${index}`}>
                            <a href={source.url} target="_blank" rel="noreferrer">
                              {source.title || source.url}
                            </a>
                          </li>
                        ))}
                      </ul>
                      <small>
                        pobrano: {message.metadata?.retrievedAt
                          ? new Date(message.metadata.retrievedAt).toLocaleString("pl-PL", {
                              dateStyle: "short",
                              timeStyle: "short",
                            })
                          : "—"}
                      </small>
                    </section>
                  )}
                </article>
              );
            })}
            {isWaiting && <p className="status" role="status">Chatbot pisze…</p>}
            {error && (
              <p className="error" role="alert">
                Nie udało się uzyskać odpowiedzi. {error.message}
              </p>
            )}
          </section>
          {selectedImage && (
            <div className="selected-image-preview">
              <img src={selectedImage.url} alt="Podgląd wybranego zdjęcia" />
              <span>{selectedImage.filename}</span>
              <button type="button" className="remove-image-button" onClick={() => setSelectedImage(null)}>
                Usuń zdjęcie
              </button>
            </div>
          )}
          {imageError && <p className="error" role="alert">{imageError}</p>}
          {imageGenerationError && <p className="error" role="alert">{imageGenerationError}</p>}
          <form className="message-form" onSubmit={handleSubmit}>
            <label className="sr-only" htmlFor="message">Wiadomość</label>
            <input
              id="message"
              name="message"
              type="text"
              placeholder="Napisz wiadomość…"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              disabled={isWaiting || imageGenerationPending}
            />
            <input
              ref={imageInputRef}
              className="sr-only"
              type="file"
              accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
              onChange={handleImageSelection}
              tabIndex={-1}
              aria-hidden="true"
            />
            <button
              type="button"
              className="image-action-button"
              onClick={() => imageInputRef.current?.click()}
              disabled={isWaiting || imageGenerationPending}
            >
              Dodaj zdjęcie
            </button>
            <button
              type="button"
              className="image-action-button"
              onClick={() => void handleImageGeneration()}
              disabled={!input.trim() || input.trim().length > 500 || isWaiting || imageGenerationPending}
            >
              {imageGenerationPending ? "Generuję…" : "Wygeneruj obraz"}
            </button>
            <button type="submit" disabled={(!input.trim() && !selectedImage) || isWaiting || imageGenerationPending}>
              {isWaiting ? "Czekaj…" : "Wyślij"}
            </button>
          </form>
          <p className="image-prompt-hint">Opis do generowania obrazu: maksymalnie 500 znaków.</p>
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
                    {analysisPending ? "Analizuję…" : "Analiza JSON"}
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
