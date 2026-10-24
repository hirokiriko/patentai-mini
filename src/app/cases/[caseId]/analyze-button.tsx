import Link from "next/link";

export function AnalyzeButton({ caseId }: { caseId: number; hasResults: boolean }) {
  return <Link href={`/cases/${caseId}/comparison`} className="inline-block rounded-lg bg-red-600 px-6 py-3 text-base font-medium text-white hover:bg-red-700">
    文献・請求項を選んで根拠付き比較
  </Link>;
}
