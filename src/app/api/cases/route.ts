import { NextResponse } from "next/server";
import { caseRepo } from "@/repositories";

export async function GET() {
  const rows = await caseRepo.findAll();
  return NextResponse.json(rows);
}

export async function POST(request: Request) {
  const body = await request.json();
  const { title } = body;

  if (!title || typeof title !== "string") {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }

  const row = await caseRepo.create(title);
  return NextResponse.json(row, { status: 201 });
}
