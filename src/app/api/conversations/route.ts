import { sessionRequiredResponse, validSessionFromCookieHeader } from "../../../lib/auth";
import { createConversationRepository, getSupabaseClient, listConversations, loadConversation, loadLatestConversation } from "../../../lib/supabase";
import { newConversationGreeting } from "../../../lib/user-profile";

export async function GET(request: Request) {
  if (!validSessionFromCookieHeader(request.headers.get("cookie"))) {
    return sessionRequiredResponse();
  }

  try {
    const url = new URL(request.url);
    if (url.searchParams.get("view") === "list") {
      const conversations = await listConversations();
      return Response.json({ conversations }, { headers: { "Cache-Control": "no-store" } });
    }

    const conversationId = url.searchParams.get("conversationId");
    if (conversationId !== null) {
      const result = await loadConversation(conversationId);
      if (!result) return Response.json({ error: "Nie znaleziono tej rozmowy." }, { status: 404 });
      return Response.json(result, { headers: { "Cache-Control": "no-store" } });
    }

    const result = await loadLatestConversation();
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Nie udało się wczytać rozmowy z pamięci." }, { status: 503 });
  }
}

export async function POST(request: Request) {
  if (!validSessionFromCookieHeader(request.headers.get("cookie"))) {
    return sessionRequiredResponse();
  }

  try {
    const repository = createConversationRepository(getSupabaseClient());
    const profile = await repository.getUserProfile();
    const conversation = await repository.createConversation();
    const greeting = newConversationGreeting(profile?.name ?? null);
    await repository.saveMessage(conversation.id, "assistant", { parts: [{ type: "text", text: greeting }] });
    const restored = await repository.loadConversation(conversation.id);
    return Response.json(
      { conversation, messages: restored?.messages ?? [] },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json({ error: "Nie udało się rozpocząć nowej rozmowy." }, { status: 503 });
  }
}
