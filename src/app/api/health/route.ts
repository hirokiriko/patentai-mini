import { NextResponse } from "next/server";
import { caseRepo } from "@/repositories";

export async function GET() {
  const dbUrl = process.env.DATABASE_URL;
  const hasToken = !!process.env.TURSO_AUTH_TOKEN;

  try {
    const cases = await caseRepo.findAll();
    return NextResponse.json({
      ok: true,
      status: "ok",
      database: {
        ok: true,
        dbUrl: dbUrl ? dbUrl.replace(/\/\/.*@/, "//***@") : "NOT_SET",
        hasToken,
        caseCount: cases.length,
      },
    });
  } catch (e) {
    return NextResponse.json({
      ok: true,
      status: "ok",
      database: {
        ok: false,
        dbUrl: dbUrl ? dbUrl.replace(/\/\/.*@/, "//***@") : "NOT_SET",
        hasToken,
        error: String(e),
      },
    });
  }
}
