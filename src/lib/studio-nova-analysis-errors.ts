import { APICallError, NoObjectGeneratedError } from "ai";

function isStructuredOutputConfigurationError(error: unknown) {
  if (!APICallError.isInstance(error)) return false;
  const providerDetails = `${error.message}\n${error.responseBody ?? ""}`;
  return (
    [400, 404, 422].includes(error.statusCode ?? 0) &&
    /structured|json[_ -]?schema|response[_ -]?format|require_parameters|unsupported.*(parameter|format)|does not support/i.test(
      providerDetails,
    )
  );
}

function isModelRefusal(error: NoObjectGeneratedError) {
  return (
    error.finishReason === "content-filter" ||
    /\b(nie mogę|nie jestem w stanie|nie mogę pomóc|i cannot|i can't|i am unable|i’m unable)\b/i.test(
      error.text ?? "",
    )
  );
}

export function createStudioNovaAnalysisErrorResponse(error: unknown, request: Request) {
  if (request.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
    return Response.json(
      { error: "Analiza została przerwana. Nie utworzono wyniku." },
      { status: 408 },
    );
  }

  if (NoObjectGeneratedError.isInstance(error)) {
    if (error.finishReason === "length") {
      return Response.json(
        { error: "Odpowiedź modelu została ucięta przed końcem. Nie utworzono wyniku." },
        { status: 502 },
      );
    }
    if (isModelRefusal(error)) {
      return Response.json(
        { error: "Model odmówił analizy. Nie utworzono wyniku." },
        { status: 422 },
      );
    }
    return Response.json(
      { error: "Model nie zwrócił kompletnego wyniku zgodnego ze schematem. Wynik odrzucono." },
      { status: 502 },
    );
  }

  if (isStructuredOutputConfigurationError(error)) {
    return Response.json(
      {
        error:
          "Ten model lub endpoint OpenRouter nie obsługuje wymaganego JSON Schema. Sprawdź OPENROUTER_MODEL i wybierz obsługiwany model lub endpoint; nie zmieniaj wariantu na płatniejszy bez uzgodnienia.",
      },
      { status: 503 },
    );
  }

  return Response.json(
    { error: "Dostawca modelu nie zwrócił wyniku analizy. Spróbuj ponownie później." },
    { status: 502 },
  );
}
