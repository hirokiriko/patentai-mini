"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function UploadCsvForm({ caseId }: { caseId: number }) {
  const router = useRouter();
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setResult(null);

    const formData = new FormData(e.currentTarget);
    const file = formData.get("file") as File | null;
    if (!file || file.size === 0) return;

    setUploading(true);
    const res = await fetch(`/api/cases/${caseId}/prior-art`, {
      method: "POST",
      body: formData,
    });

    const data = await res.json();
    if (res.ok) {
      setResult(`${data.imported} 件の文献を取り込みました`);
      router.refresh();
    } else {
      setError(data.error ?? "取り込みに失敗しました");
    }
    setUploading(false);
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2">
      <label className="text-sm font-medium text-gray-700">
        J-PlatPat 検索結果 CSV
      </label>
      <div className="flex gap-2">
        <input
          type="file"
          name="file"
          accept=".csv"
          className="flex-1 text-sm file:mr-3 file:rounded file:border-0 file:bg-gray-100 file:px-3 file:py-1.5 file:text-sm file:font-medium hover:file:bg-gray-200"
        />
        <button
          type="submit"
          disabled={uploading}
          className="rounded bg-orange-600 px-4 py-2 text-sm font-medium text-white hover:bg-orange-700 disabled:opacity-50"
        >
          {uploading ? "取り込み中..." : "取り込み"}
        </button>
      </div>
      {result && <p className="text-sm text-green-600">{result}</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </form>
  );
}
