"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

export function NewCaseForm() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [baseApplicationMode, setBaseApplicationMode] = useState(false);
  const [baseApplicationNumber, setBaseApplicationNumber] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const composingTitleRef = useRef(false);
  const composingNumberRef = useRef(false);

  async function submit() {
    if (!title.trim()) return;

    setSubmitting(true);
    const res = await fetch("/api/cases", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: title.trim(),
        baseApplicationMode,
        baseApplicationNumber: baseApplicationNumber.trim() || null,
      }),
    });

    if (res.ok) {
      setTitle("");
      setBaseApplicationMode(false);
      setBaseApplicationNumber("");
      router.refresh();
    }
    setSubmitting(false);
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
    submit();
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="flex gap-2">
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onCompositionStart={() => {
            composingTitleRef.current = true;
          }}
          onCompositionEnd={(e) => {
            composingTitleRef.current = false;
            setTitle((e.target as HTMLInputElement).value);
          }}
          onKeyDown={(e) => {
            const ime =
              composingTitleRef.current ||
              (e.nativeEvent as KeyboardEvent & { isComposing?: boolean })
                .isComposing ||
              e.keyCode === 229;
            if (ime) return;
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="新しい案件名を入力..."
          className="flex-1 rounded-lg border-2 border-gray-300 px-4 py-3 text-base focus:border-blue-500 focus:outline-none"
        />
        <button
          type="submit"
          disabled={submitting || !title.trim()}
          className="rounded-lg bg-blue-600 px-6 py-3 text-base font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          作成
        </button>
      </div>

      <div className="rounded-lg border-2 border-gray-200 bg-gray-50 px-4 py-3">
        <label className="flex items-start gap-3 text-base">
          <input
            type="checkbox"
            checked={baseApplicationMode}
            onChange={(e) => setBaseApplicationMode(e.target.checked)}
            className="mt-1 h-5 w-5 cursor-pointer"
          />
          <span className="flex-1">
            <span className="font-medium">
              公開前の出願済み特許に新規事項を付け加える特許ですか？
            </span>
            <span className="ml-2 text-sm text-gray-600">
              （国内優先権主張出願 / 特許法 41 条）
            </span>
            <span className="block mt-1 text-sm text-gray-600">
              Yes の場合、ベース出願（公開前）と新規事項の 2 ファイルをアップロードし、
              AI が両者を統合した発明全体に対して先行技術調査を行います。
            </span>
          </span>
        </label>

        {baseApplicationMode && (
          <div className="mt-3 ml-8">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              ベース出願番号（任意・メタ情報のみ）
            </label>
            <input
              type="text"
              value={baseApplicationNumber}
              onChange={(e) => setBaseApplicationNumber(e.target.value)}
              onCompositionStart={() => {
                composingNumberRef.current = true;
              }}
              onCompositionEnd={(e) => {
                composingNumberRef.current = false;
                setBaseApplicationNumber((e.target as HTMLInputElement).value);
              }}
              onKeyDown={(e) => {
                const ime =
                  composingNumberRef.current ||
                  (e.nativeEvent as KeyboardEvent & { isComposing?: boolean })
                    .isComposing ||
                  e.keyCode === 229;
                if (ime) return;
                if (e.key === "Enter") {
                  e.preventDefault();
                  submit();
                }
              }}
              placeholder="例: 特願2026-40454"
              className="w-full rounded-lg border-2 border-gray-300 px-3 py-2 text-base focus:border-blue-500 focus:outline-none"
            />
          </div>
        )}
      </div>
    </form>
  );
}
