import { NextResponse } from "next/server";
import { db } from "@/db";
import { cases } from "@/db/schema";
import { desc } from "drizzle-orm";

export async function GET() {
  const rows = await db.select().from(cases).orderBy(desc(cases.createdAt));
  return NextResponse.json(rows);
}

export async function POST(request: Request) {
  const body = await request.json();
  const { title } = body;

  if (!title || typeof title !== "string") {
    return NextResponse.json(
      { error: "title is required" },
      { status: 400 }
    );
  }

  const [row] = await db.insert(cases).values({ title }).returning();
  return NextResponse.json(row, { status: 201 });
}
