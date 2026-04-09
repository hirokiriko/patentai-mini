"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useToast } from "@/components/toast";

export function UploadDraftForm({ caseId }: { caseId: number }) {
  const router = useRouter();
  const { show } = useToast();
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileSelected, setFileSelected] = useState(false);

  const canSubmit = fileSelected && !uploading;

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canSubmit) {
      if (!fileSelected) show("先に「ファイルを選択」してから、アップロードしてください");
      return;
    }
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
      setTimeout(() => {
        document.getElementById("step-1")?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      }, 300);
    } else {
      const data = await res.json();
      setError(data.error ?? "アップロードに失敗しました");
    }
    setUploading(false);
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <label className="text-base font-medium text-gray-700">
        特許案ファイル（PDF / DOCX / TXT）
      </label>
      <div className="flex gap-2">
        <input
          type="file"
          name="file"
          accept=".pdf,.docx,.txt"
          onChange={(e) => setFileSelected(!!e.target.files?.length)}
          className="flex-1 text-base file:mr-3 file:rounded file:border-0 file:bg-gray-100 file:px-4 file:py-2.5 file:text-base file:font-medium hover:file:bg-gray-200"
        />
        <button
          type="submit"
          aria-disabled={!canSubmit}
          className={`rounded-lg px-6 py-3 text-base font-medium text-white ${
            canSubmit
              ? "bg-blue-600 hover:bg-blue-700"
              : "bg-blue-600 opacity-50 cursor-not-allowed"
          }`}
        >
          {uploading ? "アップロード中..." : "アップロード"}
        </button>
      </div>
      {error && <p className="text-base text-red-600">{error}</p>}
    </form>
  );
}
