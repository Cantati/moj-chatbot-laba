import { convertToModelMessages, streamText, type UIMessage } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { validSessionFromCookieHeader } from "../../../lib/auth";

export async function POST(request: Request) {
  if (!validSessionFromCookieHeader(request.headers.get("cookie"))) {
    return Response.json({ error: "Zaloguj się ponownie, aby kontynuować." }, { status: 401 });
  }

  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  const modelId = process.env.OPENROUTER_MODEL?.trim();

  if (!apiKey || !modelId) {
    return Response.json(
      {
        error:
          "Brak konfiguracji OpenRouter. Uzupełnij OPENROUTER_API_KEY i OPENROUTER_MODEL w pliku .env.local, a następnie uruchom ponownie serwer.",
      },
      { status: 503 },
    );
  }

  try {
    const body = (await request.json()) as { messages?: UIMessage[] };
    if (!Array.isArray(body.messages)) {
      return Response.json({ error: "Nieprawidłowy format historii rozmowy." }, { status: 400 });
    }

    const openrouter = createOpenRouter({ apiKey });
    const result = streamText({
      model: openrouter(modelId),
      messages: await convertToModelMessages(body.messages),
    });

    return result.toUIMessageStreamResponse({
      onError: () => "Wystąpił błąd podczas łączenia z OpenRouter. Sprawdź konfigurację i spróbuj ponownie.",
    });
  } catch {
    return Response.json(
      { error: "Nie udało się przygotować rozmowy. Sprawdź konfigurację i spróbuj ponownie." },
      { status: 500 },
    );
  }
}
