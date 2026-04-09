import { NextResponse } from "next/server";
import { db } from "@/db";
import { draftPatents } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { extractClaims } from "@/lib/extract-claims";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ caseId: string; draftId: string }> }
) {
  const { caseId, draftId } = await params;

  const [draft] = await db
    .select()
    .from(draftPatents)
    .where(
      and(
        eq(draftPatents.draftId, Number(draftId)),
        eq(draftPatents.caseId, Number(caseId))
      )
    );

  if (!draft) {
    return NextResponse.json({ error: "draft not found" }, { status: 404 });
  }

  if (!draft.parsedText) {
    return NextResponse.json(
      { error: "parsed text is empty — re-upload the file" },
      { status: 400 }
    );
  }

  const claims = await extractClaims(draft.parsedText);

  const [updated] = await db
    .update(draftPatents)
    .set({ extractedClaimsJson: JSON.stringify(claims) })
    .where(eq(draftPatents.draftId, Number(draftId)))
    .returning();

  return NextResponse.json(updated);
}
