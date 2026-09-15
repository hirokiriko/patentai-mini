import { notFound } from "next/navigation";
import { patentWatchRepo } from "@/repositories";
import { parsePeriodQuery, periodCaseId } from "@/lib/patent-watch/period";
import { readPeriodReport } from "@/lib/patent-watch/period-report";
import { PeriodReportView } from "./report-view";

export const dynamic = "force-dynamic";

export default async function PatentWatchPeriodReportPage({ params, searchParams }: {
  params: Promise<{ caseId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const caseId = periodCaseId((await params).caseId);
  if (caseId === null) notFound();
  const query = parsePeriodQuery(await searchParams);
  if (query.kind !== "valid") return <PeriodReportView caseId={caseId} invalidQuery={query.kind === "invalid"} />;
  const result = await readPeriodReport(patentWatchRepo, caseId, query.period);
  if (result.kind === "not_found") notFound();
  return <PeriodReportView caseId={caseId} period={query.period} result={result} />;
}
