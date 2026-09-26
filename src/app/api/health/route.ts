import { NextResponse } from "next/server";
import { checkDatabaseHealth } from "../../../lib/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const ok = await checkDatabaseHealth();
  return NextResponse.json(
    { ok, status: ok ? "ok" : "unavailable" },
    { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
