"use client";

import { useState } from "react";
import { previousWatchPeriod, type WatchPeriod } from "@/lib/patent-watch/period";

export function PeriodSelector({ caseId, initialPeriod }: { caseId: number; initialPeriod?: WatchPeriod }) {
  const [period, setPeriod] = useState<WatchPeriod>(initialPeriod ?? { from: "", to: "" });
  return (
    <form action={`/cases/${caseId}/watch/period-report`} method="get" className="print-hidden my-6 rounded-lg border border-gray-300 p-4">
      <h2 className="font-semibold">集計する期間を選ぶ</h2>
      <p className="mt-1 text-sm text-gray-600">監視実行開始日（日本時間）を指定します。両端を含め最大31日です。</p>
      <div className="my-3 flex gap-3">
        <button type="button" onClick={() => setPeriod(previousWatchPeriod("week"))} className="rounded border border-indigo-300 px-3 py-1">前週（月曜〜日曜）</button>
        <button type="button" onClick={() => setPeriod(previousWatchPeriod("month"))} className="rounded border border-indigo-300 px-3 py-1">前月</button>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm">開始日<input type="date" name="from" required value={period.from} onChange={event => setPeriod({ ...period, from: event.target.value })} className="mt-1 block rounded border border-gray-400 p-2" /></label>
        <label className="text-sm">終了日<input type="date" name="to" required value={period.to} onChange={event => setPeriod({ ...period, to: event.target.value })} className="mt-1 block rounded border border-gray-400 p-2" /></label>
        <button type="submit" className="rounded bg-indigo-700 px-4 py-2 font-semibold text-white">期間レポートを表示</button>
      </div>
    </form>
  );
}
