"use client";

interface ActionInput {
  currentStep: number;
  hasDraft: boolean;
  hasExtracted: boolean;
  isBaseMode: boolean;
  hasBase: boolean;
  hasAddition: boolean;
  hasIntegrated: boolean;
}

function getAction(
  input: ActionInput
): { message: string; target: string } | null {
  const {
    currentStep,
    hasDraft,
    hasExtracted,
    isBaseMode,
    hasBase,
    hasAddition,
    hasIntegrated,
  } = input;

  if (currentStep === 1) {
    if (isBaseMode) {
      if (!hasBase) {
        return {
          message: "まず、公開前のベース出願ファイルをアップロードしてください（1-A）",
          target: "step-1",
        };
      }
      if (!hasAddition) {
        return {
          message: "次に、追加したい新規事項のファイルをアップロードしてください（1-B）",
          target: "step-1",
        };
      }
      if (!hasIntegrated) {
        return {
          message: "「ベース出願 + 新規事項を統合する」ボタンを押してください（1-C）",
          target: "step-1",
        };
      }
      if (!hasExtracted) {
        return {
          message: "統合後の発明全体から「請求項を抽出」してください",
          target: "step-1",
        };
      }
    } else {
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
  isBaseMode = false,
  hasBase = false,
  hasAddition = false,
  hasIntegrated = false,
}: {
  currentStep: number;
  hasDraft: boolean;
  hasExtracted: boolean;
  isBaseMode?: boolean;
  hasBase?: boolean;
  hasAddition?: boolean;
  hasIntegrated?: boolean;
}) {
  const action = getAction({
    currentStep,
    hasDraft,
    hasExtracted,
    isBaseMode,
    hasBase,
    hasAddition,
    hasIntegrated,
  });

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
