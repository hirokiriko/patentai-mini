"use client";

import { useRouter } from "next/navigation";
import { useState, type ChangeEvent, type FormEvent } from "react";

const SEARCH_LIMIT = 50;
const MAX_SELECTED_DOCUMENTS = 50;
const STORAGE_UNAVAILABLE_MESSAGE =
  "この環境では公報コーパスがまだ利用可能になっていません";

type KohoCorpusSearchItem = {
  documentId: number;
  packageType: string;
  parseStatus: string;
  kind: string | null;
  publicationNumber: string;
  applicationNumber: string;
  publicationDate: string;
  inventionTitle: string;
  abstractPreview: string | null;
};

type SearchState =
  | "idle"
  | "loading"
  | "success"
  | "validation-error"
  | "storage-unavailable"
  | "error";

type AttachResult = {
  selected: number;
  inserted: number;
  updated: number;
  unchanged: number;
  analysisCleared: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSearchItem(value: unknown): value is KohoCorpusSearchItem {
  if (!isRecord(value)) return false;
  return (
    Number.isSafeInteger(value.documentId) &&
    (value.documentId as number) > 0 &&
    typeof value.packageType === "string" &&
    typeof value.parseStatus === "string" &&
    (typeof value.kind === "string" || value.kind === null) &&
    typeof value.publicationNumber === "string" &&
    typeof value.applicationNumber === "string" &&
    typeof value.publicationDate === "string" &&
    typeof value.inventionTitle === "string" &&
    (typeof value.abstractPreview === "string" || value.abstractPreview === null)
  );
}

function isAttachResult(value: unknown): value is AttachResult {
  if (!isRecord(value)) return false;
  return (
    Number.isSafeInteger(value.selected) &&
    Number.isSafeInteger(value.inserted) &&
    Number.isSafeInteger(value.updated) &&
    Number.isSafeInteger(value.unchanged) &&
    typeof value.analysisCleared === "boolean"
  );
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function errorCode(value: unknown): string | null {
  if (!isRecord(value) || typeof value.error !== "string") return null;
  return value.error;
}

function formatPublicationDate(value: string): string {
  if (!/^\d{8}$/.test(value)) return value;
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

export function KohoCorpusPicker({ caseId }: { caseId: number }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [searchState, setSearchState] = useState<SearchState>("idle");
  const [searchMessage, setSearchMessage] = useState<string | null>(null);
  const [items, setItems] = useState<KohoCorpusSearchItem[]>([]);
  const [selectedDocumentIds, setSelectedDocumentIds] = useState<Set<number>>(
    () => new Set(),
  );
  const [selectionMessage, setSelectionMessage] = useState<string | null>(null);
  const [attaching, setAttaching] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [attachResult, setAttachResult] = useState<AttachResult | null>(null);

  function handleQueryChange(event: ChangeEvent<HTMLInputElement>) {
    setQuery(event.target.value);
    setSearchState("idle");
    setSearchMessage(null);
    setItems([]);
    setSelectedDocumentIds(new Set());
    setSelectionMessage(null);
    setAttachError(null);
    setAttachResult(null);
  }

  async function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (searchState === "loading" || attaching) return;

    const normalizedQuery = query.trim();
    const queryLength = Array.from(normalizedQuery).length;
    if (queryLength < 2 || queryLength > 100) {
      setSearchState("validation-error");
      setSearchMessage("検索語は2〜100文字で入力してください");
      return;
    }

    setSearchState("loading");
    setSearchMessage(null);
    setAttachError(null);
    setAttachResult(null);

    try {
      const params = new URLSearchParams({
        q: normalizedQuery,
        limit: String(SEARCH_LIMIT),
      });
      const response = await fetch(
        `/api/cases/${caseId}/koho-corpus?${params.toString()}`,
      );
      const payload = await readJson(response);

      if (!response.ok) {
        const code = errorCode(payload);
        if (response.status === 503 || code === "koho_corpus_unavailable") {
          setSearchState("storage-unavailable");
          setSearchMessage(STORAGE_UNAVAILABLE_MESSAGE);
        } else if (response.status === 400) {
          setSearchState("validation-error");
          setSearchMessage("検索条件を確認してください");
        } else if (response.status === 404 || code === "case_not_found") {
          setSearchState("error");
          setSearchMessage("案件が見つかりません");
        } else {
          setSearchState("error");
          setSearchMessage("公報コーパスの検索に失敗しました");
        }
        return;
      }

      if (
        !isRecord(payload) ||
        !Array.isArray(payload.items) ||
        !payload.items.every(isSearchItem)
      ) {
        setSearchState("error");
        setSearchMessage("公報コーパスの検索に失敗しました");
        return;
      }

      setItems(payload.items);
      setSelectedDocumentIds(new Set());
      setSelectionMessage(null);
      setSearchState("success");
    } catch {
      setSearchState("error");
      setSearchMessage("通信に失敗しました。時間をおいて再度お試しください");
    }
  }

  function handleSelection(documentId: number, checked: boolean) {
    if (
      checked &&
      !selectedDocumentIds.has(documentId) &&
      selectedDocumentIds.size >= MAX_SELECTED_DOCUMENTS
    ) {
      setSelectionMessage("選択できる公報は最大50件です");
      return;
    }

    const next = new Set(selectedDocumentIds);
    if (checked) {
      next.add(documentId);
    } else {
      next.delete(documentId);
    }
    setSelectedDocumentIds(next);
    setSelectionMessage(null);
    setAttachError(null);
  }

  async function handleAttach(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (attaching || searchState === "loading") return;

    const documentIds = Array.from(selectedDocumentIds);
    if (
      documentIds.length === 0 ||
      documentIds.length > MAX_SELECTED_DOCUMENTS
    ) {
      setAttachError("追加する公報を1〜50件選択してください");
      return;
    }

    setAttaching(true);
    setAttachError(null);
    setAttachResult(null);

    try {
      const response = await fetch(`/api/cases/${caseId}/koho-corpus`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ documentIds }),
      });
      const payload = await readJson(response);

      if (!response.ok) {
        const code = errorCode(payload);
        if (response.status === 503 || code === "koho_corpus_unavailable") {
          setAttachError(STORAGE_UNAVAILABLE_MESSAGE);
        } else if (code === "koho_document_not_found") {
          setAttachError(
            "選択した公報が見つかりません。再検索して選び直してください",
          );
        } else if (code === "ambiguous_publication_selection") {
          setAttachError(
            "同じ公開番号の公報が複数選択されています。1件だけ選択してください",
          );
        } else if (response.status === 404 || code === "case_not_found") {
          setAttachError("案件が見つかりません");
        } else if (response.status === 400) {
          setAttachError("選択内容を確認してください");
        } else {
          setAttachError("公報を案件へ追加できませんでした");
        }
        return;
      }

      if (!isAttachResult(payload)) {
        setAttachError("公報を案件へ追加できませんでした");
        return;
      }

      setAttachResult(payload);
      setSelectedDocumentIds(new Set());
      router.refresh();
    } catch {
      setAttachError("通信に失敗しました。時間をおいて再度お試しください");
    } finally {
      setAttaching(false);
    }
  }

  const selectionAtLimit =
    selectedDocumentIds.size >= MAX_SELECTED_DOCUMENTS;

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-medium text-gray-700">
          取り込み済み公報から追加（任意）
        </h3>
        <p className="mt-1 text-sm text-gray-600">
          公開番号・出願番号・発明名称を入力し、検索ボタンを押してください。
        </p>
      </div>

      <form onSubmit={handleSearch} className="flex flex-col gap-2 sm:flex-row">
        <label htmlFor="koho-corpus-query" className="sr-only">
          取り込み済み公報を検索
        </label>
        <input
          id="koho-corpus-query"
          type="search"
          value={query}
          onChange={handleQueryChange}
          disabled={searchState === "loading" || attaching}
          placeholder="公開番号・出願番号・発明名称（2〜100文字）"
          aria-invalid={searchState === "validation-error"}
          className="min-w-0 flex-1 rounded-lg border border-gray-300 px-3 py-2.5 text-base focus:border-orange-500 focus:outline-none focus:ring-2 focus:ring-orange-100"
        />
        <button
          type="submit"
          disabled={searchState === "loading" || attaching}
          className="rounded-lg bg-orange-600 px-6 py-2.5 text-base font-medium text-white hover:bg-orange-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {searchState === "loading" ? "検索中..." : "検索"}
        </button>
      </form>

      {searchState === "loading" && (
        <p role="status" className="text-sm text-gray-600">
          公報コーパスを検索しています...
        </p>
      )}
      {(searchState === "validation-error" ||
        searchState === "storage-unavailable" ||
        searchState === "error") &&
        searchMessage && (
          <p
            role="alert"
            className={`rounded-lg border px-3 py-2 text-sm ${
              searchState === "storage-unavailable"
                ? "border-amber-300 bg-amber-50 text-amber-900"
                : "border-red-300 bg-red-50 text-red-700"
            }`}
          >
            {searchMessage}
          </p>
        )}

      {searchState === "success" && items.length === 0 && (
        <p className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-600">
          該当する公報はありませんでした。
        </p>
      )}

      {searchState === "success" && items.length > 0 && (
        <form onSubmit={handleAttach} className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-gray-600">
            <p>検索結果 {items.length}件</p>
            <p>
              最大50件まで選択できます（選択中 {selectedDocumentIds.size}件）
            </p>
          </div>

          <ul className="space-y-2">
            {items.map((item) => {
              const selected = selectedDocumentIds.has(item.documentId);
              return (
                <li
                  key={item.documentId}
                  className="rounded-lg border border-gray-200 bg-white px-3 py-3"
                >
                  <label className="flex cursor-pointer items-start gap-3">
                    <input
                      type="checkbox"
                      checked={selected}
                      disabled={attaching || (selectionAtLimit && !selected)}
                      onChange={(event) =>
                        handleSelection(item.documentId, event.target.checked)
                      }
                      className="mt-1 h-4 w-4 rounded border-gray-300 text-orange-600 focus:ring-orange-500"
                    />
                    <span className="min-w-0 flex-1 space-y-2">
                      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <span className="font-mono text-sm font-medium text-gray-900">
                          {item.publicationNumber}
                        </span>
                        <span className="text-xs text-gray-500">
                          公開日: {formatPublicationDate(item.publicationDate)}
                        </span>
                        <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-700">
                          kind: {item.kind ?? "—"}
                        </span>
                        <span className="rounded bg-sky-50 px-2 py-0.5 text-xs text-sky-800">
                          parse status: {item.parseStatus}
                        </span>
                      </span>
                      <span className="block text-sm font-medium text-gray-800">
                        {item.inventionTitle}
                      </span>
                      {item.abstractPreview && (
                        <span className="block text-sm leading-relaxed text-gray-600">
                          {item.abstractPreview}
                        </span>
                      )}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>

          {selectionMessage && (
            <p role="alert" className="text-sm text-red-700">
              {selectionMessage}
            </p>
          )}
          {attachError && (
            <p
              role="alert"
              className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700"
            >
              {attachError}
            </p>
          )}
          {attachResult && (
            <div
              role="status"
              className="rounded-lg border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-800"
            >
              <p>
                selected {attachResult.selected}件 / insert{" "}
                {attachResult.inserted}件 / update {attachResult.updated}件 /
                unchanged {attachResult.unchanged}件
              </p>
              {attachResult.analysisCleared && (
                <p className="mt-1 font-medium">
                  比較対象が変わったため重なり分析を再実行してください
                </p>
              )}
            </div>
          )}

          <button
            type="submit"
            disabled={attaching || selectedDocumentIds.size === 0}
            className="rounded-lg bg-orange-600 px-6 py-2.5 text-base font-medium text-white hover:bg-orange-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {attaching
              ? "追加中..."
              : `選択した公報を追加（${selectedDocumentIds.size}件）`}
          </button>
        </form>
      )}
    </div>
  );
}
