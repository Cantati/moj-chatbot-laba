import { z } from "zod";
import { requireActiveSession } from "../../../lib/auth";
import { createConversationRepository, getSupabaseClient } from "../../../lib/supabase";
import { isSafeProfileEntryValue } from "../../../lib/user-profile";

const preferenceKeySchema = z.string().trim().min(1).max(64).regex(/^[A-Za-z][A-Za-z0-9_-]*$/);
const updateSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("name"), value: z.string().trim().min(1).max(120) }).strict(),
  z.object({ action: z.literal("preference"), key: preferenceKeySchema, value: z.string().trim().min(1).max(120) }).strict(),
]);

function jsonProfile(profile: unknown, status = 200) {
  return Response.json({ profile }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(request: Request) {
  const unauthorized = requireActiveSession(request.headers.get("cookie"));
  if (unauthorized) return unauthorized;

  try {
    const profile = await createConversationRepository(getSupabaseClient()).getUserProfile();
    return jsonProfile(profile);
  } catch {
    return Response.json({ error: "Nie udało się wczytać profilu." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}

export async function PATCH(request: Request) {
  const unauthorized = requireActiveSession(request.headers.get("cookie"));
  if (unauthorized) return unauthorized;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Nieprawidłowe dane profilu." }, { status: 400 });
  }

  const parsed = updateSchema.safeParse(body);
  if (!parsed.success || !isSafeProfileEntryValue(parsed.data.value)) {
    return Response.json({ error: "Wartość profilu jest nieprawidłowa lub zawiera dane, których nie można zapisać." }, { status: 400 });
  }

  try {
    const repository = createConversationRepository(getSupabaseClient());
    if (parsed.data.action === "name") {
      return jsonProfile(await repository.updateUserProfileName(parsed.data.value));
    }

    if (!isSafeProfileEntryValue(parsed.data.key)) {
      return Response.json({ error: "Nieprawidłowa nazwa preferencji." }, { status: 400 });
    }
    const current = await repository.getUserProfile();
    if (!current || !Object.hasOwn(current.preferences, parsed.data.key)) {
      return Response.json({ error: "Nie znaleziono tej preferencji." }, { status: 404 });
    }
    return jsonProfile(await repository.updateUserPreference(parsed.data.key, parsed.data.value));
  } catch {
    return Response.json({ error: "Nie udało się zapisać zmian profilu." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}

export async function DELETE(request: Request) {
  const unauthorized = requireActiveSession(request.headers.get("cookie"));
  if (unauthorized) return unauthorized;

  const url = new URL(request.url);
  const nameEntry = url.searchParams.get("entry") === "name";
  const key = url.searchParams.get("preference");
  if ((url.searchParams.has("entry") && !nameEntry) ||
    (nameEntry && key !== null)) {
    return Response.json({ error: "Nieprawidłowy wpis profilu." }, { status: 400 });
  }
  if (!nameEntry && key === null && url.searchParams.size > 0) {
    return Response.json({ error: "Nieprawidłowy wpis profilu." }, { status: 400 });
  }
  try {
    const repository = createConversationRepository(getSupabaseClient());
    if (nameEntry) return jsonProfile(await repository.deleteUserProfileEntry("name"));
    if (key === null) return jsonProfile(await repository.clearUserProfile());
    if (!preferenceKeySchema.safeParse(key).success || !isSafeProfileEntryValue(key)) {
      return Response.json({ error: "Nieprawidłowa nazwa wpisu profilu." }, { status: 400 });
    }
    const current = await repository.getUserProfile();
    if (!current || !Object.hasOwn(current.preferences, key)) {
      return Response.json({ error: "Nie znaleziono tej preferencji." }, { status: 404 });
    }
    return jsonProfile(await repository.deleteUserProfileEntry(key));
  } catch {
    return Response.json({ error: "Nie udało się usunąć danych profilu." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
