"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useToast } from "@/components/toast";

export function UploadCsvForm({ caseId }: { caseId: number }) {
  const router = useRouter();
  const { show } = useToast();
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileSelected, setFileSelected] = useState(false);

  const canSubmit = fileSelected && !uploading;

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canSubmit) {
      if (!fileSelected) show("先に「ファイルを選択」してから、取り込みしてください");
      return;
    }
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
      setTimeout(() => {
        document.getElementById("step-5")?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      }, 300);
    } else {
      setError(data.error ?? "取り込みに失敗しました");
    }
    setUploading(false);
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <label className="text-base font-medium text-gray-700">
        J-PlatPat 検索結果 CSV
      </label>
      <div className="flex gap-2">
        <input
          type="file"
          name="file"
          accept=".csv"
          onChange={(e) => setFileSelected(!!e.target.files?.length)}
          className="flex-1 text-base file:mr-3 file:rounded file:border-0 file:bg-gray-100 file:px-4 file:py-2.5 file:text-base file:font-medium hover:file:bg-gray-200"
        />
        <button
          type="submit"
          aria-disabled={!canSubmit}
          className={`rounded-lg px-6 py-3 text-base font-medium text-white ${
            canSubmit
              ? "bg-orange-600 hover:bg-orange-700"
              : "bg-orange-600 opacity-50 cursor-not-allowed"
          }`}
        >
          {uploading ? "取り込み中..." : "取り込み"}
        </button>
      </div>
      {result && <p className="text-base text-green-600">{result}</p>}
      {error && <p className="text-base text-red-600">{error}</p>}
    </form>
  );
}
