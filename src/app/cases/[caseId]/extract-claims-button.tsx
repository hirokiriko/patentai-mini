"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { getNetworkErrorMessage, readApiResponse } from "@/lib/api-response";

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

    try {
      const res = await fetch(
        `/api/cases/${caseId}/draft/${draftId}/extract`,
        { method: "POST" }
      );
      const result = await readApiResponse<unknown>(res, "抽出に失敗しました");

      if (!result.ok) {
        setError(result.error);
        return;
      }

      router.refresh();
      setTimeout(() => {
        document.getElementById("step-3")?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      }, 300);
    } catch (err) {
      setError(getNetworkErrorMessage(err, "抽出に失敗しました"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="inline-flex items-center gap-3">
      <button
        onClick={handleClick}
        disabled={loading}
        className="rounded-lg bg-green-600 px-6 py-3 text-base font-medium text-white hover:bg-green-700 disabled:opacity-50"
      >
        {loading ? (
          <span className="inline-flex items-center gap-2">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
            抽出中（しばらくお待ちください）...
          </span>
        ) : hasExtracted ? (
          "再抽出"
        ) : (
          "請求項を抽出"
        )}
      </button>
      {error && <span className="text-sm text-red-600">{error}</span>}
    </div>
  );
}
