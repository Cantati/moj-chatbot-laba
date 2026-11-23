import { z } from "zod";
import cennik from "./studio-nova-cennik.json" with { type: "json" };

export const cennikUslugInputSchema = z.strictObject({
  usluga: z.literal(cennik.usluga),
});

export function pobierzCennikUslug(input: unknown) {
  cennikUslugInputSchema.parse(input);
  return { ...cennik };
}
