import { convertToModelMessages, generateImage, generateText, isStepCount, Output, streamText, tool } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { z } from "zod";
import { validSessionFromCookieHeader } from "../../../lib/auth";
import { createStudioNovaAnalysisErrorResponse } from "../../../lib/studio-nova-analysis-errors";
import { validateChatRequestMessages } from "../../../lib/agent-chat-validation";
import { cennikUslugInputSchema, pobierzCennikUslug } from "../../../lib/studio-nova-cennik";
import { przygotowanieDoUslugiTool } from "../../../lib/studio-nova-przygotowanie";
import { createWorkshopTools } from "../../../lib/workshop-tools";
import { createConversationRepository, getSupabaseClient } from "../../../lib/supabase";
import { completeProfileInputFromLatestMessage, profileInstructions, rememberUserProfileInputSchema, validateExplicitProfileFacts } from "../../../lib/user-profile";
import {
  STUDIO_NOVA_ANALYSIS_INSTRUCTIONS,
  STUDIO_NOVA_CHAT_INSTRUCTIONS,
  validateStudioNovaAnalysis,
  studioNovaAnalysisSchema,
  validateStudioNovaAnalysisRequest,
} from "../../../lib/studio-nova";

const imagePromptSchema = z.object({ prompt: z.string().trim().min(1).max(500) });
const MAX_AGENT_STEPS = 6;

function summarizeToolResult(toolName: string, output: unknown) {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return toolName + ": narzędzie zostało wykonane.";
  }
  const result = output as Record<string, unknown>;
  if (typeof result.error === "string") return toolName + ": " + result.error;

  const fieldsByTool: Record<string, string[]> = {
    pogoda: ["city", "date", "weather", "temperatureMaxC", "temperatureMinC", "precipitationProbabilityMaxPercent"],
    waluty: ["code", "rateToPLN", "amount", "amountPLN", "rateDate"],
    swieta: ["countryCode", "year"],
    wikipedia: ["title", "description", "url"],
    kalkulator: ["operation", "a", "b", "result"],
    aktualnyCzas: ["date", "weekday", "time", "timeZone"],
    cennikUslug: ["usluga", "czasTrwania", "cena"],
    diagnostyka: ["model", "stepLimit"],
    zapamietajProfil: ["confirmation"],
  };
  const details = (fieldsByTool[toolName] ?? [])
    .filter((key) => ["string", "number", "boolean"].includes(typeof result[key]))
    .map((key) => key + ": " + String(result[key]));
  if (toolName === "swieta" && Array.isArray(result.holidays)) {
    const holidays = result.holidays.slice(0, 3).flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const holiday = item as { date?: unknown; name?: unknown };
      return typeof holiday.date === "string" ? [holiday.date + (typeof holiday.name === "string" ? " " + holiday.name : "")] : [];
    });
    details.push("liczba świąt: " + result.holidays.length);
    if (holidays.length) details.push("przykłady: " + holidays.join(", "));
  }
  if (toolName === "wikipedia" && typeof result.summary === "string") {
    details.push("streszczenie: " + result.summary.slice(0, 300));
  }
  if (toolName === "przygotowanieDoUslugi" && Array.isArray(result.wskazowki)) {
    details.push(...result.wskazowki.filter((item): item is string => typeof item === "string").slice(0, 4));
  }
  if (toolName === "notatki") {
    if (typeof result.message === "string") details.push(result.message);
    if (Array.isArray(result.notes)) details.push("liczba zapisanych notatek: " + result.notes.length);
    if (result.note && typeof result.note === "object" && typeof (result.note as { text?: unknown }).text === "string") {
      details.push("zapisana notatka: " + (result.note as { text: string }).text.slice(0, 200));
    }
  }
  if (toolName === "generateImage") details.push("obraz wygenerowany");
  return toolName + (details.length ? ": " + details.join(", ") : ": narzędzie zostało wykonane.");
}

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

  const chatBody = body as { messages?: unknown; conversationId?: unknown };
  const validatedMessages = await validateChatRequestMessages(chatBody.messages);
  if (!validatedMessages.success) {
    return Response.json({ error: validatedMessages.error }, { status: validatedMessages.status });
  }

  const conversationId = z.string().trim().min(1).max(128).safeParse(chatBody.conversationId);
  if (!conversationId.success) {
    return Response.json({ error: "Rozpocznij rozmowę ponownie przed wysłaniem wiadomości." }, { status: 400 });
  }
  const userMessage = validatedMessages.messages.at(-1);
  if (!userMessage || userMessage.role !== "user") {
    return Response.json({ error: "Nie znaleziono nowej wiadomości użytkownika." }, { status: 400 });
  }

  let conversationRepository: ReturnType<typeof createConversationRepository>;
  let userProfile: Awaited<ReturnType<ReturnType<typeof createConversationRepository>["getUserProfile"]>>;
  try {
    conversationRepository = createConversationRepository(getSupabaseClient());
    userProfile = await conversationRepository.getUserProfile();
    await conversationRepository.saveMessage(conversationId.data, "user", userMessage);
  } catch {
    return Response.json({ error: "Nie udało się wczytać pamięci profilu ani przygotować rozmowy." }, { status: 503 });
  }

  try {
    const openrouter = createOpenRouter({ apiKey });
    const workshopTools = createWorkshopTools({
      modelId,
      environment: {
        openrouterApiKey: Boolean(process.env.OPENROUTER_API_KEY?.trim()),
        openrouterModel: Boolean(process.env.OPENROUTER_MODEL?.trim()),
        chatPassword: Boolean(process.env.CHAT_PASSWORD?.length),
        sessionSecret: Boolean(process.env.SESSION_SECRET?.trim() && Buffer.byteLength(process.env.SESSION_SECRET.trim()) >= 32),
      },
    });
    let responseModelId: string | undefined;
    const agentSteps: Array<{ number: number; tools: string[] }> = [];
    const limitFindings: string[] = [];
    let limitReached = false;
    const result = streamText({
      model: openrouter(modelId),
      instructions: [
        STUDIO_NOVA_CHAT_INSTRUCTIONS,
        profileInstructions(userProfile),
        "Przy zadaniu złożonym pracuj krok po kroku: użyj narzędzia, przeczytaj jego wynik i dopiero wtedy zdecyduj o następnym kroku. Nie zgaduj danych, które możesz sprawdzić.",
        "Jeśli użytkownik wyraźnie prosi o stworzenie, narysowanie lub wygenerowanie obrazu, użyj narzędzia generateImage.",
      ].join("\n\n"),
      messages: await convertToModelMessages(validatedMessages.messages),
      onStepFinish: ({ response, stepNumber, toolCalls, toolResults, sources, text, finishReason }) => {
        responseModelId = response.modelId;
        const calledTools = toolCalls.map((call) => call.toolName);
        if (sources.length > 0 && !calledTools.includes("web_search")) calledTools.push("web_search");
        if (calledTools.length > 0) agentSteps.push({ number: stepNumber + 1, tools: calledTools });
        for (const toolResult of toolResults) {
          limitFindings.push(summarizeToolResult(toolResult.toolName, toolResult.output));
        }
        if (sources.length > 0) {
          limitFindings.push("wyszukiwanie: znaleziono " + sources.length + " źródeł.");
        }
        if (text.trim()) limitFindings.push(text.trim().slice(0, 500));
        if (stepNumber + 1 >= MAX_AGENT_STEPS && finishReason === "tool-calls") {
          limitReached = true;
        }
      },
      tools: {
        web_search: openrouter.tools.webSearch({ maxResults: 3, engine: "native" }),
        ...workshopTools,
        zapamietajProfil: tool({
          description: "Zapisuje do trwałego profilu jedynie imię, miasto, ulubione jedzenie lub preferowany styl odpowiedzi, które użytkownik podał wprost. Gdy jedna wiadomość zawiera kilka takich faktów, przekaż je wszystkie w jednym wywołaniu narzędzia. Dla każdej wartości podaj krótki, dokładny cytat z wiadomości użytkownika w polu evidence. Nie zapisuj planów, przypuszczeń ani wniosków; nigdy nie zapisuj haseł, kluczy API, sekretów ani innych danych wrażliwych. Nowe wartości uzupełniają profil i nie usuwają pozostałych preferencji. Po udanym zapisie nie wywołuj tego narzędzia ponownie w tym zadaniu — krótko potwierdź użytkownikowi, co zapamiętałeś, i zakończ odpowiedź.",
          inputSchema: rememberUserProfileInputSchema,
          execute: async (input) => {
            const userTexts = validatedMessages.messages
              .filter((message) => message.role === "user")
              .flatMap((message) => message.parts.flatMap((part) =>
                part.type === "text" ? [part.text] : [],
              ));
            const latestUserText = userTexts.at(-1) ?? "";
            const completedInput = completeProfileInputFromLatestMessage(input, latestUserText, userTexts);
            const checked = validateExplicitProfileFacts(completedInput, userTexts);
            const labels: Record<string, string> = {
              name: "imię",
              city: "miasto",
              favoriteFood: "ulubione jedzenie",
              responseStyle: "preferowany styl odpowiedzi",
            };
            const savedLabels = checked.savedFields.map((field) => labels[field] ?? "informację");
            const rejectedLabels = checked.rejectedFields.map((field) => labels[field] ?? "informację");
            if (checked.savedFields.length === 0) {
              return {
                saved: false,
                savedFields: [],
                rejectedFields: checked.rejectedFields,
                confirmation: rejectedLabels.length > 0
                  ? `Nie zapisałem: ${rejectedLabels.join(", ")}.`
                  : "Nie zapisałem informacji, których nie mogłem potwierdzić jako podanych wprost i bezpiecznych.",
              };
            }
            await conversationRepository.saveUserProfile(checked.facts);
            return {
              saved: true,
              savedFields: checked.savedFields,
              rejectedFields: checked.rejectedFields,
              confirmation: [
                `Zapamiętałem: ${savedLabels.join(", ")}.`,
                ...(rejectedLabels.length > 0 ? [`Nie zapisałem: ${rejectedLabels.join(", ")}.`] : []),
              ].join(" "),
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
      stopWhen: isStepCount(6),
    });

    return result.toUIMessageStreamResponse({
      sendSources: true,
      originalMessages: validatedMessages.messages,
      onEnd: async ({ messages, isAborted, outcome }) => {
        if (isAborted || outcome.status !== "completed") return;
        const assistantMessage = [...messages].reverse().find((message) => message.role === "assistant");
        if (assistantMessage) {
          await conversationRepository.saveMessage(conversationId.data, "assistant", assistantMessage);
        }
      },
      messageMetadata: ({ part }) =>
        part.type === "finish"
          ? {
              retrievedAt: new Date().toISOString(),
              ...(responseModelId ? { modelId: responseModelId } : {}),
              agentSteps,
              limitReached,
              ...(limitReached ? { stepLimit: MAX_AGENT_STEPS, limitFindings } : {}),
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
