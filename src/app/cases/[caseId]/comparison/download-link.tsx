"use client";
import { useState } from "react";

export function DownloadLink({ href, format }: { href: string; format: "pdf" | "csv" }) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  return <span><a href={href} aria-disabled={busy} className="text-blue-700 underline" onClick={async event => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setMessage("");
    try {
      const response = await fetch(href, { cache: "no-store" });
      if (!response.ok) throw Error();
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a"); link.href = url; link.download = `comparison.${format}`;
      link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { setMessage("取得できませんでした。保存結果を再読込して確認してください。AIは再実行しません。"); }
    finally { setBusy(false); }
  }}>{format.toUpperCase()}を取得</a>{message && <span role="alert" className="block text-sm text-red-700">{message}</span>}</span>;
}
