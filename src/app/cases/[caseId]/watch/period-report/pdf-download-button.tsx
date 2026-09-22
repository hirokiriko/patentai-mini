"use client";

import { useState } from "react";
import type { WatchPeriod } from "@/lib/patent-watch/period";

export function PdfDownloadButton({ caseId, period }: { caseId: number; period: WatchPeriod }) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  async function download() {
    if (pending) return;
    setPending(true); setMessage("PDFを生成しています。");
    try {
      const response = await fetch(`/api/cases/${caseId}/watch/period-report.pdf?from=${period.from}&to=${period.to}`, { cache: "no-store" });
      if (!response.ok || response.headers.get("content-type") !== "application/pdf") {
        setMessage(response.status === 413 ? "対象が多いため期間を短くしてください。" : "PDFを生成できませんでした。期間画面で内容を確認してください。");
        return;
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url; link.download = `period-report-${caseId}-${period.from}-${period.to}.pdf`;
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      setMessage("PDFのダウンロードを開始しました。保存先はブラウザーの設定に従います。");
    } catch { setMessage("PDFを取得できませんでした。期間画面で内容を確認してください。"); }
    finally { setPending(false); }
  }
  return <div className="print-hidden">
    <button type="button" disabled={pending} onClick={download} className="rounded bg-indigo-700 px-4 py-2 text-white disabled:opacity-50">{pending ? "PDFを生成中…" : "PDFをダウンロード"}</button>
    <p role="status" className="mt-1 text-sm">{message}</p>
  </div>;
}
