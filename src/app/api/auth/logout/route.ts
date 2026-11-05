import { sessionCookie } from "../../../../lib/auth";

export async function POST() {
  return Response.json(
    { ok: true },
    {
      headers: {
        "Set-Cookie": sessionCookie("", 0),
        "Cache-Control": "no-store",
      },
    },
  );
}
