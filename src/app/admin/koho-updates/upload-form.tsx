"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { PublicKohoUpload } from "@/lib/koho-import/upload-contract";

type Intent = { operationId: string; requestedAt: string; sourceAcquiredAt: string | null; fileName: string; byteLength: number };
type Metadata = { maxBytes: number; chunkBytes: number; serverTime: string };
const KEY = "patentai-koho-upload-v1", BASE = "/api/admin/koho-uploads";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const names: Record<PublicKohoUpload["status"], string> = {
  preparing: "準備中", uploading: "アップロード中", uploaded: "アップロード済み・取込待ち",
  submitting: "取込の開始を確認中", processing: "保存内容の検証・取込中", complete: "取込完了",
  failed: "取込失敗", outcome_unknown: "結果を確認できません",
};
const formatBytes = (n: number) => `${(n / 1024 ** 2).toLocaleString("ja-JP", { maximumFractionDigits: 1 })} MiB`;
function loadIntent(): Intent | null {
  const raw = localStorage.getItem(KEY); if (!raw) return null;
  const v = JSON.parse(raw) as Intent;
  if (!UUID.test(v.operationId) || typeof v.fileName !== "string" || !/\.zip$/i.test(v.fileName) || v.fileName.length > 200 ||
    !Number.isSafeInteger(v.byteLength) || v.byteLength <= 0 || !Number.isFinite(Date.parse(v.requestedAt)) ||
    (v.sourceAcquiredAt !== null && !Number.isFinite(Date.parse(v.sourceAcquiredAt)))) throw Error();
  return v;
}
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(path, { ...init, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(115_000) });
  if (!r.ok) throw Error();
  return r.json() as Promise<T>;
}
const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
export function KohoUploadForm() {
  const [file, setFile] = useState<File | null>(null), [metadata, setMetadata] = useState<Metadata | null>(null);
  const [intent, setIntent] = useState<Intent | null>(null), [state, setState] = useState<PublicKohoUpload | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false), lock = useRef(false);
  const [acquired, setAcquired] = useState(""), [lookupId, setLookupId] = useState<string | null>(null);
  const apply = (s: PublicKohoUpload) => { setState(s); return s; };
  const remember = (s: PublicKohoUpload) => {
    const i = { operationId: s.operationId, fileName: s.fileName, byteLength: s.byteLength,
      requestedAt: s.requestedAt, sourceAcquiredAt: s.sourceAcquiredAt };
    setIntent(i); setLookupId(s.operationId); return i;
  };
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const linked = new URLSearchParams(window.location.search).get("upload");
        if (linked && !UUID.test(linked)) throw Error();
        let stored: Intent | null = null;
        try { stored = loadIntent(); } catch { if (!linked) throw Error(); }
        const saved = stored && (!linked || linked === stored.operationId) ? stored : null;
        if (!active) return;
        setIntent(saved); const id = linked ?? saved?.operationId; setLookupId(id ?? null);
        if (id) { try { const s = await request<PublicKohoUpload>(`${BASE}/${id}`); if (active) { setState(s); remember(s); } }
          catch { if (active) setError("前回の状態を確認できません。同じ処理の状態確認または再開を行ってください。");
            if (linked && !saved) return; } }
        const m = await request<Metadata>(BASE); if (active) setMetadata(m);
      } catch { if (active) setError("更新の準備ができていません。状態を確認し、解消しない場合は運用担当へ連絡してください。"); }
    })();
    return () => { active = false; };
  }, []);
  const operationId = state?.operationId, status = state?.status;
  // Bounded status reads; failure stops this polling cycle and never resubmits a Job.
  useEffect(() => {
    if (!operationId || !status || !["submitting", "processing"].includes(status) || busy) return;
    let active = true, reads = 0; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const s = await request<PublicKohoUpload>(`${BASE}/${operationId}`);
        if (!active) return; setState(s);
        if (++reads < 480 && ["submitting", "processing"].includes(s.status)) timer = setTimeout(poll, 15_000);
      } catch { if (active) setError("状態の取得が中断しました。取込を再送せず、「状態を確認」で確認してください。"); }
    };
    timer = setTimeout(poll, 15_000);
    return () => { active = false; clearTimeout(timer); };
  }, [operationId, status, busy]);
  async function refresh() {
    const id = lookupId ?? intent?.operationId;
    if (!id || lock.current) return;
    setChecking(true);
    try { const s = apply(await request<PublicKohoUpload>(`${BASE}/${id}`)); remember(s);
      if (!metadata) setMetadata(await request<Metadata>(BASE)); setError(null); }
    catch { setError("状態を確認できません。取込完了・正常0件とは扱わず、しばらくして状態を確認してください。"); }
    finally { setChecking(false); }
  }
  async function upload() {
    if (lock.current || !metadata) return; lock.current = true; setBusy(true); setError(null);
    let current = intent;
    try {
      if (!current) {
        if (!file || !/\.zip$/i.test(file.name) || file.size <= 0 || file.size > metadata.maxBytes) throw Error();
        const m = await request<Metadata>(BASE);
        current = { operationId: crypto.randomUUID(), requestedAt: m.serverTime,
          sourceAcquiredAt: acquired ? new Date(acquired).toISOString() : null, fileName: file.name, byteLength: file.size };
        // Persist before the first write, including when its response is lost.
        localStorage.setItem(KEY, JSON.stringify(current)); setIntent(current); setLookupId(current.operationId);
        window.history.replaceState(null, "", `?upload=${current.operationId}`);
      }
      let s = apply(await request<PublicKohoUpload>(BASE, json(current)));
      const path = `${BASE}/${current.operationId}`;
      if (s.status === "preparing") s = apply(await request<PublicKohoUpload>(path, json({ action: "reconcile" })));
      if (s.status === "uploading") {
        if (!file || file.name !== current.fileName || file.size !== current.byteLength) {
          setError("再開には、前回と同じZIPファイルを選択してください。"); return;
        }
        if (s.pending) s = apply(await request<PublicKohoUpload>(path, json({ action: "reconcile" })));
        // Recheck already acknowledged chunks against the selected file. This
        // does not stage them again and prevents a different file being spliced.
        for (let index = 0; index * metadata.chunkBytes < file.size; index++) {
          s = apply(await request<PublicKohoUpload>(`${path}/chunks/${index}`, {
            method: "PUT", headers: { "Content-Type": "application/octet-stream" },
            body: file.slice(index * metadata.chunkBytes, Math.min((index + 1) * metadata.chunkBytes, file.size)),
          }));
        }
        s = apply(await request<PublicKohoUpload>(path, json({ action: "seal" })));
      }
      if (s.status === "uploaded") apply(await request<PublicKohoUpload>(path, json({ action: "start" })));
    } catch {
      setError("処理が中断したか、結果を確認できません。正常0件ではありません。同じ処理の状態を確認してください。");
      if (current) { try { apply(await request<PublicKohoUpload>(`${BASE}/${current.operationId}`)); } catch { /* Preserve the ID and last confirmed state. */ } }
    } finally { lock.current = false; setBusy(false); }
  }
  function nextFile() {
    if (!state || !["complete", "failed"].includes(state.status) || lock.current) return;
    try { localStorage.removeItem(KEY); setIntent(null); setLookupId(null); setState(null); setFile(null); setError(null); setAcquired("");
      window.history.replaceState(null, "", window.location.pathname); }
    catch { setError("前回の処理情報を保持しています。ブラウザーの保存設定を確認してください。"); }
  }
  const canResume = !state || ["preparing", "uploading", "uploaded"].includes(state.status);
  return <section className="mt-6 space-y-5 rounded-lg border border-gray-300 p-5" aria-label="差分公報ZIPのアップロード">
    <ol className="list-decimal space-y-1 pl-5 text-sm text-gray-700">
      <li>取得済みのZIPを選び、ファイル名とサイズを確認します。</li>
      <li>「アップロードして取り込む」を押します。アップロード完了までは画面を開いたままにしてください。</li>
      <li>取込完了後、案件画面からウォッチ比較を実行します。処理中はこの画面に戻って状態を確認できます。</li>
    </ol>
    <div>
      <label htmlFor="koho-zip" className="block font-medium">差分公報ZIP</label>
      <input key={intent?.operationId ?? "new"} id="koho-zip" type="file" accept=".zip,application/zip" disabled={busy || !canResume}
        className="mt-2 block w-full rounded border p-2" onChange={e => setFile(e.target.files?.[0] ?? null)} />
      {metadata && <p className="mt-1 text-sm text-gray-600">1ファイルの上限：{formatBytes(metadata.maxBytes)}</p>}
      {(file || intent) && <p className="mt-3 break-all">{file?.name ?? intent?.fileName}（{formatBytes(file?.size ?? intent!.byteLength)}）</p>}
      {!intent && <div className="mt-4"><label htmlFor="source-acquired" className="block text-sm font-medium">公報サイトから取得した日時（任意・端末の日時）</label>
        <input id="source-acquired" type="datetime-local" value={acquired} disabled={busy} onChange={e => setAcquired(e.target.value)} className="mt-1 rounded border p-2" />
        <p className="mt-1 text-sm text-gray-600">不明な場合は空欄にしてください。アップロード受付日時とは分けて保存します。</p></div>}
    </div>
    {(lookupId || intent) && <p className="break-all text-sm"><a className="text-blue-700 underline" href={`?upload=${lookupId ?? intent!.operationId}`}>この処理の状態確認リンク</a>
      <span className="block text-gray-600">別の端末でも、OWNERとしてログインしてこのリンクを開くと確認できます。</span></p>}
    {state && <div role="status" aria-live="polite" className="space-y-2 rounded bg-gray-50 p-4">
      <p className="font-semibold">{names[state.status]}</p>
      <p className="text-sm">保存：{state.status === "complete" ? "Azure非公開領域への保存・完全性確認済み" :
        ["uploaded", "submitting", "processing"].includes(state.status) ? "Azureへアップロード済み・保存内容の検証を確認中" :
        state.status === "uploading" ? "アップロード途中" : "保存・完全性確認は未完了"}</p>
      <p className="text-sm">取得日時：{state.sourceAcquiredAt ? new Date(state.sourceAcquiredAt).toLocaleString("ja-JP") + "（申告値）" : "未確認"}</p>
      <progress className="w-full" max={state.byteLength} value={state.uploadedBytes} aria-label="アップロードの進捗" />
      <p className="text-sm">{formatBytes(state.uploadedBytes)} / {formatBytes(state.byteLength)}</p>
      {state.result && <><p>{state.result.disposition === "reused" ? "同じ公報は取込済みです。重複追加はありません。" : "公報データを更新しました。"}</p>
        <p>{state.result.issueNumber}号・公開日 {state.result.publicationDate}：{state.result.documentCount.toLocaleString()}件</p>
        <p className="text-sm">請求項全文の確認済み {state.result.completeClaims.toLocaleString()}件／不足あり {state.result.incompleteClaims.toLocaleString()}件</p>
        <p className="text-sm">次に<Link href="/" className="text-blue-700 underline">案件一覧からウォッチ比較へ進んでください</Link>。取込完了だけでは、期間全体の取得・比較完了にはなりません。比較完了後に納品版を作成し、PDF・CSVを取得します。</p></>}
      {["failed", "outcome_unknown"].includes(state.status) && <p className="text-red-800">{state.status === "failed" ? "取込前の検証で停止しました。正しい公報ZIPか確認してから別のZIPを選択してください。" : "成功・失敗をまだ確定できません。再アップロードせず、状態を確認し、運用担当へ照合を依頼してください。"}正常0件ではありません。</p>}
      {["submitting", "processing"].includes(state.status) && <p className="text-sm">サーバー側で処理しています。状態確認で取込を再実行することはありません。</p>}
    </div>}
    {error && <p role="alert" className="rounded border border-red-300 bg-red-50 p-3 text-red-900">{error}</p>}
    <div className="flex flex-wrap gap-3">
      {canResume && <button type="button" onClick={() => void upload()} disabled={busy || !metadata || (!intent && !file)}
        className="rounded bg-blue-700 px-4 py-2 font-medium text-white disabled:opacity-50">{busy ? "処理中…" : intent ? "同じ処理を再開" : "アップロードして取り込む"}</button>}
      {(intent || lookupId) && <button type="button" onClick={() => void refresh()} disabled={busy || checking}
        className="rounded border border-gray-400 px-4 py-2 disabled:opacity-50">{checking ? "確認中…" : "状態を確認"}</button>}
      {state?.status === "complete" && <button type="button" onClick={nextFile} className="rounded border border-blue-700 px-4 py-2 text-blue-800">次のZIPを選ぶ</button>}
      {state?.status === "failed" && <button type="button" onClick={nextFile} className="rounded border border-gray-400 px-4 py-2">失敗を確認して別のZIPを選ぶ</button>}
    </div>
  </section>;
}
