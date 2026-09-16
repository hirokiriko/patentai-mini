import { notFound } from "next/navigation";
import { patentWatchRepo } from "@/repositories";
import { readFindingBibliography } from "@/lib/patent-watch/bibliography";
import { periodCaseId } from "@/lib/patent-watch/period";
import { BibliographyView } from "./bibliography-view";

export const dynamic = "force-dynamic";
export default async function FindingBibliographyPage({ params }: { params: Promise<{ caseId: string; findingId: string }> }) {
  const values = await params;
  const caseId = periodCaseId(values.caseId), findingId = periodCaseId(values.findingId);
  if (caseId === null || findingId === null) notFound();
  const result = await readFindingBibliography(patentWatchRepo, caseId, findingId);
  if (result.kind === "not_found") notFound();
  return <BibliographyView caseId={caseId} result={result} />;
}
