import { createRoot } from "react-dom/client";
import { PatentWatchSection } from "../src/app/cases/[caseId]/watch/watch-section";
import { BibliographyView } from "../src/app/cases/[caseId]/watch/findings/[findingId]/bibliography-view";
import { PeriodReportView } from "../src/app/cases/[caseId]/watch/period-report/report-view";
import type { BibliographyResult } from "../src/lib/patent-watch/bibliography";
import type { PeriodReportResult } from "../src/lib/patent-watch/period-report";

const root = document.getElementById("interactive");
if (root) {
  const data = JSON.parse(document.getElementById("fixture-props")!.textContent!) as {
    caseId: number; view: "bibliography" | "case" | "period"; result: BibliographyResult & PeriodReportResult;
  };
  // Only the clipboard transport is replaced for the explicit refusal fixture.
  if (document.documentElement.dataset.clipboard === "deny") Object.defineProperty(navigator, "clipboard", {
    value: { writeText: async () => { throw Error("fictional_clipboard_denied"); } }, configurable: true,
  });
  createRoot(root).render(data.view === "bibliography" ? <BibliographyView {...data} />
    : data.view === "period" ? <PeriodReportView {...data} /> : <PatentWatchSection caseId={data.caseId} />);
}
