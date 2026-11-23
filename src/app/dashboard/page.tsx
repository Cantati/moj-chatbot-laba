import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, validSessionFromCookieHeader } from "../../lib/auth";
import DashboardClient from "./dashboard-client";

export default async function DashboardPage() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const cookieHeader = token ? `${SESSION_COOKIE}=${token}` : null;
  if (!validSessionFromCookieHeader(cookieHeader)) redirect("/");
  return <DashboardClient />;
}
