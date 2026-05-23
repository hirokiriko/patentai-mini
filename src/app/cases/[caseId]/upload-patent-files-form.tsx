"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useToast } from "@/components/toast";
import { getNetworkErrorMessage, readApiResponse } from "@/lib/api-response";

const MB = 1024 * 1024;
const WARN_BYTES = 16 * MB;
const BLOCK_BYTES = 20 * MB;

function formatMB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

type PriorArtUploadResponse = {
  imported?: number;
  errors?: string[];
};

export function UploadPatentFilesForm({ caseId }: { caseId: number }) {
  const router = useRouter();
  const { show } = useToast();
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileCount, setFileCount] = useState(0);
  const [totalBytes, setTotalBytes] = useState(0);

  const overBlock = totalBytes > BLOCK_BYTES;
  const overWarn = totalBytes > WARN_BYTES;
  const canSubmit = fileCount > 0 && !uploading && !overBlock;

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    setFileCount(files.length);
    setTotalBytes(files.reduce((sum, f) => sum + f.size, 0));
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canSubmit) {
      if (fileCount === 0) {
        show("先に「ファイルを選択」してから、取り込みしてください");
      } else if (overBlock) {
        show(
          `合計 ${formatMB(totalBytes)} はこのアプリの処理上限 (${formatMB(BLOCK_BYTES)}) を超えるため送信できません。ファイルを分割するか軽いものだけ選び直してください。`
        );
      }
      return;
    }
    setError(null);
    setResult(null);

    const formData = new FormData(e.currentTarget);
    const files = formData.getAll("file") as File[];
    if (files.length === 0 || files.every((f) => f.size === 0)) return;

    setUploading(true);
    try {
      const res = await fetch(`/api/cases/${caseId}/prior-art`, {
        method: "POST",
        body: formData,
      });
      const result = await readApiResponse<PriorArtUploadResponse>(
        res,
        "取り込みに失敗しました"
      );

      if (!result.ok) {
        setError(result.error);
        return;
      }

      const data = result.data;
      setResult(`${data.imported ?? 0} 件の文献を取り込みました`);
      if (data.errors && data.errors.length > 0) {
        setError(data.errors.join("\n"));
      }
      router.refresh();
      setTimeout(() => {
        document.getElementById("step-5")?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      }, 300);
    } catch (err) {
      setError(getNetworkErrorMessage(err, "取り込みに失敗しました"));
    } finally {
      setUploading(false);
    }
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
          onChange={handleFileChange}
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
            : `取り込み${fileCount > 0 ? `（${fileCount}件 / ${formatMB(totalBytes)}）` : ""}`}
        </button>
      </div>
      {overBlock && (
        <p className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-base text-red-700">
          合計 {formatMB(totalBytes)}：このアプリの処理上限 ({formatMB(BLOCK_BYTES)}) を超えています。分割してアップロードしてください。
        </p>
      )}
      {!overBlock && overWarn && (
        <p className="rounded-lg border border-yellow-300 bg-yellow-50 px-3 py-2 text-base text-yellow-800">
          合計 {formatMB(totalBytes)}：大きなファイルは解析に時間がかかります。失敗する場合はファイルを減らしてください。
        </p>
      )}
      {result && <p className="text-base text-green-600">{result}</p>}
      {error && (
        <p className="text-base text-red-600 whitespace-pre-line">{error}</p>
      )}
    </form>
  );
}
