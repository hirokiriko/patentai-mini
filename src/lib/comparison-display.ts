/** Display-only projection; never apply to stored source text, evidence or digests. */
export function comparisonExplanation(text: string): string {
  // Split source quotations first, including nested Japanese quotation marks.
  // Only a lone quoted tier after an unquoted assessment heading is a label.
  const parts = text.split(/(「[^」]*」|『[^』]*』|“[^”]*”|"[^"\n]*")/u);
  for (let i = parts.length - 2; i > 0; i -= 2) {
    const tier = parts[i].match(/^[「『“"](High|Medium|Low|Unknown|高|中|低)[」』”"]$/iu);
    if (tier && /(?:リスク(?:段階|評価|ラベル|レベル)?|危険度|risk(?:\s+(?:level|label))?)\s*[:：=はが]?\s*$/iu.test(parts[i - 1])) {
      parts[i - 1] += tier[1] + parts[i + 1]; parts[i] = ""; parts[i + 1] = "";
    }
  }
  return parts.map((part, index) => {
    if (index % 2) return part;
    return part
      .replace(/(?:リスク(?:段階|評価|ラベル|レベル)?|危険度|risk(?:\s+(?:level|label))?)\s*[:：=はが]?\s*(?:High|Medium|Low|Unknown|高(?:い)?|中(?:程度)?|低(?:い)?)(?=$|[\s、。，,.;；:：)）】]|です|である|と)(?:です|である|と(?:評価|判定|判断)(?:される|します|する)?)?/giu, "原文確認が必要")
      .replace(/(?:高い?|中(?:程度の)?|低い?)リスク(?=$|[\s、。，,.;；:：)）】]|です|である|と)/gu, "原文確認が必要")
      .replace(/\b(?:High|Medium|Low|Unknown)\s*(?:リスク|risk\b)/giu, "原文確認が必要")
      .replace(/\b(?:High|Medium|Low|Unknown)(?:と(?:評価|判定|判断)(?:される|します|する)?|評価|判定|相当)/gu, "原文確認が必要")
      .replace(/(^|[\n。]\s*)(?:High|Medium|Low|Unknown)\s*[:：]\s*/gu, "$1")
      .replace(/\b(?:High|Medium|Low|Unknown)(?=$|[、。，,.;；（(]|です|である|であり)/gu, (label, offset: number, source: string) =>
        label === "Unknown" && /(?:(?:実行|処理|取得|Job)(?:結果|状態)?|状態)\s*[:：=]?\s*$/iu.test(source.slice(0, offset)) ? label : "原文確認が必要");
  }).join("");
}

export function comparisonAnalysisDisplay<T extends { matchedElements: string[]; unmatchedElements: string[]; explanation: string }>(analysis: T): T {
  return { ...analysis, matchedElements: analysis.matchedElements.map(comparisonExplanation),
    unmatchedElements: analysis.unmatchedElements.map(comparisonExplanation), explanation: comparisonExplanation(analysis.explanation) };
}

/** Stable identifiers, independent of the retained internal analysis labels/scores. */
export const comparePublicationNumbers = (left: string, right: string): number => left.localeCompare(right, "ja", { numeric: true });
