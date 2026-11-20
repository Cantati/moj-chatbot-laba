import { Output, streamText } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { validSessionFromCookieHeader } from "../../../lib/auth";
import { createStudioNovaAnalysisErrorResponse } from "../../../lib/studio-nova-analysis-errors";
import {
  STUDIO_NOVA_ANALYSIS_INSTRUCTIONS,
  validateStudioNovaAnalysis,
  studioNovaAnalysisSchema,
  validateStudioNovaAnalysisRequest,
} from "../../../lib/studio-nova";

export async function POST(request: Request) {
  if (!validSessionFromCookieHeader(request.headers.get("cookie"))) {
    return Response.json({ error: "Zaloguj się ponownie, aby kontynuować." }, { status: 401 });
  }

  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  const modelId = process.env.OPENROUTER_MODEL?.trim();
  if (!apiKey || !modelId) {
    return Response.json(
      { error: "Brak konfiguracji OpenRouter. Sprawdź ustawienia serwera." },
      { status: 503 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Nieprawidłowe żądanie analizy." }, { status: 400 });
  }

  const validatedRequest = validateStudioNovaAnalysisRequest(body);
  if (!validatedRequest.success) {
    const isTooLong = validatedRequest.error.issues.some(
      (issue) => issue.path[0] === "message" && issue.code === "too_big",
    );
    return Response.json(
      {
        error: isTooLong
          ? "Wiadomość jest za długa. Limit to 12 000 znaków."
          : "Nieprawidłowe żądanie analizy. Wymagane jest tylko pole message.",
      },
      { status: isTooLong ? 413 : 400 },
    );
  }
  const message = validatedRequest.data.message;

  try {
    const openrouter = createOpenRouter({ apiKey });
    const result = streamText({
      model: openrouter(modelId),
      instructions: STUDIO_NOVA_ANALYSIS_INSTRUCTIONS,
      messages: [{ role: "user", content: message.trim() }],
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

    const generatedOutput: unknown = await result.output;
    const validated = validateStudioNovaAnalysis(generatedOutput);
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
