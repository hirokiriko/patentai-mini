"use client";

import { useState } from "react";

export function CopyNumber({ value, label }: { value: string; label: string }) {
  const [status, setStatus] = useState<"idle" | "success" | "failed">("idle");
  async function copy() {
    try { await navigator.clipboard.writeText(value); setStatus("success"); }
    catch { setStatus("failed"); }
  }
  return <span className="print-hidden ml-3 inline-flex flex-wrap items-center gap-2 text-sm">
    <button type="button" onClick={copy} className="rounded border border-gray-300 px-3 py-1">{label}をコピー</button>
    <span role="status" aria-live="polite">{status === "success" ? "コピーしました" : status === "failed" ? "コピーできませんでした。番号を選択してコピーしてください。" : ""}</span>
  </span>;
}
