import { tool } from "ai";
import { z } from "zod";
import preparation from "./studio-nova-przygotowanie.json" with { type: "json" };

export const przygotowanieDoUslugiInputSchema = z.object({});

export function pobierzPrzygotowanieDoUslugi() {
  return { ...preparation, wskazowki: [...preparation.wskazowki] };
}

export const przygotowanieDoUslugiTool = tool({
  description:
    "Zwraca ogólne wskazówki przygotowania do konsultacji online, nieoficjalne i niebędące wymaganiami ani procedurami Studio Nova. Wywołaj przy pytaniach, jak przygotować połączenie, mikrofon, kamerę, pytania lub miejsce do rozmowy. Nie używaj przy pytaniach o cenę lub czas trwania konsultacji — do nich służy cennikUslug.",
  inputSchema: przygotowanieDoUslugiInputSchema,
  execute: async () => pobierzPrzygotowanieDoUslugi(),
});
