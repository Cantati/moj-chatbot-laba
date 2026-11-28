import { embedMany } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { requireActiveSession } from "../../../lib/auth";
import { createKnowledgeRepository } from "../../../lib/knowledge-base";
import { getSupabaseClient, normalizeInt8Id } from "../../../lib/supabase";

export async function POST(request: Request) {
  const unauthorized = requireActiveSession(request.headers.get("cookie"));
  if (unauthorized) return unauthorized;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Wpisz tytuł i treść dokumentu." }, { status: 400 });
  }

  const values = body && typeof body === "object" ? body as { title?: unknown; content?: unknown } : {};
  const title = typeof values.title === "string" ? values.title.trim() : "";
  const content = typeof values.content === "string" ? values.content.trim() : "";
  if (!title) return Response.json({ error: "Wpisz tytuł dokumentu." }, { status: 400 });
  if (!content) return Response.json({ error: "Wpisz treść dokumentu." }, { status: 400 });
  if (content.length > 20_000) {
    return Response.json({ error: "Treść może mieć maksymalnie 20 000 znaków." }, { status: 413 });
  }

  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  const embeddingModelId = process.env.OPENROUTER_EMBEDDING_MODEL?.trim();
  if (!apiKey || !embeddingModelId) {
    return Response.json(
      { error: "Brak konfiguracji embeddingów. Ustaw OPENROUTER_API_KEY i OPENROUTER_EMBEDDING_MODEL po stronie serwera." },
      { status: 503 },
    );
  }

  try {
    const openrouter = createOpenRouter({ apiKey });
    const embeddingModel = openrouter.textEmbeddingModel(embeddingModelId);
    const saved = await createKnowledgeRepository(
      getSupabaseClient(),
      normalizeInt8Id,
      async (values) => (await embedMany({ model: embeddingModel, values })).embeddings,
    ).saveDocument(title, content);
    return Response.json({ title, chunkCount: saved.chunkCount }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json(
      { error: "Nie udało się wygenerować embeddingów lub zapisać dokumentu. Nowy dokument nie został dodany; spróbuj ponownie." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
