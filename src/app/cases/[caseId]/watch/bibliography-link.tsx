/** Native navigation deliberately has no Next.js route prefetch or background read. */
export function BibliographyLink({ caseId, findingId }: { caseId: number; findingId: number }) {
  return <a className="print-hidden mt-3 inline-block text-sm text-indigo-700 underline" href={`/cases/${caseId}/watch/findings/${findingId}`}>出願人・書誌を確認</a>;
}
