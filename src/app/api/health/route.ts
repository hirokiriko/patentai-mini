import { NextResponse } from "next/server";
import { caseRepo } from "@/repositories";

export async function GET() {
  const dbUrl = process.env.DATABASE_URL;

  try {
    const cases = await caseRepo.findAll();
    return NextResponse.json({
      ok: true,
      status: "ok",
      database: {
        ok: true,
        type: "postgres",
        dbUrl: dbUrl ? dbUrl.replace(/\/\/.*@/, "//***@") : "NOT_SET",
        caseCount: cases.length,
      },
    });
  } catch (e) {
    return NextResponse.json({
      ok: true,
      status: "ok",
      database: {
        ok: false,
        type: "postgres",
        dbUrl: dbUrl ? dbUrl.replace(/\/\/.*@/, "//***@") : "NOT_SET",
        error: String(e),
      },
    });
  }
}
