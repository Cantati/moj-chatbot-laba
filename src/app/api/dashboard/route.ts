import { generateText } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { z } from "zod";
import { validSessionFromCookieHeader } from "../../../lib/auth";
import { createDashboardSummaryPrompt, loadDashboardData } from "../../../lib/dashboard-execution";
import { readDashboardGeography } from "../../../lib/dashboard-geography";
import { isCompleteTravelSummary, withDashboardSummaryReasoning } from "../../../lib/dashboard-summary";
import { createWorkshopTools } from "../../../lib/workshop-tools";

const requestSchema = z.strictObject({
  city: z.string().trim().min(1).max(100),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
    const parsed = new Date(value + "T00:00:00.000Z");
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }),
});

function logSummaryDiagnostic(
  code: "configuration_missing" | "model_exception" | "empty_response" | "finish_reason_length" | "validation_failed" | "validation_passed",
  finishReason: string | null,
  validation: boolean | null,
  metrics: {
    outputTokens: number | "unavailable";
    textTokens: number | "unavailable";
    reasoningTokens: number | "unavailable";
    generatedCharacters: number | "unavailable";
  } = {
    outputTokens: "unavailable",
    textTokens: "unavailable",
    reasoningTokens: "unavailable",
    generatedCharacters: "unavailable",
  },
) {
  console.info("[dashboard-summary]", JSON.stringify({ code, finishReason, validation, ...metrics }));
}

function diagnosticTokenCount(value: unknown): number | "unavailable" {
  return typeof value === "number" && Number.isFinite(value) ? value : "unavailable";
}

export async function POST(request: Request) {
  if (!validSessionFromCookieHeader(request.headers.get("cookie"))) {
    return Response.json({ error: "Zaloguj się ponownie, aby kontynuować." }, { status: 401 });
  }

  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: "Nieprawidłowe żądanie." }, { status: 400 }); }
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "Podaj miasto oraz prawidłową datę podróży." }, { status: 400 });

  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  const modelId = process.env.OPENROUTER_MODEL?.trim();
  const tools = createWorkshopTools({
    modelId: modelId || "unconfigured",
    environment: {
      openrouterApiKey: Boolean(apiKey), openrouterModel: Boolean(modelId),
      chatPassword: Boolean(process.env.CHAT_PASSWORD?.length),
      sessionSecret: Boolean(process.env.SESSION_SECRET?.trim() && Buffer.byteLength(process.env.SESSION_SECRET.trim()) >= 32),
    },
  });
  const { city, date } = parsed.data;
  const dashboard = await loadDashboardData(tools, city, date, readDashboardGeography);
  const { cards } = dashboard;

  let summary: string | undefined;
  let summaryError = "Nie udało się przygotować pełnego podsumowania na podstawie dostępnych danych.";
  if (apiKey && modelId) {
    try {
      const openrouter = createOpenRouter({ apiKey });
      const generated = await generateText(withDashboardSummaryReasoning({
        model: openrouter(modelId, { usage: { include: true } }),
        instructions: "Jesteś asystentem podróży. Napisz po polsku dokładnie 2–3 krótkie zdania o tym, co spakować i na co uważać. Używaj wyłącznie przekazanych danych, nie dopowiadaj faktów. Jeśli którekolwiek źródło zawiera pole error albo brakuje w nim danych, nazwij źródło i powiedz, czego nie udało się sprawdzić. Nie przedstawiaj brakujących danych jako sprawdzonych.",
        prompt: createDashboardSummaryPrompt(dashboard),
        maxOutputTokens: 400,
        abortSignal: request.signal,
      }));
      const candidate = generated.text.trim();
      const validation = candidate.length > 0 && isCompleteTravelSummary(candidate);
      const providerMetadata = generated.providerMetadata as unknown as {
        openrouter?: {
          usage?: { completionTokensDetails?: { reasoningTokens?: unknown } };
        };
      } | undefined;
      const providerUsage = providerMetadata?.openrouter?.usage;
      const hasDetailedReasoningUsage =
        typeof providerUsage?.completionTokensDetails?.reasoningTokens === "number" &&
        Number.isFinite(providerUsage.completionTokensDetails.reasoningTokens);
      const metrics = {
        outputTokens: diagnosticTokenCount(generated.usage.outputTokens),
        textTokens: hasDetailedReasoningUsage
          ? diagnosticTokenCount(generated.usage.outputTokenDetails.textTokens)
          : "unavailable" as const,
        reasoningTokens: hasDetailedReasoningUsage
          ? diagnosticTokenCount(generated.usage.outputTokenDetails.reasoningTokens)
          : "unavailable" as const,
        generatedCharacters: generated.text.length,
      };
      if (!candidate) {
        logSummaryDiagnostic("empty_response", generated.finishReason, false, metrics);
      } else if (generated.finishReason === "length") {
        logSummaryDiagnostic("finish_reason_length", generated.finishReason, validation, metrics);
      } else if (!validation) {
        logSummaryDiagnostic("validation_failed", generated.finishReason, false, metrics);
      } else {
        logSummaryDiagnostic("validation_passed", generated.finishReason, true, metrics);
        summary = candidate;
        summaryError = "";
      }
    } catch {
      logSummaryDiagnostic("model_exception", null, null);
      // Karty pozostają dostępne, nawet gdy model nie przygotuje podsumowania.
    }
  } else {
    logSummaryDiagnostic("configuration_missing", null, null);
  }

  return Response.json({
    city: dashboard.city, date, cards,
    ...(summary ? { summary } : { summaryError }),
  }, { headers: { "Cache-Control": "no-store" } });
}
