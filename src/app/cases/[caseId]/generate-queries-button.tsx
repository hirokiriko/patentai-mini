"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function GenerateQueriesButton({
  caseId,
  hasQueries,
}: {
  caseId: number;
  hasQueries: boolean;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setLoading(true);
    setError(null);

    const res = await fetch(`/api/cases/${caseId}/queries`, {
      method: "POST",
    });

    if (res.ok) {
      router.refresh();
    } else {
      const data = await res.json();
      setError(data.error ?? "検索式生成に失敗しました");
    }
    setLoading(false);
  }

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={handleClick}
        disabled={loading}
        className="rounded bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-700 disabled:opacity-50"
      >
        {loading
          ? "生成中..."
          : hasQueries
            ? "検索式を再生成"
            : "検索式を生成"}
      </button>
      {error && <span className="text-sm text-red-600">{error}</span>}
    </div>
  );
}
