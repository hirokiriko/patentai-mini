"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function NewCaseForm() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;

    setSubmitting(true);
    const res = await fetch("/api/cases", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: title.trim() }),
    });

    if (res.ok) {
      setTitle("");
      router.refresh();
    }
    setSubmitting(false);
  }

  return (
    <form onSubmit={handleSubmit} className="flex gap-2">
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
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
    </form>
  );
}
