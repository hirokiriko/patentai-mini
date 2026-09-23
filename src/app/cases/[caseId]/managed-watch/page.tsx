import Link from "next/link";
import { notFound } from "next/navigation";
import { requireOwner } from "@/lib/owner-http";
import { caseRepo, draftPatentRepo, priorArtDocumentRepo } from "@/repositories";
import { managedCaseId, managedDeliveryRepository, managedWatchRepository } from "@/lib/patent-watch/managed-api";
import { boundedPatentWatchPublicText } from "@/lib/patent-watch/domain";
import { MANAGED_NOTICE } from "@/lib/patent-watch/managed-delivery";
import { parseUploadedOriginalFileMetadata } from "@/lib/original-file-metadata";
import { isScopedOriginalName } from "@/lib/blob-storage";
import { DeliveryCreate, DeliveryReconcile, WatchPrepare } from "./delivery-controls";

export const dynamic = "force-dynamic";
const states: Record<string, string> = { prepared: "準備済み・未受理", running: "実行中", completed: "比較完了", failed: "失敗・要確認", unknown: "結果照合が必要", stored: "保存済み", storage_unknown: "保存結果の照合が必要", abandoned: "保存中断" };

export default async function ManagedWatchPage({ params }: { params: Promise<{ caseId: string }> }) {
  await requireOwner();
  let caseId: number;
  try { caseId = managedCaseId((await params).caseId); } catch { notFound(); }
  if (!await caseRepo.findById(caseId)) notFound();
  const [setting, runs, deliveries, drafts, priorArt] = await Promise.all([
    managedWatchRepository().setting(caseId), managedWatchRepository().history(caseId), managedDeliveryRepository().list(caseId),
    draftPatentRepo.findByCaseId(caseId), priorArtDocumentRepo.findByCaseId(caseId),
  ]);
  const originals = [
    ...drafts.filter(d => d.caseId === caseId && d.sourceFilePath && isScopedOriginalName(d.sourceFilePath, caseId, "drafts")).map(d => ({ kind: "draft", id: d.draftId })),
    ...priorArt.filter(d => {
      const m = parseUploadedOriginalFileMetadata(d.sourceCsvRowJson);
      return d.caseId === caseId && m && isScopedOriginalName(m.blobName, caseId, "prior-art");
    }).map(d => ({ kind: "prior-art", id: d.docId })),
  ];
  return <main className="mx-auto max-w-5xl space-y-8 px-6 py-8">
    <Link className="text-blue-700 underline" href={`/cases/${caseId}`}>案件 #{caseId} に戻る</Link>
    <header><h1 className="text-3xl font-bold">標準特許ウォッチ</h1><p className="mt-3 text-gray-700">公開期間ごとの比較状況と、生成時点を固定した納品版を確認できます。</p></header>
    {setting ? <section className="space-y-2 rounded border p-5">
      <h2 className="text-xl font-semibold">監視設定</h2>
      <p>監視元: {boundedPatentWatchPublicText(setting.base.publicationNumber, 100)} ／ 版: {boundedPatentWatchPublicText(setting.base.version, 100)}</p>
      <p>指定請求項: {setting.selectedClaimNos.join("、")} ／ {setting.enabled ? "有効" : "停止中"}</p>
      <p>契約日: {setting.contractSignedOn} ／ 監視開始日: {setting.monitoringStartsOn} ／ 終了日: {setting.contractEndsOn ?? "未設定"}</p>
    </section> : <p className="rounded border p-5">監視設定はまだありません。運営者の標準手順で登録してください。</p>}
    {setting&&<><WatchPrepare caseId={caseId}/><DeliveryCreate caseId={caseId}/></>}
    <section className="space-y-3"><h2 className="text-xl font-semibold">保存した納品版</h2>
      {!deliveries.length && <p>納品版はまだありません。候補0件を意味するものではありません。</p>}
      <ul className="space-y-3">{deliveries.map(d => <li className="rounded border p-4" key={d.deliveryId}>
        <p>{d.periodFrom} 〜 {d.periodTo} ／ 第{d.version}版 ／ {states[d.status] ?? "要確認"}</p>
        <p className="text-sm text-gray-600">生成日時: {d.createdAt}</p>
        {["prepared","storage_unknown"].includes(d.status)&&<DeliveryReconcile caseId={caseId} deliveryId={d.deliveryId}/>}
        {d.status === "stored" && <div className="mt-2 flex flex-wrap gap-5">
          <Link className="text-blue-700 underline" href={`/cases/${caseId}/managed-watch/deliveries/${d.deliveryId}`}>保存内容を見る</Link>
          {(["pdf", "csv"] as const).map(format => <a className="text-blue-700 underline" key={format} href={`/api/cases/${caseId}/managed-watch/deliveries/${d.deliveryId}/${format}`}>{format.toUpperCase()}を取得</a>)}
        </div>}
      </li>)}</ul>
    </section>
    <section className="space-y-3"><h2 className="text-xl font-semibold">比較の実行履歴</h2>
      {!runs.length && <p>未実行です。候補の有無はまだ確認されていません。</p>}
      <ul className="space-y-2">{[...runs].reverse().map(r => <li className="rounded border p-4" key={r.runId}>
        <p>{r.periodFrom} 〜 {r.periodTo} ／ {states[r.status] ?? "要確認"}</p>
        <p className="text-sm text-gray-600">準備: {r.createdAt} ／ 受理: {r.acceptedAt ?? "未受理"} ／ 完了: {r.completedAt ?? "未完了"}</p>
      </li>)}</ul><p>比較の完了と、期間内の公報取得・納品版の完成は別々に確認します。結果不明の処理は再開始前に照合が必要です。</p>
    </section>
    {!!originals.length && <section><h2 className="text-xl font-semibold">保存した添付原本</h2><ul className="mt-3 space-y-2">{originals.map(o => <li key={`${o.kind}-${o.id}`}>
      <a className="text-blue-700 underline" href={`/api/cases/${caseId}/attachments/${o.kind}/${o.id}`}>{o.kind === "draft" ? "監視元等の原本" : "参考文献の原本"} #{o.id} を取得</a>
    </li>)}</ul></section>}
    <p className="rounded bg-slate-100 p-5 text-sm">{MANAGED_NOTICE}</p>
  </main>;
}
