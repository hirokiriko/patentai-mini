"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function AnalyzeButton({
  caseId,
  hasResults,
}: {
  caseId: number;
  hasResults: boolean;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setLoading(true);
    setError(null);

    const res = await fetch(`/api/cases/${caseId}/analyze`, {
      method: "POST",
    });

    if (res.ok) {
      router.refresh();
    } else {
      const data = await res.json();
      setError(data.error ?? "分析に失敗しました");
    }
    setLoading(false);
  }

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={handleClick}
        disabled={loading}
        className="rounded bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
      >
        {loading
          ? "分析中（数十秒かかります）..."
          : hasResults
            ? "再分析"
            : "重なり分析を実行"}
      </button>
      {error && <span className="text-sm text-red-600">{error}</span>}
    </div>
  );
}
