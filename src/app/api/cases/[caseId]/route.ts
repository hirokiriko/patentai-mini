import { NextResponse } from "next/server";
import { db } from "@/db";
import { cases } from "@/db/schema";
import { eq, sql } from "drizzle-orm";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ caseId: string }> }
) {
  const { caseId } = await params;
  const [row] = await db
    .select()
    .from(cases)
    .where(eq(cases.caseId, Number(caseId)));

  if (!row) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json(row);
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ caseId: string }> }
) {
  const { caseId } = await params;
  const body = await request.json();
  const { title, status } = body;

  const updates: Record<string, unknown> = {
    updatedAt: sql`datetime('now')`,
  };
  if (title !== undefined) updates.title = title;
  if (status !== undefined) updates.status = status;

  const [row] = await db
    .update(cases)
    .set(updates)
    .where(eq(cases.caseId, Number(caseId)))
    .returning();

  if (!row) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json(row);
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ caseId: string }> }
) {
  const { caseId } = await params;
  const [row] = await db
    .delete(cases)
    .where(eq(cases.caseId, Number(caseId)))
    .returning();

  if (!row) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ deleted: true });
}
