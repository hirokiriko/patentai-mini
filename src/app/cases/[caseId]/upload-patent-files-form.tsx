"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useToast } from "@/components/toast";

export function UploadPatentFilesForm({ caseId }: { caseId: number }) {
  const router = useRouter();
  const { show } = useToast();
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileCount, setFileCount] = useState(0);

  const canSubmit = fileCount > 0 && !uploading;

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canSubmit) {
      if (fileCount === 0)
        show("先に「ファイルを選択」してから、取り込みしてください");
      return;
    }
    setError(null);
    setResult(null);

    const formData = new FormData(e.currentTarget);
    const files = formData.getAll("file") as File[];
    if (files.length === 0 || files.every((f) => f.size === 0)) return;

    setUploading(true);
    const res = await fetch(`/api/cases/${caseId}/prior-art`, {
      method: "POST",
      body: formData,
    });

    const data = await res.json();
    if (res.ok) {
      setResult(`${data.imported} 件の文献を取り込みました`);
      if (data.errors?.length > 0) {
        setError(data.errors.join("\n"));
      }
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
        個別特許ファイル（PDF / DOCX / TXT）※複数選択可
      </label>
      <div className="flex gap-2">
        <input
          type="file"
          name="file"
          accept=".pdf,.docx,.txt"
          multiple
          onChange={(e) => setFileCount(e.target.files?.length ?? 0)}
          className="flex-1 text-base file:mr-3 file:rounded file:border-0 file:bg-gray-100 file:px-4 file:py-2.5 file:text-base file:font-medium hover:file:bg-gray-200"
        />
        <button
          type="submit"
          aria-disabled={!canSubmit}
          className={`rounded-lg px-6 py-3 text-base font-medium text-white whitespace-nowrap ${
            canSubmit
              ? "bg-orange-600 hover:bg-orange-700"
              : "bg-orange-600 opacity-50 cursor-not-allowed"
          }`}
        >
          {uploading
            ? "取り込み中..."
            : `取り込み${fileCount > 0 ? `（${fileCount}件）` : ""}`}
        </button>
      </div>
      {result && <p className="text-base text-green-600">{result}</p>}
      {error && (
        <p className="text-base text-red-600 whitespace-pre-line">{error}</p>
      )}
    </form>
  );
}
