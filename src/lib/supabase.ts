import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { UserProfile, UserProfileFacts } from "./user-profile";

export type RestoredConversationMessage = {
  id: string;
  role: "user" | "assistant";
  parts: Array<{ type: "text"; text: string }>;
};

export type ConversationHistoryItem = {
  id: string;
  title: string;
  createdAt: string;
  messageCount: number;
};

type ConversationDatabase = Pick<SupabaseClient, "from">;
type ConversationSummary = { id: string };
const MAX_INT8_ID = "9223372036854775807";

function normalizeInt8Id(value: unknown): string {
  let id: string;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    id = value.toString();
  } else if (typeof value === "string" && /^\d+$/.test(value)) {
    id = value.replace(/^0+(?=\d)/, "");
  } else {
    throw Object.assign(new Error("Supabase returned an invalid int8 identifier."), { code: "invalid_response" });
  }

  if (
    id === "0" ||
    id.length > MAX_INT8_ID.length ||
    (id.length === MAX_INT8_ID.length && id > MAX_INT8_ID)
  ) {
    throw Object.assign(new Error("Supabase returned an invalid int8 identifier."), { code: "invalid_response" });
  }
  return id;
}

function normalizeMessageId(value: unknown): string {
  if (typeof value === "string" && value.trim()) return value;
  return normalizeInt8Id(value);
}

let serverClient: SupabaseClient | undefined;

export function getSupabaseClient(): SupabaseClient {
  if (serverClient) return serverClient;

  const url = process.env.SUPABASE_URL?.trim();
  const secretKey = process.env.SUPABASE_SECRET_KEY?.trim();
  if (!url || !secretKey) {
    if (process.env.NODE_ENV === "development") {
      console.warn("[supabase-diagnostic]", JSON.stringify({
        stage: "configuration",
        supabaseUrlSet: Boolean(url),
        supabaseSecretKeySet: Boolean(secretKey),
      }));
    }
    throw new Error("Supabase configuration is missing.");
  }

  try {
    serverClient = createClient(url, secretKey, {
      auth: {
        autoRefreshToken: false,
        detectSessionInUrl: false,
        persistSession: false,
      },
    });
  } catch (error) {
    if (process.env.NODE_ENV === "development") {
      const value = error && typeof error === "object" ? error as { code?: unknown; status?: unknown; statusCode?: unknown } : {};
      const code = typeof value.code === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(value.code) ? value.code : undefined;
      const status = typeof value.status === "number" && Number.isInteger(value.status)
        ? value.status
        : typeof value.statusCode === "number" && Number.isInteger(value.statusCode) ? value.statusCode : undefined;
      console.warn("[supabase-diagnostic]", JSON.stringify({
        stage: "client_initialization",
        supabaseUrlSet: Boolean(url),
        supabaseSecretKeySet: Boolean(secretKey),
        ...(code ? { errorCode: code } : {}),
        ...(status ? { httpStatus: status } : {}),
      }));
    }
    throw error;
  }
  return serverClient;
}

export function serializeMessageContent(message: { parts: readonly unknown[] }): string {
  const content: string[] = [];

  for (const item of message.parts) {
    if (!item || typeof item !== "object") continue;
    const part = item as Record<string, unknown>;

    if (part.type === "text" && typeof part.text === "string") {
      content.push(part.text);
    } else if (part.type === "file") {
      content.push(typeof part.mediaType === "string" && part.mediaType.startsWith("image/")
        ? "[Załączono obraz]"
        : "[Załączono plik]");
    } else if (part.type === "source-url" && typeof part.url === "string") {
      const title = typeof part.title === "string" && part.title ? part.title : part.url;
      content.push(`Źródło: ${title} (${part.url})`);
    } else if (part.type === "tool-generateImage" && part.state === "output-available") {
      content.push("[Wygenerowano obraz]");
    } else if (part.type === "dynamic-tool" && typeof part.toolName === "string") {
      content.push(`[Użyto narzędzia: ${part.toolName}]`);
    } else if (typeof part.type === "string" && part.type.startsWith("tool-")) {
      const name = part.type.slice("tool-".length);
      content.push(name === "generateImage" && part.state === "output-available"
        ? "[Wygenerowano obraz]"
        : `[Użyto narzędzia: ${name}]`);
    }
  }

  return content.join("\n").trim() || "[Wiadomość bez tekstu]";
}

function normalizeRestoredMessages(value: unknown): RestoredConversationMessage[] {
  if (!Array.isArray(value)) throw new Error("Supabase returned invalid conversation messages.");

  return value.map((row) => {
    if (!row || typeof row !== "object") throw new Error("Supabase returned an invalid message.");
    const message = row as { id?: unknown; role?: unknown; content?: unknown };
    if ((message.role !== "user" && message.role !== "assistant") || typeof message.content !== "string") {
      throw new Error("Supabase returned an invalid message.");
    }
    return { id: normalizeMessageId(message.id), role: message.role, parts: [{ type: "text", text: message.content }] };
  });
}

export function createConversationRepository(client: ConversationDatabase) {
  async function readUserProfile(): Promise<UserProfile | null> {
    const { data, error } = await client
      .from("user_profiles")
      .select("id,name,preferences")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error("Supabase user profile read failed.");
    if (!data) return null;
    if (typeof data !== "object") throw new Error("Supabase returned an invalid user profile.");
    const row = data as { id?: unknown; name?: unknown; preferences?: unknown };
    if (row.name !== null && row.name !== undefined && typeof row.name !== "string") {
      throw new Error("Supabase returned an invalid user profile name.");
    }
    if (row.preferences !== null && row.preferences !== undefined &&
      (typeof row.preferences !== "object" || Array.isArray(row.preferences))) {
      throw new Error("Supabase returned invalid user preferences.");
    }
    return {
      id: normalizeInt8Id(row.id),
      name: typeof row.name === "string" ? row.name : null,
      preferences: row.preferences && typeof row.preferences === "object" && !Array.isArray(row.preferences)
        ? row.preferences as Record<string, unknown>
        : {},
    };
  }

  async function writeUserProfile(current: UserProfile | null, name: string | null, preferences: Record<string, unknown>): Promise<UserProfile> {
    const query = current
      ? client.from("user_profiles").update({ name, preferences }).eq("id", current.id)
      : client.from("user_profiles").insert({ name, preferences });
    const { data, error } = await query.select("id,name,preferences").single();
    if (error || !data) throw new Error("Supabase user profile write failed.");
    const row = data as { id?: unknown; name?: unknown; preferences?: unknown };
    if ((row.name !== null && typeof row.name !== "string") ||
      !row.preferences || typeof row.preferences !== "object" || Array.isArray(row.preferences)) {
      throw new Error("Supabase returned an invalid saved user profile.");
    }
    return {
      id: normalizeInt8Id(row.id),
      name: typeof row.name === "string" ? row.name : null,
      preferences: row.preferences as Record<string, unknown>,
    };
  }

  async function persistUserProfile(facts: UserProfileFacts): Promise<UserProfile> {
    if (Object.keys(facts).length === 0) throw new Error("No verified user profile facts to save.");
    const current = await readUserProfile();
    const name = facts.name ?? current?.name ?? null;
    const preferences = {
      ...(current?.preferences ?? {}),
      ...(facts.city ? { city: facts.city } : {}),
      ...(facts.favoriteFood ? { favoriteFood: facts.favoriteFood } : {}),
      ...(facts.responseStyle ? { responseStyle: facts.responseStyle } : {}),
    };
    return writeUserProfile(current, name, preferences);
  }

  async function updateUserProfileName(name: string): Promise<UserProfile> {
    const current = await readUserProfile();
    return writeUserProfile(current, name, current?.preferences ?? {});
  }

  async function updateUserPreference(key: string, value: string): Promise<UserProfile> {
    const current = await readUserProfile();
    return writeUserProfile(current, current?.name ?? null, { ...(current?.preferences ?? {}), [key]: value });
  }

  async function deleteUserProfileEntry(key: string): Promise<UserProfile | null> {
    const current = await readUserProfile();
    if (!current) return null;
    if (key === "name") {
      return writeUserProfile(current, null, current.preferences);
    }
    if (!Object.hasOwn(current.preferences, key)) return current;
    const preferences = { ...current.preferences };
    delete preferences[key];
    return writeUserProfile(current, current.name, preferences);
  }

  async function clearUserProfile(): Promise<UserProfile | null> {
    const current = await readUserProfile();
    if (!current) return null;
    return writeUserProfile(current, null, {});
  }

  return {
    getUserProfile: readUserProfile,
    saveUserProfile: persistUserProfile,
    updateUserProfileName,
    updateUserPreference,
    deleteUserProfileEntry,
    clearUserProfile,

    async createConversation(): Promise<ConversationSummary> {
      const { data, error } = await client
        .from("conversations")
        .insert({ title: "Nowa rozmowa" })
        .select("id")
        .single();
      if (error || !data) {
        throw new Error("Supabase conversation creation failed.");
      }
      return { id: normalizeInt8Id(data.id) };
    },

    async loadLatestConversation(): Promise<{ conversation: ConversationSummary | null; messages: RestoredConversationMessage[] }> {
      let stage: "conversations_read" | "messages_read" = "conversations_read";
      try {
        const { data: conversation, error } = await client
          .from("conversations")
          .select("id")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (error) throw error;
        if (!conversation) return { conversation: null, messages: [] };
        const conversationId = normalizeInt8Id(conversation.id);

        stage = "messages_read";
        const { data: messages, error: messagesError } = await client
          .from("messages")
          .select("id,role,content")
          .eq("conversation_id", conversationId)
          .order("created_at", { ascending: true });
        if (messagesError) throw messagesError;

        return {
          conversation: { id: conversationId },
          messages: normalizeRestoredMessages(messages ?? []),
        };
      } catch (error) {
        if (process.env.NODE_ENV === "development") {
          const value = error && typeof error === "object" ? error as { code?: unknown; status?: unknown; statusCode?: unknown } : {};
          const code = typeof value.code === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(value.code) ? value.code : undefined;
          const status = typeof value.status === "number" && Number.isInteger(value.status)
            ? value.status
            : typeof value.statusCode === "number" && Number.isInteger(value.statusCode) ? value.statusCode : undefined;
          console.warn("[supabase-diagnostic]", JSON.stringify({
            stage,
            supabaseUrlSet: Boolean(process.env.SUPABASE_URL?.trim()),
            supabaseSecretKeySet: Boolean(process.env.SUPABASE_SECRET_KEY?.trim()),
            ...(code ? { errorCode: code } : {}),
            ...(status ? { httpStatus: status } : {}),
          }));
        }
        throw new Error(stage === "conversations_read" ? "Supabase conversation read failed." : "Supabase message read failed.");
      }
    },

    async listConversations(): Promise<ConversationHistoryItem[]> {
      const { data: conversations, error } = await client
        .from("conversations")
        .select("id,created_at,title")
        .order("created_at", { ascending: false });
      if (error) throw new Error("Supabase conversation list read failed.");
      if (!Array.isArray(conversations)) throw new Error("Supabase returned an invalid conversation list.");

      const normalized = conversations.map((row) => {
        if (!row || typeof row !== "object") throw new Error("Supabase returned an invalid conversation.");
        const value = row as { id?: unknown; created_at?: unknown; title?: unknown };
        if (typeof value.created_at !== "string" || !Number.isFinite(Date.parse(value.created_at))) {
          throw new Error("Supabase returned an invalid conversation timestamp.");
        }
        return {
          id: normalizeInt8Id(value.id),
          title: typeof value.title === "string" && value.title.trim() ? value.title.trim() : "Nowa rozmowa",
          createdAt: value.created_at,
        };
      });

      if (normalized.length === 0) return [];
      const ids = normalized.map(({ id }) => id);
      const { data: messages, error: messagesError } = await client
        .from("messages")
        .select("conversation_id,role,content,created_at")
        .in("conversation_id", ids)
        .order("created_at", { ascending: true });
      if (messagesError) throw new Error("Supabase conversation history read failed.");
      if (!Array.isArray(messages)) throw new Error("Supabase returned invalid conversation history.");

      const byConversation = new Map<string, Array<{ role?: unknown; content?: unknown; created_at?: unknown }>>();
      for (const row of messages) {
        if (!row || typeof row !== "object") throw new Error("Supabase returned an invalid message.");
        const value = row as { conversation_id?: unknown; role?: unknown; content?: unknown; created_at?: unknown };
        const conversationId = normalizeInt8Id(value.conversation_id);
        const grouped = byConversation.get(conversationId) ?? [];
        grouped.push(value);
        byConversation.set(conversationId, grouped);
      }

      return normalized
        .map((conversation) => {
          const conversationMessages = byConversation.get(conversation.id) ?? [];
          const firstUserMessage = conversationMessages.find((message) => message.role === "user" && typeof message.content === "string");
          const content = typeof firstUserMessage?.content === "string" ? firstUserMessage.content.trim() : "";
          const title = content ? (content.length > 80 ? `${content.slice(0, 77).trimEnd()}…` : content) : conversation.title;
          return { ...conversation, title, messageCount: conversationMessages.length };
        })
        .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
    },

    async loadConversation(id: string): Promise<{ conversation: ConversationSummary; messages: RestoredConversationMessage[] } | null> {
      const normalizedId = normalizeInt8Id(id);
      const { data: conversation, error } = await client
        .from("conversations")
        .select("id")
        .eq("id", normalizedId)
        .maybeSingle();
      if (error) throw new Error("Supabase conversation read failed.");
      if (!conversation) return null;

      const conversationId = normalizeInt8Id(conversation.id);
      const { data: messages, error: messagesError } = await client
        .from("messages")
        .select("id,role,content")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: true });
      if (messagesError) throw new Error("Supabase message read failed.");
      return {
        conversation: { id: conversationId },
        messages: normalizeRestoredMessages(messages ?? []),
      };
    },

    async saveMessage(conversationId: string, role: "user" | "assistant", message: { parts: readonly unknown[] }): Promise<void> {
      const normalizedConversationId = normalizeInt8Id(conversationId);
      const { error } = await client.from("messages").insert({
        conversation_id: normalizedConversationId,
        role,
        content: serializeMessageContent(message),
      });
      if (error) throw new Error("Supabase message write failed.");
    },
  };
}

export async function createConversation() {
  return createConversationRepository(getSupabaseClient()).createConversation();
}

export async function loadLatestConversation() {
  return createConversationRepository(getSupabaseClient()).loadLatestConversation();
}

export async function listConversations() {
  return createConversationRepository(getSupabaseClient()).listConversations();
}

export async function loadConversation(id: string) {
  return createConversationRepository(getSupabaseClient()).loadConversation(id);
}

export async function loadUserProfile() {
  return createConversationRepository(getSupabaseClient()).getUserProfile();
}

export async function saveUserProfile(facts: UserProfileFacts) {
  return createConversationRepository(getSupabaseClient()).saveUserProfile(facts);
}

export async function saveConversationMessage(
  conversationId: string,
  role: "user" | "assistant",
  message: { parts: readonly unknown[] },
) {
  return createConversationRepository(getSupabaseClient()).saveMessage(conversationId, role, message);
}
