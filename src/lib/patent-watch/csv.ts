import {
  boundedPatentWatchPublicText,
  sanitizePatentWatchAnalysis,
  sanitizePatentWatchPublicText,
} from "./domain";
import type {
  CaseWatchFinding,
  PatentWatchAnalysisJson,
} from "./types";

export const PATENT_WATCH_CSV_COLUMNS = [
  "公開番号",
  "公開日",
  "kind",
  "発明名称",
  "risk label",
  "lexical score",
  "element score",
  "semantic score",
  "structural score",
  "一致候補",
  "差分候補",
  "説明",
  "分析mode",
  "確認状態",
] as const;

function parseAnalysis(value: string): PatentWatchAnalysisJson {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("matchedElements" in parsed) ||
      !Array.isArray(parsed.matchedElements) ||
      !parsed.matchedElements.every((item) => typeof item === "string") ||
      !("unmatchedElements" in parsed) ||
      !Array.isArray(parsed.unmatchedElements) ||
      !parsed.unmatchedElements.every((item) => typeof item === "string") ||
      !("explanation" in parsed) ||
      typeof parsed.explanation !== "string"
    ) {
      throw new Error("invalid analysis");
    }
    return sanitizePatentWatchAnalysis({
      matchedElements: parsed.matchedElements,
      unmatchedElements: parsed.unmatchedElements,
      explanation: parsed.explanation,
    });
  } catch {
    return {
      matchedElements: [],
      unmatchedElements: [],
      explanation: "分析内容を表示できません。人による確認が必要です",
    };
  }
}

function neutralizeFormula(value: string): string {
  return /^[\p{White_Space}\p{Cf}\p{Cc}]*[=+\-@]/u.test(value)
    ? `'${value}`
    : value;
}

function csvCell(value: string | number): string {
  const publicValue = neutralizeFormula(
    sanitizePatentWatchPublicText(String(value)),
  );
  if (/[,"\r\n]/u.test(publicValue)) {
    return `"${publicValue.replace(/"/gu, '""')}"`;
  }
  return publicValue;
}

function findingRow(finding: CaseWatchFinding): Array<string | number> {
  const analysis = parseAnalysis(finding.analysisJson);
  return [
    boundedPatentWatchPublicText(finding.publicationNumber, 100),
    finding.publicationDate,
    finding.kind,
    boundedPatentWatchPublicText(finding.inventionTitle, 500),
    finding.riskLabel,
    finding.lexicalScore,
    finding.elementScore,
    finding.semanticScore,
    finding.structuralScore,
    analysis.matchedElements.join(" / "),
    analysis.unmatchedElements.join(" / "),
    analysis.explanation,
    finding.analysisMode,
    finding.reviewStatus,
  ];
}

/** Excel等でもUTF-8判定しやすいBOM付きRFC 4180形式。 */
export function buildPatentWatchReportCsv(
  findings: readonly CaseWatchFinding[],
): string {
  const rows = [
    PATENT_WATCH_CSV_COLUMNS.map(csvCell).join(","),
    ...findings.map((finding) => findingRow(finding).map(csvCell).join(",")),
  ];
  return `\uFEFF${rows.join("\r\n")}\r\n`;
}
