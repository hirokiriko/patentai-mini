"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { getNetworkErrorMessage, readApiResponse } from "@/lib/api-response";

export function IntegrateButton({
  caseId,
  enabled,
  hasIntegrated,
}: {
  caseId: number;
  enabled: boolean;
  hasIntegrated: boolean;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setLoading(true);
    setError(null);

    try {
      const res = await fetch(`/api/cases/${caseId}/integrate`, {
        method: "POST",
      });
      const result = await readApiResponse<unknown>(res, "統合に失敗しました");

      if (!result.ok) {
        setError(result.error);
        return;
      }

      router.refresh();
      setTimeout(() => {
        document.getElementById("step-1")?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      }, 300);
    } catch (err) {
      setError(getNetworkErrorMessage(err, "統合に失敗しました"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="inline-flex items-center gap-3">
      <button
        onClick={handleClick}
        disabled={loading || !enabled}
        className="rounded-lg bg-purple-600 px-6 py-3 text-base font-medium text-white hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {loading ? (
          <span className="inline-flex items-center gap-2">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
            統合中（しばらくお待ちください）...
          </span>
        ) : hasIntegrated ? (
          "再統合"
        ) : (
          "ベース出願 + 新規事項を統合する"
        )}
      </button>
      {error && <span className="text-sm text-red-600">{error}</span>}
    </div>
  );
}
