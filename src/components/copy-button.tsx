"use client";

import { useState } from "react";

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // フォールバック: execCommand
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={`shrink-0 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
        copied
          ? "bg-green-100 text-green-700 border border-green-300"
          : "bg-gray-100 text-gray-700 border border-gray-300 hover:bg-gray-200"
      }`}
    >
      {copied ? "✓ コピーしました" : "コピー"}
    </button>
  );
}
