"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function UploadDraftForm({ caseId }: { caseId: number }) {
  const router = useRouter();
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    const formData = new FormData(e.currentTarget);
    const file = formData.get("file") as File | null;
    if (!file || file.size === 0) return;

    setUploading(true);
    const res = await fetch(`/api/cases/${caseId}/draft`, {
      method: "POST",
      body: formData,
    });

    if (res.ok) {
      router.refresh();
    } else {
      const data = await res.json();
      setError(data.error ?? "アップロードに失敗しました");
    }
    setUploading(false);
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2">
      <label className="text-sm font-medium text-gray-700">
        特許案ファイル（PDF / DOCX / TXT）
      </label>
      <div className="flex gap-2">
        <input
          type="file"
          name="file"
          accept=".pdf,.docx,.txt"
          className="flex-1 text-sm file:mr-3 file:rounded file:border-0 file:bg-gray-100 file:px-3 file:py-1.5 file:text-sm file:font-medium hover:file:bg-gray-200"
        />
        <button
          type="submit"
          disabled={uploading}
          className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {uploading ? "アップロード中..." : "アップロード"}
        </button>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </form>
  );
}
