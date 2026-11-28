import type { SupabaseClient } from "@supabase/supabase-js";

type KnowledgeDatabase = Pick<SupabaseClient, "from">;
type EmbeddingGenerator = (values: string[]) => Promise<number[][]>;
const EMBEDDING_DIMENSIONS = 1536;
const CHUNK_PAGE_SIZE = 1000;

export function splitKnowledgeTextIntoChunks(content: string, maxLength = 800): string[] {
  const paragraphs = content
    .split(/\r?\n(?:[\t ]*\r?\n)+/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const chunks: string[] = [];

  for (const paragraph of paragraphs) {
    if (paragraph.length <= maxLength) {
      chunks.push(paragraph);
      continue;
    }

    const sentences = paragraph.split(/(?<=[.!?])\s+/u).filter(Boolean);
    let current = "";
    for (const sentence of sentences) {
      const next = current ? `${current} ${sentence}` : sentence;
      if (current && next.length > maxLength) {
        chunks.push(current);
        current = sentence;
      } else {
        current = next;
      }
    }
    if (current) chunks.push(current);
  }

  return chunks;
}

export function createKnowledgeRepository(
  client: KnowledgeDatabase,
  normalizeId: (value: unknown) => string,
  generateEmbeddings: EmbeddingGenerator,
) {
  return {
    async saveDocument(title: string, content: string) {
      const chunks = splitKnowledgeTextIntoChunks(content);
      const pendingChunks: Array<{ id: string; content: string }> = [];

      for (let offset = 0; ; offset += CHUNK_PAGE_SIZE) {
        const { data, error } = await client
          .from("chunks")
          .select("id,content")
          .is("embedding", null)
          .order("id", { ascending: true })
          .range(offset, offset + CHUNK_PAGE_SIZE - 1);
        if (error || !Array.isArray(data)) {
          throw new Error("Nie udało się odczytać fragmentów bez embeddingów.");
        }

        for (const row of data) {
          if (!row || typeof row !== "object" || typeof row.content !== "string") {
            throw new Error("Supabase zwrócił nieprawidłowy fragment.");
          }
          pendingChunks.push({ id: normalizeId(row.id), content: row.content });
        }
        if (data.length < CHUNK_PAGE_SIZE) break;
      }

      const { data: document, error: documentError } = await client
        .from("documents")
        .insert({ title })
        .select("id")
        .single();

      if (documentError || !document || document.id === undefined || document.id === null) {
        throw new Error("Nie udało się zapisać dokumentu.");
      }

      const documentId = normalizeId(document.id);
      try {
        const allTexts = [...chunks, ...pendingChunks.map((chunk) => chunk.content)];
        const embeddings = await generateEmbeddings(allTexts);
        if (
          embeddings.length !== allTexts.length ||
          embeddings.some((embedding) =>
            !Array.isArray(embedding) ||
            embedding.length !== EMBEDDING_DIMENSIONS ||
            embedding.some((value) => typeof value !== "number" || !Number.isFinite(value)),
          )
        ) {
          throw new Error("Model zwrócił embedding o nieprawidłowym wymiarze.");
        }

        const newRows = chunks.map((chunk, chunkIndex) => ({
          document_id: documentId,
          chunk_index: chunkIndex,
          content: chunk,
          embedding: embeddings[chunkIndex],
        }));
        const { error: insertError } = await client.from("chunks").insert(newRows);
        if (insertError) throw new Error("Nie udało się zapisać fragmentów dokumentu.");

        for (let index = 0; index < pendingChunks.length; index += 1) {
          const { error: updateError } = await client
            .from("chunks")
            .update({ embedding: embeddings[chunks.length + index] })
            .eq("id", pendingChunks[index].id)
            .is("embedding", null);
          if (updateError) throw new Error("Nie udało się uzupełnić istniejących embeddingów.");
        }
      } catch {
        try { await client.from("chunks").delete().eq("document_id", documentId); } catch { /* continue cleanup */ }
        try { await client.from("documents").delete().eq("id", documentId); } catch { /* preserve the import error */ }
        throw new Error("Nie udało się wygenerować lub zapisać embeddingów. Nowy dokument nie został dodany.");
      }

      return { id: documentId, chunkCount: chunks.length };
    },
  };
}
