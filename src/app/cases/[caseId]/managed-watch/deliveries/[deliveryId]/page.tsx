import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { requireOwner } from "@/lib/owner-http";
import { managedCaseId, managedDeliveryRepository } from "@/lib/patent-watch/managed-api";
import { managedDeliveryBlocks } from "@/lib/patent-watch/managed-delivery";
import { ManagedWatchError } from "@/lib/patent-watch/managed-types";
import { FindingReview } from "../../delivery-controls";

export const dynamic = "force-dynamic";
export default async function ManagedDeliveryPage({ params }: { params: Promise<{ caseId: string; deliveryId: string }> }) {
  await requireOwner();
  const p = await params;
  let caseId: number, id: string;
  try { caseId = managedCaseId(p.caseId); id = z.uuidv4().parse(p.deliveryId); } catch { notFound(); }
  const saved = await managedDeliveryRepository().get(caseId, id).catch(error => {
    if (error instanceof ManagedWatchError && error.code === "not_found") notFound();
    throw new Error("delivery_unavailable");
  });
  if (saved.status !== "stored") notFound();
  return <main className="mx-auto max-w-5xl space-y-5 px-6 py-8">
    <Link className="text-blue-700 underline" href={`/cases/${caseId}/managed-watch`}>納品版の一覧に戻る</Link>
    <div className="flex gap-5">{(["pdf", "csv"] as const).map(format => <a key={format} className="text-blue-700 underline" href={`/api/cases/${caseId}/managed-watch/deliveries/${id}/${format}`}>{format.toUpperCase()}を取得</a>)}</div>
    <article className="space-y-3 rounded border p-6">{[...managedDeliveryBlocks(saved.report)].map((block, index) => block.heading
      ? index === 0 ? <h1 className="text-2xl font-bold" key={index}>{block.text}</h1> : <h2 className="pt-5 text-xl font-semibold" key={index}>{block.text}</h2>
      : <p className="whitespace-pre-wrap break-words" key={index}>{block.text}</p>)}</article>
    {!!saved.report.findings.length&&<section className="space-y-3"><h2 className="text-xl font-semibold">原文確認後の状態を保存</h2><p>以下の操作は現在の確認状態を変更します。上の保存済み納品版とPDF・CSVは変更されません。</p><ul className="space-y-3">{saved.report.findings.map(f=><FindingReview key={f.findingId} caseId={caseId} findingId={f.findingId}/>)}</ul></section>}
  </main>;
}
