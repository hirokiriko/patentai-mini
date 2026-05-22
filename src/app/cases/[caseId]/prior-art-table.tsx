"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/toast";
import { parseUploadedOriginalFileMetadata } from "@/lib/original-file-metadata";
import type { PriorArtDocument } from "@/repositories/types";

interface Props {
  caseId: number;
  priorArts: PriorArtDocument[];
}

export function PriorArtTable({ caseId, priorArts }: Props) {
  const router = useRouter();
  const { show } = useToast();
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [deleting, setDeleting] = useState(false);

  const allChecked = priorArts.length > 0 && selectedIds.size === priorArts.length;
  const someChecked = selectedIds.size > 0 && !allChecked;

  function toggleOne(docId: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(docId)) next.delete(docId);
      else next.add(docId);
      return next;
    });
  }

  function toggleAll() {
    setSelectedIds((prev) => {
      if (prev.size === priorArts.length) return new Set();
      return new Set(priorArts.map((pa) => pa.docId));
    });
  }

  async function handleDelete() {
    if (selectedIds.size === 0) return;
    const count = selectedIds.size;
    if (!confirm(`選択した ${count} 件を削除しますか？\n（重なり分析の結果も影響を受ける可能性があります）`)) return;

    setDeleting(true);
    try {
      const res = await fetch(`/api/cases/${caseId}/prior-art`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ docIds: Array.from(selectedIds) }),
      });
      const data = await res.json();
      if (!res.ok) {
        show(data.error ?? "削除に失敗しました");
        return;
      }
      show(`${data.deleted} 件を削除しました`);
      setSelectedIds(new Set());
      router.refresh();
    } catch (err) {
      console.error("delete prior-art failed:", err);
      show("削除中にエラーが発生しました");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-base text-gray-700">
          取り込み済み: {priorArts.length} 件
          {selectedIds.size > 0 && (
            <span className="ml-2 text-sm text-blue-700">
              ／ {selectedIds.size} 件選択中
            </span>
          )}
        </p>
        <button
          type="button"
          onClick={handleDelete}
          disabled={selectedIds.size === 0 || deleting}
          className={`rounded px-4 py-1.5 text-sm font-medium ${
            selectedIds.size === 0 || deleting
              ? "bg-gray-200 text-gray-500 cursor-not-allowed"
              : "bg-red-600 text-white hover:bg-red-700"
          }`}
        >
          {deleting
            ? "削除中..."
            : selectedIds.size === 0
              ? "削除（行を選択してください）"
              : `選択した ${selectedIds.size} 件を削除`}
        </button>
      </div>
      <div className="max-h-80 overflow-auto rounded-lg border border-gray-200">
        <table className="w-full text-base">
          <thead className="sticky top-0 bg-gray-100">
            <tr>
              <th className="w-10 px-3 py-2.5 text-center">
                <input
                  type="checkbox"
                  checked={allChecked}
                  ref={(input) => {
                    if (input) input.indeterminate = someChecked;
                  }}
                  onChange={toggleAll}
                  aria-label="全選択"
                />
              </th>
              <th className="px-4 py-2.5 text-left font-medium text-gray-700">
                文献番号
              </th>
              <th className="px-4 py-2.5 text-left font-medium text-gray-700">
                名称
              </th>
              <th className="px-4 py-2.5 text-left font-medium text-gray-700">
                種別
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {priorArts.map((pa) => {
              const originalFile = parseUploadedOriginalFileMetadata(pa.sourceCsvRowJson);

              return (
                <tr
                  key={pa.docId}
                  className={`hover:bg-gray-50 ${
                    selectedIds.has(pa.docId) ? "bg-blue-50" : ""
                  }`}
                >
                  <td className="w-10 px-3 py-2.5 text-center">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(pa.docId)}
                      onChange={() => toggleOne(pa.docId)}
                      aria-label={`${pa.publicationNo ?? pa.title ?? "文献"} を選択`}
                    />
                  </td>
                  <td className="px-4 py-2.5 font-mono text-sm whitespace-nowrap">
                    {pa.publicationNo ?? "—"}
                  </td>
                  <td className="px-4 py-2.5">
                    {originalFile?.originalFileName ?? pa.title}
                  </td>
                  <td className="px-4 py-2.5 text-sm text-gray-500 whitespace-nowrap">
                    <div className="flex flex-col gap-1">
                      <span>{pa.publicationNo ? "CSV" : "ファイル"}</span>
                      {originalFile && (
                        <span className="w-fit rounded border border-sky-200 bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-700">
                          Azure Blob saved
                        </span>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
