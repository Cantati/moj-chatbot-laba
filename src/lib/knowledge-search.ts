export type KnowledgeMatch = {
  title: string;
  content: string;
  similarity: number;
};

type EmbeddingClient = {
  rpc: (functionName: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
};

export type KnowledgeSearchStage = "konfiguracja" | "embedding" | "RPC" | "przetwarzanie_wynikow";
export type KnowledgeSearchDiagnostic = {
  stage: KnowledgeSearchStage;
  success: boolean;
  code?: string;
  httpStatus?: number;
};
type DiagnosticReporter = (diagnostic: KnowledgeSearchDiagnostic) => void;

const EMBEDDING_DIMENSIONS = 1536;
const MATCH_COUNT = 3;
const SEARCH_ERROR = "Nie udało się przeszukać bazy wiedzy. Spróbuj ponownie.";

function safeDiagnostic(stage: KnowledgeSearchStage, success: boolean, error?: unknown): KnowledgeSearchDiagnostic {
  const diagnostic: KnowledgeSearchDiagnostic = { stage, success };
  if (!error || typeof error !== "object") return diagnostic;

  const record = error as Record<string, unknown>;
  const code = typeof record.code === "string" ? record.code : undefined;
  if (code && (/^PGRST\d{3}$/.test(code) || /^(?:ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|INVALID_DIMENSION|INVALID_RESPONSE|INVALID_RESULT_ROW|MISSING_EMBEDDING_MODEL)$/.test(code))) {
    diagnostic.code = code;
  }
  const status = typeof record.status === "number" ? record.status : record.statusCode;
  if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) {
    diagnostic.httpStatus = status;
  }
  return diagnostic;
}

export function reportKnowledgeSearchDiagnostic(stage: KnowledgeSearchStage, success: boolean, error?: unknown) {
  if (process.env.NODE_ENV !== "development") return;
  const detail = safeDiagnostic(stage, success, error);
  const parts = [
    `[searchKnowledge] etap=${detail.stage}`,
    `powodzenie=${detail.success ? "tak" : "nie"}`,
  ];
  if (detail.code) parts.push(`kod=${detail.code}`);
  if (detail.httpStatus) parts.push(`http=${detail.httpStatus}`);
  const message = parts.join(" ");
  if (success) console.info(message);
  else console.warn(message);
}

export const KNOWLEDGE_SEARCH_INSTRUCTIONS = `
Gdy użytkownik pyta o firmę Kwantowy Borsuk, jej ofertę, ceny, zasady lub regulamin, zawsze najpierw użyj narzędzia searchKnowledge. Odpowiadaj wyłącznie na podstawie treści fragmentów zwróconych przez to narzędzie. Nie korzystaj przy tych pytaniach z wiedzy ogólnej modelu ani wyszukiwania internetowego.
Sprawdź, czy znaleziony fragment rzeczywiście zawiera odpowiedź. Podobieństwo tematu nie jest dowodem. Nie zgaduj ani nie uzupełniaj brakujących danych.
Po odpowiedzi opartej na fragmencie dopisz osobną linię w formacie: Źródło: [tytuł dokumentu]. Jeśli używasz kilku dokumentów, podaj osobną linię źródła dla każdego.
Jeśli fragmenty nie zawierają odpowiedzi, napisz dokładnie: "Nie mam tej informacji w bazie wiedzy" i zaproponuj, jaki dokument lub informację można dodać.
Jeśli wyszukiwanie się nie powiedzie, poinformuj o problemie i nie wymyślaj odpowiedzi.
Instrukcje dotyczące firmy Kwantowy Borsuk dotyczą tylko tej firmy. Osobny tryb Analiza Studio Nova zachowuje własne instrukcje i nie zastępuje informacji o Kwantowym Borsuku.
`;

export function createKnowledgeSearchService(
  client: EmbeddingClient,
  embedQuestion: (question: string) => Promise<number[]>,
  report: DiagnosticReporter = (event) => reportKnowledgeSearchDiagnostic(event.stage, event.success, event),
) {
  const notify = (stage: KnowledgeSearchStage, success: boolean, error?: unknown) => {
    report(safeDiagnostic(stage, success, error));
  };

  return async (question: string) => {
    const normalizedQuestion = question.trim();
    if (!normalizedQuestion) return { error: "Wpisz pytanie, aby przeszukać bazę wiedzy." };

    let embedding: number[];
    try {
      embedding = await embedQuestion(normalizedQuestion);
    } catch (error) {
      notify("embedding", false, error);
      return { error: SEARCH_ERROR };
    }
    if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_DIMENSIONS || embedding.some((value) => !Number.isFinite(value))) {
      notify("embedding", false, { code: "INVALID_DIMENSION" });
      return { error: SEARCH_ERROR };
    }
    notify("embedding", true);

    let data: unknown;
    try {
      const result = await client.rpc("match_chunks", {
        query_embedding: embedding,
        match_count: MATCH_COUNT,
      });
      if (result.error) {
        notify("RPC", false, result.error);
        return { error: SEARCH_ERROR };
      }
      data = result.data;
    } catch (error) {
      notify("RPC", false, error);
      return { error: SEARCH_ERROR };
    }
    if (!Array.isArray(data)) {
      notify("RPC", false, { code: "INVALID_RESPONSE" });
      return { error: SEARCH_ERROR };
    }
    notify("RPC", true);

    try {
      const candidateRows = data.slice(0, MATCH_COUNT);
      const matches = candidateRows.flatMap((row): KnowledgeMatch[] => {
        if (!row || typeof row !== "object") return [];
        const item = row as Record<string, unknown>;
        if (
          typeof item.title !== "string" ||
          typeof item.content !== "string" ||
          typeof item.similarity !== "number" ||
          !Number.isFinite(item.similarity)
        ) return [];
        return [{ title: item.title, content: item.content, similarity: item.similarity }];
      });
      if (matches.length !== candidateRows.length) {
        notify("przetwarzanie_wynikow", false, { code: "INVALID_RESULT_ROW" });
        return { error: SEARCH_ERROR };
      }
      notify("przetwarzanie_wynikow", true);
      const titles = [...new Set(matches.map(({ title }) => title))];

      return {
        matches,
        sources: titles.map((title) => `Źródło: ${title}`),
        noAnswer: matches.length === 0
          ? "Nie mam tej informacji w bazie wiedzy. Możesz dodać odpowiedni dokument lub fragment do bazy wiedzy."
          : undefined,
      };
    } catch (error) {
      notify("przetwarzanie_wynikow", false, error);
      return { error: SEARCH_ERROR };
    }
  };
}
