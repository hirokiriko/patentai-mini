import { NextResponse } from "next/server";
import { draftPatentRepo } from "@/repositories";
import { extractClaimsStream } from "@/lib/extract-claims";

export const maxDuration = 60;

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ caseId: string; draftId: string }> }
) {
  const { caseId, draftId } = await params;
  const draftIdNum = Number(draftId);

  const drafts = await draftPatentRepo.findByCaseId(Number(caseId));
  const draft = drafts.find((d) => d.draftId === draftIdNum);

  if (!draft) {
    return NextResponse.json({ error: "draft not found" }, { status: 404 });
  }

  if (!draft.parsedText) {
    return NextResponse.json(
      { error: "parsed text is empty — re-upload the file" },
      { status: 400 }
    );
  }

  // ストリーミングで応答し、HTTP 接続を維持してタイムアウトを回避する。
  // テキストチャンクを逐次送信 → 完了後に DB 保存 → ストリーム終了。
  const result = extractClaimsStream(draft.parsedText);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of result.textStream) {
          controller.enqueue(encoder.encode(chunk));
        }

        const claims = await result.object;
        await draftPatentRepo.updateExtractedClaims(
          draftIdNum,
          JSON.stringify(claims)
        );

        controller.close();
      } catch (err) {
        console.error("[extract] extraction failed:", err);
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
