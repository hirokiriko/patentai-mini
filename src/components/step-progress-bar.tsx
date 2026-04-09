"use client";

const STEPS = [
  { num: 1, label: "アップロード" },
  { num: 2, label: "請求項抽出" },
  { num: 3, label: "検索式" },
  { num: 4, label: "CSV取込" },
  { num: 5, label: "分析" },
];

export function StepProgressBar({
  currentStep,
  completedSteps,
}: {
  currentStep: number;
  completedSteps: number[];
}) {
  function scrollTo(step: number) {
    const el = document.getElementById(`step-${step}`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <nav aria-label="進捗ステップ" className="flex items-center justify-between gap-1">
      {STEPS.map((s, i) => {
        const done = completedSteps.includes(s.num);
        const active = currentStep === s.num;
        const clickable = done || active;

        return (
          <div key={s.num} className="flex flex-1 items-center">
            {/* ステップ丸 + ラベル */}
            <button
              type="button"
              disabled={!clickable}
              onClick={() => scrollTo(s.num)}
              className={`
                flex flex-col items-center gap-1 transition-colors
                ${clickable ? "cursor-pointer" : "cursor-default"}
              `}
              aria-label={`ステップ${s.num}: ${s.label}`}
            >
              <span
                className={`
                  flex h-10 w-10 items-center justify-center rounded-full text-base font-bold
                  transition-all duration-300
                  ${
                    done
                      ? "bg-green-600 text-white"
                      : active
                        ? "bg-blue-600 text-white ring-4 ring-blue-200"
                        : "bg-gray-200 text-gray-400"
                  }
                `}
              >
                {done ? "✓" : s.num}
              </span>
              <span
                className={`text-xs font-medium whitespace-nowrap ${
                  done
                    ? "text-green-700"
                    : active
                      ? "text-blue-700"
                      : "text-gray-400"
                }`}
              >
                {s.label}
              </span>
            </button>

            {/* 接続線 */}
            {i < STEPS.length - 1 && (
              <div
                className={`mx-1 h-0.5 flex-1 rounded ${
                  completedSteps.includes(s.num) && completedSteps.includes(STEPS[i + 1].num)
                    ? "bg-green-400"
                    : completedSteps.includes(s.num)
                      ? "bg-green-300"
                      : "bg-gray-200"
                }`}
              />
            )}
          </div>
        );
      })}
    </nav>
  );
}
