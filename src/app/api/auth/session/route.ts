import { validSessionFromCookieHeader } from "../../../../lib/auth";

export async function GET(request: Request) {
  const authenticated = validSessionFromCookieHeader(request.headers.get("cookie"));
  return Response.json(
    { authenticated },
    { headers: { "Cache-Control": "no-store" } },
  );
}
