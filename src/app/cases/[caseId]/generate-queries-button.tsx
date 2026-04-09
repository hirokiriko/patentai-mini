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
      setTimeout(() => {
        document.getElementById("step-3-guide")?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      }, 300);
    } else {
      const data = await res.json();
      setError(data.error ?? "検索式生成に失敗しました");
    }
    setLoading(false);
  }

  return (
    <div className="flex items-center gap-3">
      <button
        onClick={handleClick}
        disabled={loading}
        className="rounded-lg bg-purple-600 px-6 py-3 text-base font-medium text-white hover:bg-purple-700 disabled:opacity-50"
      >
        {loading ? (
          <span className="inline-flex items-center gap-2">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
            生成中（しばらくお待ちください）...
          </span>
        ) : hasQueries ? (
          "検索式を再生成"
        ) : (
          "検索式を生成"
        )}
      </button>
      {error && <span className="text-base text-red-600">{error}</span>}
    </div>
  );
}
