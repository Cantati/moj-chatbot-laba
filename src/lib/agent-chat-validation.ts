import { safeValidateUIMessages } from "ai";

const MAX_IMAGE_SIZE = 4 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function imageDataUrlSize(url: string, mediaType: string) {
  const prefix = `data:${mediaType};base64,`;
  if (!url.startsWith(prefix)) return null;

  const base64 = url.slice(prefix.length);
  if (base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) return null;
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return (base64.length * 3) / 4 - padding;
}

export async function validateChatRequestMessages(value: unknown) {
  try {
    const validation = await safeValidateUIMessages({ messages: value });
    if (!validation.success) {
      return { success: false as const, status: 400, error: "Nieprawidłowa struktura historii rozmowy." };
    }

    for (const message of validation.data) {
      if (message.role === "system") {
        return { success: false as const, status: 400, error: "Nieprawidłowa struktura historii rozmowy." };
      }
      if (message.role !== "user") continue;
      for (const part of message.parts) {
        if (part.type !== "file") continue;
        if (!ALLOWED_IMAGE_TYPES.has(part.mediaType)) {
          return { success: false as const, status: 400, error: "Obsługiwane formaty zdjęć to JPG, PNG i WebP." };
        }
        const size = imageDataUrlSize(part.url, part.mediaType);
        if (size === null) {
          return { success: false as const, status: 400, error: "Nieprawidłowy format załączonego zdjęcia." };
        }
        if (size > MAX_IMAGE_SIZE) {
          return { success: false as const, status: 413, error: "Zdjęcie może mieć maksymalnie 4 MB." };
        }
      }
    }

    return { success: true as const, messages: validation.data };
  } catch {
    return { success: false as const, status: 400, error: "Nieprawidłowa struktura historii rozmowy." };
  }
}
