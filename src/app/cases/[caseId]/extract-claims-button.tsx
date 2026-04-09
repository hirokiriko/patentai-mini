"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function ExtractClaimsButton({
  caseId,
  draftId,
  hasExtracted,
}: {
  caseId: number;
  draftId: number;
  hasExtracted: boolean;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setLoading(true);
    setError(null);

    const res = await fetch(
      `/api/cases/${caseId}/draft/${draftId}/extract`,
      { method: "POST" }
    );

    if (res.ok) {
      router.refresh();
    } else {
      const data = await res.json();
      setError(data.error ?? "抽出に失敗しました");
    }
    setLoading(false);
  }

  return (
    <div className="inline-flex items-center gap-2">
      <button
        onClick={handleClick}
        disabled={loading}
        className="rounded bg-green-600 px-3 py-1 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
      >
        {loading
          ? "抽出中..."
          : hasExtracted
            ? "再抽出"
            : "請求項を抽出"}
      </button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}
