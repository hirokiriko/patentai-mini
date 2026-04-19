"use client";

function getAction(
  currentStep: number,
  hasDraft: boolean,
  hasExtracted: boolean,
): { message: string; target: string } | null {
  if (currentStep === 1) {
    if (!hasDraft) {
      return {
        message: "まず、特許案のファイルをアップロードしてください",
        target: "step-1",
      };
    }
    if (!hasExtracted) {
      return {
        message: "次に「請求項を抽出」ボタンを押してください",
        target: "step-1",
      };
    }
  }
  if (currentStep === 3) {
    return {
      message:
        "「検索式を生成」ボタンを押してください。\nまたは、方法 B（個別の特許文献ファイル）で直接取り込み（Step 4）もできます。",
      target: "step-3",
    };
  }
  if (currentStep === 4) {
    return {
      message:
        "J-PlatPat の検索結果 CSV（方法 A）または個別の特許文献ファイル（方法 B）を取り込んでください",
      target: "step-4",
    };
  }
  if (currentStep === 5) {
    return {
      message: "「重なり分析を実行」ボタンを押してください",
      target: "step-5",
    };
  }
  return null; // 全完了
}

export function NextActionBanner({
  currentStep,
  hasDraft,
  hasExtracted,
}: {
  currentStep: number;
  hasDraft: boolean;
  hasExtracted: boolean;
}) {
  const action = getAction(currentStep, hasDraft, hasExtracted);

  if (!action) {
    return (
      <div className="mt-3 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-base font-medium text-green-800">
        すべてのステップが完了しました
      </div>
    );
  }

  function handleScroll() {
    const el = document.getElementById(action!.target);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <div className="mt-3 flex items-center gap-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3">
      <span className="flex-1 whitespace-pre-line text-base font-medium text-blue-800">
        {action.message}
      </span>
      <button
        type="button"
        onClick={handleScroll}
        className="shrink-0 rounded-lg bg-blue-600 px-4 py-2 text-sm font-bold text-white hover:bg-blue-700"
      >
        移動 ↓
      </button>
    </div>
  );
}
