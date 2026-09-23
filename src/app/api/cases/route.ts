import { withOwnerRoute } from "@/lib/owner-http";
import { NextResponse } from "next/server";
import { caseRepo } from "@/repositories";

 async function handleGET() {
  const rows = await caseRepo.findAll();
  return NextResponse.json(rows);
}

 async function handlePOST(request: Request) {
  const body = await request.json();
  const { title, baseApplicationMode, baseApplicationNumber } = body;

  if (!title || typeof title !== "string") {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }

  const row = await caseRepo.create({
    title,
    baseApplicationMode: !!baseApplicationMode,
    baseApplicationNumber:
      typeof baseApplicationNumber === "string" && baseApplicationNumber.trim()
        ? baseApplicationNumber.trim()
        : null,
  });
  return NextResponse.json(row, { status: 201 });
}

export const GET = withOwnerRoute(handleGET);
export const POST = withOwnerRoute(handlePOST);
