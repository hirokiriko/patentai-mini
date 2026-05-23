"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { getNetworkErrorMessage, readApiResponse } from "@/lib/api-response";

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

    try {
      const res = await fetch(`/api/cases/${caseId}/analyze`, {
        method: "POST",
      });
      const result = await readApiResponse<unknown>(res, "分析に失敗しました");

      if (!result.ok) {
        setError(result.error);
        return;
      }

      router.refresh();
      setTimeout(() => {
        document.getElementById("step-5")?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      }, 300);
    } catch (err) {
      setError(getNetworkErrorMessage(err, "分析に失敗しました"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      <button
        onClick={handleClick}
        disabled={loading}
        className="rounded-lg bg-red-600 px-6 py-3 text-base font-medium text-white hover:bg-red-700 disabled:opacity-50"
      >
        {loading ? (
          <span className="inline-flex items-center gap-2">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
            分析中（数十秒かかります）...
          </span>
        ) : hasResults ? (
          "再分析"
        ) : (
          "重なり分析を実行"
        )}
      </button>
      {error && <span className="text-base text-red-600">{error}</span>}
    </div>
  );
}
