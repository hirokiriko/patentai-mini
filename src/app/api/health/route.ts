import { NextResponse } from "next/server";
import { caseRepo } from "@/repositories";

export async function GET() {
  const dbUrl = process.env.DATABASE_URL;
  const hasToken = !!process.env.TURSO_AUTH_TOKEN;

  try {
    const cases = await caseRepo.findAll();
    return NextResponse.json({
      status: "ok",
      dbUrl: dbUrl ? dbUrl.replace(/\/\/.*@/, "//***@") : "NOT_SET",
      hasToken,
      caseCount: cases.length,
    });
  } catch (e) {
    return NextResponse.json({
      status: "error",
      dbUrl: dbUrl ? dbUrl.replace(/\/\/.*@/, "//***@") : "NOT_SET",
      hasToken,
      error: String(e),
    }, { status: 500 });
  }
}
