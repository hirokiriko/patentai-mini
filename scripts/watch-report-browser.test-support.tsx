import { createRoot } from "react-dom/client";
import { PatentWatchSection } from "../src/app/cases/[caseId]/watch/watch-section";
import { PeriodReportView } from "../src/app/cases/[caseId]/watch/period-report/report-view";
import type { PeriodReportResult } from "../src/lib/patent-watch/period-report";

// Compiled only by the opt-in loopback harness. No mock fetch or product endpoint.
const root = document.getElementById("interactive");
if (root) {
  const data = JSON.parse(document.getElementById("fixture-props")!.textContent!) as {
    caseId: number; view: "period" | "case"; period?: { from: string; to: string }; result?: PeriodReportResult; invalidQuery?: boolean;
  };
  createRoot(root).render(data.view === "period"
    ? <PeriodReportView {...data} /> : <PatentWatchSection caseId={data.caseId} />);
}
// Single-run server page is rendered by its actual async Page; only client hydration
// of its print button is represented by this one event in the thin harness.
document.querySelectorAll("button[data-harness-print]").forEach(button => button.addEventListener("click", () => window.print()));
