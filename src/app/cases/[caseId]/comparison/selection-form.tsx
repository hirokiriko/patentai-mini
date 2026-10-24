"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { comparisonCatalog } from "@/lib/prior-art-comparison/repository";

type Catalog = Awaited<ReturnType<typeof comparisonCatalog>>;
const field = "rounded border border-slate-400 bg-white p-2 text-slate-900";
export function SelectionForm({ catalog, completedIds, pendingIds, blocked }: { catalog: Catalog; completedIds: string[]; pendingIds: string[]; blocked: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [message, setMessage] = useState("");
  const [operation, setOperation] = useState<string | null>(null);
  const pendingKey = `prior-art-comparison-pending-${catalog.caseId}`;
  useEffect(() => {
    const pending = sessionStorage.getItem(pendingKey) || pendingIds[0];
    if (!pending) return;
    setOperation(pending);
    if (completedIds.includes(pending)) {
      sessionStorage.removeItem(pendingKey); setUncertain(false);
      setMessage("前回の操作IDに対応する保存結果を確認しました。再送していません。");
    } else {
      setUncertain(true);
      setMessage("前回の操作が未照合です。再実行せず保存結果を再読込してください。表示されない場合は利用状況と保存状態の確認が必要です。");
    }
  }, [pendingKey, completedIds, pendingIds]);
  useEffect(() => {
    if (busy || !operation || completedIds.includes(operation)) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const until = Date.now() + 75 * 60_000;
    async function read() {
      try {
        const response = await fetch(`/api/cases/${catalog.caseId}/analyze?operationId=${encodeURIComponent(operation!)}`, { cache: "no-store" });
        if (!response.ok) throw Error();
        const value = await response.json();
        if (disposed) return;
        if (value.operationId === operation && value.status === "complete") {
          sessionStorage.removeItem(pendingKey); setUncertain(false);
          setMessage("比較結果を保存しました。PDF/CSVを取得できます。再取得でAIは実行されません。");
          router.refresh(); return;
        }
        if (value.operationId === operation && value.status === "failed") {
          setUncertain(true);
          setMessage("品質検証で停止しました。保存予約を保持し、AIは再送しません。操作IDの停止段階と利用状況を照合してください。");
          return;
        }
        if (value.operationId !== operation || value.status !== "reserved") {
          setUncertain(true);
          setMessage("この操作IDの予約・完了を確認できません。再送せず、利用量と保存状態を照合してください。");
          return;
        }
        setUncertain(true);
        setMessage("比較の完了を待っています。画面を閉じてもサーバー側の処理は続きます。中断・失敗時も自動再実行しません。");
      } catch {
        if (!disposed) setMessage("保存状態を確認できません。AIは再送せず、保存状態の確認だけを続けます。");
      }
      if (!disposed && Date.now() < until) timer = setTimeout(read, 5000);
      else if (!disposed) setMessage("完了を確認できません。再実行せず、操作IDの利用状況と保存状態を照合してください。");
    }
    timer = setTimeout(read, 1000);
    return () => { disposed = true; clearTimeout(timer); };
  }, [busy, operation, completedIds, catalog.caseId, pendingKey, router]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || uncertain || blocked || sessionStorage.getItem(pendingKey)) return;
    const data = new FormData(event.currentTarget);
    const operationId = crypto.randomUUID();
    sessionStorage.setItem(pendingKey, operationId);
    setOperation(operationId); setBusy(true); setMessage("");
    const documents = catalog.documents.filter(d => data.get(`doc-${d.id}`)).map(d => ({ docId: d.id,
      claimNos: data.getAll(`claims-${d.id}`).map(Number),
      identity: { publication: String(data.get(`publication-${d.id}`) || ""), edition: String(data.get(`edition-${d.id}`) || "") } }));
    try {
      const response = await fetch(`/api/cases/${catalog.caseId}/analyze`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operationId, inputDigest: catalog.inputDigest,
          draftClaimNos: data.getAll("draft-claims").map(Number),
          draftIdentity: { publication: String(data.get("draft-publication") || ""), edition: String(data.get("draft-edition") || "") },
          documents, originalsConfirmed: data.get("originals-confirmed") === "on" }) });
      const result = await response.json();
      if (!response.ok) {
        const pending = ["save_unconfirmed", "ai_incomplete", "result_invalid"].includes(result.code);
        setUncertain(pending);
        if (!pending) { sessionStorage.removeItem(pendingKey); setOperation(null); }
        setMessage(result.error || "比較を完了できませんでした。");
        return;
      }
      if (response.status === 202) {
        setUncertain(true);
        setMessage("比較を受け付けました。サーバー側で処理し、保存状態を自動確認します。");
        return;
      }
      setMessage("根拠付き比較を保存しました。下の保存結果からPDF/CSVを取得できます。");
      sessionStorage.removeItem(pendingKey);
      router.refresh();
    } catch {
      setUncertain(true);
      setMessage("応答を確認できません。再実行せず、保存結果を再読込して下の操作IDと照合してください。");
    } finally { setBusy(false); }
  }
  return <form onSubmit={submit} className="space-y-6 rounded-xl border border-slate-300 bg-slate-50 p-5">
    <h2 className="text-xl font-semibold">比較する原文と範囲</h2>
    <p>日本語の「【請求項1】」形式の保存原文を使います。原本と末尾・番号・従属参照を照合してください。画像・数式・欠落がある資料は比較を開始できません。抽出済みの要約は比較入力に使いません。</p>
    <fieldset disabled={busy || uncertain || blocked} className="space-y-5">
      <legend className="font-semibold">基準文献</legend>
      <div className="flex flex-wrap gap-3">
        <label className="grid gap-1">文献名・公開番号<input name="draft-publication" required maxLength={100} className={field} /></label>
        <label className="grid gap-1">版・日付<input name="draft-edition" required maxLength={100} className={field} /></label>
      </div>
      {catalog.draft?.source ? <ClaimSelection name="draft-claims" source={catalog.draft.source} /> : <p role="alert">基準文献の原文を確認できません。案件画面で、請求項番号と全文を含む資料を取り込んでください。</p>}
      <h3 className="font-semibold">対象文献を2〜3件選択</h3>
      <p>各文献の対象請求項も選択してください。選ばない請求項は比較対象外です。必要な参照先の全文は自動的に含めます。全体で最大4組です。原文を請求項ごとに抽出し、比較と照合を行います。対象は参照先を含め最大19請求項、AI呼出しは最大21回です。処理は最大75分で停止し、失敗・中断時の自動再送は行いません。</p>
      {catalog.documents.map(doc => <fieldset key={doc.id} className="space-y-3 rounded border border-slate-300 bg-white p-4">
        <legend className="px-2"><label><input type="checkbox" name={`doc-${doc.id}`} disabled={!doc.source} /> {doc.publicationNo || doc.title || `文献 ${doc.id}`}</label></legend>
        <div className="flex flex-wrap gap-3">
          <label className="grid gap-1">文献名・公開番号<input name={`publication-${doc.id}`} defaultValue={doc.publicationNo || doc.title || ""} maxLength={100} className={field} /></label>
          <label className="grid gap-1">版・日付<input name={`edition-${doc.id}`} maxLength={100} className={field} /></label>
        </div>
        {doc.source ? <ClaimSelection name={`claims-${doc.id}`} source={doc.source} /> : <p>原文の不足・番号・参照・未対応形式を確認してください。案件画面から完全な資料を取り込み直す必要があります。</p>}
      </fieldset>)}
      <label className="flex items-start gap-2"><input className="mt-1" type="checkbox" name="originals-confirmed" required />
        <span>選択した文献名・版と保存原文を原本に照合し、請求項末尾・参照先の欠落や画像・数式の脱落がないことを確認しました。機械処理だけでは原本の完全性を保証できないことを理解しています。</span>
      </label>
      <button type="submit" disabled={!catalog.draft?.source || busy || uncertain} className="rounded bg-red-700 px-5 py-3 font-semibold text-white disabled:opacity-50">{busy ? "比較中・完了後に保存します…" : "指定範囲を比較して保存"}</button>
    </fieldset>
    {message && <p role="status" className="rounded border border-slate-400 bg-white p-3">{message}</p>}
    {operation && <p className="break-all text-sm">今回の操作ID: {operation}</p>}
    <button type="button" disabled={busy} onClick={() => router.refresh()} className="rounded border border-slate-500 px-4 py-2">保存結果を再読込（AI送信なし）</button>
  </form>;
}
function ClaimSelection({ name, source }: { name: string; source: NonNullable<Catalog["draft"]>["source"] }) {
  return <div className="space-y-3">{source?.source.claims.map(claim => <div key={claim.claimNo}>
    <label className="font-medium"><input type="checkbox" name={name} value={claim.claimNo} /> 請求項{claim.claimNo}（{claim.text.length}文字、参照: {claim.dependsOn.join(", ") || "なし"}）</label>
    <details className="ml-5"><summary className="cursor-pointer py-1">保存原文を表示</summary><p className="whitespace-pre-wrap break-words rounded bg-slate-100 p-3">{claim.text}</p></details>
  </div>)}</div>;
}
