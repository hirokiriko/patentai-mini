"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

const UNKNOWN_RESULT_MESSAGE =
  "作成結果を確認できませんでした。再作成する前に案件一覧を更新してください。";

export function NewCaseForm() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [baseApplicationMode, setBaseApplicationMode] = useState(false);
  const [baseApplicationNumber, setBaseApplicationNumber] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<"input" | "unknown" | null>(null);
  const inFlightRef = useRef<AbortController | null>(null);
  const composingTitleRef = useRef(false);
  const composingNumberRef = useRef(false);

  useEffect(() => () => inFlightRef.current?.abort(), []);

  async function submit() {
    if (
      !title.trim() ||
      inFlightRef.current ||
      composingTitleRef.current ||
      composingNumberRef.current
    )
      return;

    const controller = new AbortController();
    inFlightRef.current = controller;
    setSubmitting(true);
    setError(null);
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch("/api/cases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          baseApplicationMode,
          baseApplicationNumber: baseApplicationNumber.trim() || null,
        }),
        signal: controller.signal,
      });

      // An aborted request may still have been saved by the server.
      if (controller.signal.aborted) {
        setError("unknown");
      } else if (res.ok) {
        setTitle("");
        setBaseApplicationMode(false);
        setBaseApplicationNumber("");
        router.refresh();
      } else {
        setError(res.status === 400 || res.status === 422 ? "input" : "unknown");
      }
    } catch {
      setError("unknown");
    } finally {
      clearTimeout(timer);
      inFlightRef.current = null;
      setSubmitting(false);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const native = e.nativeEvent as Event & { isComposing?: boolean };
    if (
      composingTitleRef.current ||
      composingNumberRef.current ||
      native.isComposing
    )
      return;
    void submit();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== "Enter") return;
    // Also suppress implicit form submission when IME confirmation reports 229.
    e.preventDefault();
    if (
      composingTitleRef.current ||
      composingNumberRef.current ||
      e.nativeEvent.isComposing ||
      e.keyCode === 229
    )
      return;
    void submit();
  }

  return (
    <form onSubmit={handleSubmit} aria-busy={submitting} className="space-y-3">
      <div className="flex gap-2">
        <input
          type="text"
          value={title}
          disabled={submitting}
          onChange={(e) => setTitle(e.target.value)}
          onCompositionStart={() => {
            composingTitleRef.current = true;
          }}
          onCompositionEnd={(e) => {
            composingTitleRef.current = false;
            setTitle((e.target as HTMLInputElement).value);
          }}
          onKeyDown={handleKeyDown}
          placeholder="新しい案件名を入力..."
          className="flex-1 rounded-lg border-2 border-gray-300 px-4 py-3 text-base focus:border-blue-500 focus:outline-none"
        />
        <button
          type="submit"
          disabled={submitting || !title.trim()}
          className="rounded-lg bg-blue-600 px-6 py-3 text-base font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {submitting ? "作成中…" : "作成"}
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <p role="alert">
            {error === "input"
              ? "入力内容を確認して、もう一度作成してください。"
              : UNKNOWN_RESULT_MESSAGE}
          </p>
          {error === "unknown" && (
            <button
              type="button"
              onClick={() => router.refresh()}
              className="mt-2 underline underline-offset-2"
            >
              案件一覧を更新
            </button>
          )}
        </div>
      )}

      <div className="rounded-lg border-2 border-gray-200 bg-gray-50 px-4 py-3">
        <label className="flex items-start gap-3 text-base">
          <input
            type="checkbox"
            checked={baseApplicationMode}
            disabled={submitting}
            onChange={(e) => setBaseApplicationMode(e.target.checked)}
            className="mt-1 h-5 w-5 cursor-pointer"
          />
          <span className="flex-1">
            <span className="font-medium">
              公開前のベース出願に新規事項を追加して調査する
            </span>
            <span className="ml-2 text-sm text-gray-600">
              （特殊ケース・通常の新規出願前調査ではオフで OK）
            </span>
            <span className="block mt-1 text-sm text-gray-600">
              オンにすると、作成後の案件詳細画面で「1-A ベース出願（公開前）」「1-B 新規事項」の
              2 ファイルをアップロードし、AI が両者を統合した発明全体に対して先行技術調査を行います。
              この試用版では、ベース出願・新規事項とも完全架空の資料だけを使用してください。
            </span>
          </span>
        </label>

        <details className="mt-3 ml-8 rounded-md border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700">
          <summary className="cursor-pointer font-medium text-gray-800">
            Q. どんな場合に使うオプションですか？
          </summary>
          <p className="mt-2">
            国内優先権主張出願や、出願済みの発明に追加構成を加えて別出願を検討する場合など、
            通常の新規出願前調査とは前提が異なるときの補助です。
            本アプリはベース出願と新規事項を統合した調査用テキストを作りますが、
            国内優先権の可否や補正可否などの法的判断は行いません。
          </p>
        </details>

        {baseApplicationMode && (
          <div className="mt-3 ml-8">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              ベース出願番号（任意・メタ情報のみ）
            </label>
            <input
              type="text"
              value={baseApplicationNumber}
              disabled={submitting}
              onChange={(e) => setBaseApplicationNumber(e.target.value)}
              onCompositionStart={() => {
                composingNumberRef.current = true;
              }}
              onCompositionEnd={(e) => {
                composingNumberRef.current = false;
                setBaseApplicationNumber((e.target as HTMLInputElement).value);
              }}
              onKeyDown={handleKeyDown}
              placeholder="例: 特願2026-40454"
              className="w-full rounded-lg border-2 border-gray-300 px-3 py-2 text-base focus:border-blue-500 focus:outline-none"
            />
          </div>
        )}
      </div>
    </form>
  );
}
