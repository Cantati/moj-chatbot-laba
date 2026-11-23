import { convertToModelMessages, generateImage, generateText, isStepCount, Output, streamText, tool } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { z } from "zod";
import { validSessionFromCookieHeader } from "../../../lib/auth";
import { createStudioNovaAnalysisErrorResponse } from "../../../lib/studio-nova-analysis-errors";
import { validateChatRequestMessages } from "../../../lib/agent-chat-validation";
import { cennikUslugInputSchema, pobierzCennikUslug } from "../../../lib/studio-nova-cennik";
import { przygotowanieDoUslugiTool } from "../../../lib/studio-nova-przygotowanie";
import {
  STUDIO_NOVA_ANALYSIS_INSTRUCTIONS,
  STUDIO_NOVA_CHAT_INSTRUCTIONS,
  validateStudioNovaAnalysis,
  studioNovaAnalysisSchema,
  validateStudioNovaAnalysisRequest,
} from "../../../lib/studio-nova";

const imagePromptSchema = z.object({ prompt: z.string().trim().min(1).max(500) });

export async function POST(request: Request) {
  if (!validSessionFromCookieHeader(request.headers.get("cookie"))) {
    return Response.json({ error: "Zaloguj się ponownie, aby kontynuować." }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Nieprawidłowe żądanie." }, { status: 400 });
  }

  if (!body || typeof body !== "object" || !("mode" in body)) {
    return Response.json({ error: "Wymagane jest pole mode: chat albo analyze." }, { status: 400 });
  }

  const mode = body.mode;
  if (mode !== "chat" && mode !== "analyze") {
    return Response.json({ error: "Nieobsługiwany tryb agenta." }, { status: 400 });
  }

  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  const modelId = process.env.OPENROUTER_MODEL?.trim();
  if (!apiKey || !modelId) {
    return Response.json(
      { error: "Brak konfiguracji OpenRouter. Sprawdź ustawienia serwera." },
      { status: 503 },
    );
  }

  if (mode === "analyze") {
    const validatedRequest = validateStudioNovaAnalysisRequest({ message: (body as { message?: unknown }).message });
    if (!validatedRequest.success) {
      const isTooLong = validatedRequest.error.issues.some(
        (issue) => issue.path[0] === "message" && issue.code === "too_big",
      );
      return Response.json(
        {
          error: isTooLong
            ? "Wiadomość jest za długa. Limit to 12 000 znaków."
            : "Nieprawidłowe żądanie analizy. Wymagane jest pole message.",
        },
        { status: isTooLong ? 413 : 400 },
      );
    }

    try {
      const openrouter = createOpenRouter({ apiKey });
      const result = await generateText({
        model: openrouter(modelId),
        instructions: STUDIO_NOVA_ANALYSIS_INSTRUCTIONS,
        prompt: validatedRequest.data.message.trim(),
        output: Output.object({
          schema: studioNovaAnalysisSchema,
          name: "studio_nova_message_analysis",
        }),
        providerOptions: {
          openrouter: {
            provider: { require_parameters: true },
          },
        },
        abortSignal: request.signal,
      });

      const validated = validateStudioNovaAnalysis(result.output);
      if (!validated.success) {
        return Response.json(
          { error: "Wynik modelu nie przeszedł walidacji. Nie utworzono wyniku analizy." },
          { status: 502 },
        );
      }

      return Response.json(validated.data, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      return createStudioNovaAnalysisErrorResponse(error, request);
    }
  }

  const chatBody = body as { messages?: unknown };
  const validatedMessages = await validateChatRequestMessages(chatBody.messages);
  if (!validatedMessages.success) {
    return Response.json({ error: validatedMessages.error }, { status: validatedMessages.status });
  }

  try {
    const openrouter = createOpenRouter({ apiKey });
    let responseModelId: string | undefined;
    const result = streamText({
      model: openrouter(modelId),
      instructions: `${STUDIO_NOVA_CHAT_INSTRUCTIONS}\n\nJeśli użytkownik wyraźnie prosi o stworzenie, narysowanie lub wygenerowanie obrazu, użyj narzędzia generateImage.`,
      messages: await convertToModelMessages(validatedMessages.messages),
      onStepFinish: ({ response }) => {
        responseModelId = response.modelId;
      },
      tools: {
        web_search: openrouter.tools.webSearch({ maxResults: 3, engine: "native" }),
        aktualnyCzas: tool({
          description:
            "Zwraca aktualną datę, dzień tygodnia i godzinę w strefie Europe/Warsaw. Użyj tego narzędzia, gdy użytkownik pyta o dziś, teraz, jutro, konkretny dzień lub datę względną, na przykład: „za ile dni”, „którego dnia” albo „jaka będzie data”. Pobierz bieżący czas przed obliczeniem odpowiedzi zamiast zgadywać.",
          inputSchema: z.object({}),
          execute: async () => {
            const now = new Date();
            const timeZone = "Europe/Warsaw";
            return {
              date: new Intl.DateTimeFormat("pl-PL", { timeZone, day: "2-digit", month: "2-digit", year: "numeric" }).format(now),
              weekday: new Intl.DateTimeFormat("pl-PL", { timeZone, weekday: "long" }).format(now),
              time: new Intl.DateTimeFormat("pl-PL", { timeZone, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(now),
              timeZone,
            };
          },
        }),
        cennikUslug: tool({
          description:
            "Pobiera potwierdzone informacje Studio Nova o konsultacji online. Wywołaj narzędzie, gdy użytkownik pyta o cenę, koszt, czas trwania lub ofertę tej konsultacji. Nie używaj go do pytań o inne usługi, rabaty ani dostępne terminy.",
          inputSchema: cennikUslugInputSchema,
          execute: async (input) => pobierzCennikUslug(input),
        }),
        przygotowanieDoUslugi: przygotowanieDoUslugiTool,
        generateImage: tool({
          description: "Wygeneruj obraz na podstawie opisu użytkownika, gdy wyraźnie prosi o obraz, ilustrację, grafikę lub rysunek. Opis musi mieć maksymalnie 500 znaków.",
          inputSchema: imagePromptSchema,
          execute: async ({ prompt }) => {
            const imageResult = await generateImage({
              model: openrouter.imageModel("google/gemini-3.1-flash-image-preview"),
              prompt,
              n: 1,
            });
            const imageModelId = imageResult.calls[0]?.response.modelId;
            if (!imageModelId) throw new Error("Nie udało się potwierdzić modelu obrazu.");
            return {
              image: imageResult.image.base64,
              mediaType: imageResult.image.mediaType,
              modelId: imageModelId,
            };
          },
          toModelOutput: () => ({ type: "text", value: "obraz wygenerowany" }),
        }),
      },
      stopWhen: isStepCount(5),
    });

    return result.toUIMessageStreamResponse({
      sendSources: true,
      messageMetadata: ({ part }) =>
        part.type === "finish"
          ? {
              retrievedAt: new Date().toISOString(),
              ...(responseModelId ? { modelId: responseModelId } : {}),
            }
          : undefined,
      onError: () => "Wystąpił błąd podczas łączenia z OpenRouter. Sprawdź konfigurację i spróbuj ponownie.",
    });
  } catch {
    return Response.json(
      { error: "Nie udało się przygotować rozmowy. Sprawdź konfigurację i spróbuj ponownie." },
      { status: 500 },
    );
  }
}
