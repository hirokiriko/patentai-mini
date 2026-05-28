export type ClaimCheckSeverity = "info" | "warning" | "needsReview";

export type ClaimCheckCategory =
  | "ambiguousExpression"
  | "supportCandidate"
  | "termConsistency"
  | "antecedentReference"
  | "claimDependency"
  | "general";

export type ClaimCheckSource = "rule" | "dictionary";

export type ClaimCheckItem = {
  id: string;
  category: ClaimCheckCategory;
  severity: ClaimCheckSeverity;
  title: string;
  target?: string;
  claimNumber?: number;
  message: string;
  reason: string;
  suggestions: string[];
  source: ClaimCheckSource;
};

export type ClaimDraftCheckResult = {
  summary: string;
  items: ClaimCheckItem[];
  humanCheckpoints: string[];
  disclaimer: string;
};

const DISCLAIMER =
  "この候補は請求項ドラフトの人手レビューを補助するものです。特許性・新規性・進歩性・記載要件の法的判断を行うものではありません。最終判断は知財担当者・弁理士等が行ってください。";

const AMBIGUOUS_TERMS = [
  "約",
  "程度",
  "略",
  "ほぼ",
  "実質的に",
  "適宜",
  "必要に応じて",
  "任意",
  "所定",
  "十分",
  "高い",
  "低い",
  "大きい",
  "小さい",
  "好ましい",
  "等",
  "など",
  "可能",
  "できる",
  "望ましい",
  "適切",
  "最適",
] as const;

const TERM_VARIATION_GROUPS = [
  ["サーバ", "サーバー"],
  ["ユーザ", "ユーザー"],
  ["コンピュータ", "コンピューター"],
  ["センサ", "センサー"],
  ["データベース", "DB"],
  ["スマホ", "スマートフォン", "携帯端末"],
  ["アプリ", "アプリケーション", "プログラム"],
  ["自動車", "車両", "乗物"],
  ["電池", "バッテリー", "蓄電池"],
  ["AI", "人工知能", "機械学習"],
] as const;

const GENERIC_TERMS = new Set([
  "請求項",
  "発明",
  "方法",
  "装置",
  "手段",
  "工程",
  "処理",
  "構成",
  "特徴",
  "場合",
  "前記",
  "当該",
  "上記",
  "一つ",
  "複数",
  "情報",
  "データ",
  "システム",
  "プログラム",
]);

function normalizeText(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isAsciiTerm(value: string): boolean {
  return /^[a-z0-9 ]+$/i.test(value);
}

function includesTerm(text: string, term: string): boolean {
  if (!term.trim()) return false;
  if (isAsciiTerm(term)) {
    return new RegExp(
      `(^|[^A-Za-z0-9])${escapeRegExp(term)}([^A-Za-z0-9]|$)`,
      "i"
    ).test(text);
  }

  return new RegExp(`${escapeRegExp(term)}(?![ァ-ヶー])`, "u").test(text);
}

function isTermChar(value: string): boolean {
  return /[一-龥々〆ヵヶぁ-んァ-ヶーA-Za-z0-9]/u.test(value);
}

function includesVariationTerm(text: string, term: string): boolean {
  const normalizedText = normalizeText(text);
  const normalizedTerm = normalizeText(term);
  if (isAsciiTerm(normalizedTerm)) {
    return includesTerm(normalizedText, normalizedTerm);
  }

  let index = normalizedText.indexOf(normalizedTerm);
  while (index >= 0) {
    const prev = index > 0 ? normalizedText[index - 1] : "";
    const next = normalizedText[index + normalizedTerm.length] ?? "";
    if ((!prev || !isTermChar(prev)) && (!next || !isTermChar(next))) {
      return true;
    }
    index = normalizedText.indexOf(normalizedTerm, index + normalizedTerm.length);
  }

  return false;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.trim().length > 0)));
}

function toHalfWidthNumber(value: string): number | null {
  const normalized = value.normalize("NFKC");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function compactInput(values: (string | null | undefined)[]): string {
  return values.filter((value): value is string => !!value?.trim()).join("\n");
}

function buildSupportText(input: {
  claims: string[];
  specificationText?: string | null;
  abstract?: string | null;
  problem?: string | null;
  effect?: string | null;
  elements?: string[] | null;
}): string {
  let supportText = compactInput([
    input.specificationText,
    input.abstract,
    input.problem,
    input.effect,
    ...(input.elements ?? []),
  ]);

  for (const claim of input.claims) {
    if (claim.trim()) {
      supportText = supportText.split(claim).join(" ");
    }
  }

  return supportText;
}

function extractCandidateTerms(claims: string[], elements: string[]): string[] {
  const candidates: string[] = [];
  for (const element of elements) candidates.push(element);

  for (const claim of claims) {
    const matches = claim.match(/[一-龥々〆ヵヶァ-ヶーA-Za-z0-9]{2,}/gu) ?? [];
    candidates.push(...matches);
  }

  return unique(
    candidates
      .map((term) => term.trim())
      .filter((term) => term.length >= 2)
      .filter((term) => !GENERIC_TERMS.has(term))
      .filter((term) => !/^\d+$/.test(term.normalize("NFKC")))
  ).slice(0, 30);
}

function parseClaimReferences(claim: string): number[] {
  const refs: number[] = [];
  const regex =
    /請求項\s*([0-9０-９]+(?:\s*(?:、|,|又は|または|および|及び|ないし|から|-|～|〜)\s*[0-9０-９]+)*)/g;
  for (const match of claim.matchAll(regex)) {
    const numbers = match[1]?.match(/[0-9０-９]+/g) ?? [];
    for (const numberText of numbers) {
      const value = toHalfWidthNumber(numberText);
      if (value !== null) refs.push(value);
    }
  }
  return unique(refs.map(String)).map(Number);
}

function addItem(items: ClaimCheckItem[], item: ClaimCheckItem): void {
  if (items.some((existing) => existing.id === item.id)) return;
  items.push(item);
}

export function buildClaimDraftCheck(input: {
  claims?: string[] | null;
  specificationText?: string | null;
  abstract?: string | null;
  problem?: string | null;
  effect?: string | null;
  elements?: string[] | null;
}): ClaimDraftCheckResult {
  try {
    const claims = (input.claims ?? []).filter((claim) => claim.trim().length > 0);
    const items: ClaimCheckItem[] = [];
    const humanCheckpoints = [
      "請求項内の用語と、明細書本文・要約・課題・効果で使われている用語が対応しているか確認してください。",
      "前記・当該・該などの参照語が、読み手にとって自然に追えるか確認してください。",
      "従属請求項がある場合は、引用先の請求項番号と引用範囲を確認してください。",
    ];

    if (claims.length === 0) {
      return {
        summary: "請求項テキストがないため、請求項記載チェックは実行していません。",
        items: [],
        humanCheckpoints,
        disclaimer: DISCLAIMER,
      };
    }

    claims.forEach((claim, index) => {
      const claimNumber = index + 1;
      for (const term of AMBIGUOUS_TERMS) {
        if (!includesTerm(claim, term)) continue;
        addItem(items, {
          id: `ambiguous-${claimNumber}-${term}`,
          category: "ambiguousExpression",
          severity: term === "所定" || term === "等" ? "warning" : "info",
          title: "曖昧表現の確認候補",
          target: term,
          claimNumber,
          message: `請求項${claimNumber}に「${term}」という表現があります。`,
          reason:
            "読み手によって範囲や条件の受け取り方が変わる可能性があるため、人手で確認する候補として表示しています。",
          suggestions: [
            "必要に応じて、数値範囲・条件・対象物・判断基準を本文側で補足できているか確認してください。",
            "表現を残す場合も、明細書内で意味が自然に追えるか確認してください。",
          ],
          source: "dictionary",
        });
      }
    });

    const elements = input.elements ?? [];
    const supportText = buildSupportText({ ...input, claims });
    const normalizedSupportText = normalizeText(supportText);
    const claimTerms = extractCandidateTerms(claims, elements);

    for (const term of claimTerms) {
      if (items.filter((item) => item.category === "supportCandidate").length >= 5) {
        break;
      }
      if (normalizeText(term).length < 2) continue;
      if (normalizedSupportText.includes(normalizeText(term))) continue;
      addItem(items, {
        id: `support-${normalizeText(term)}`,
        category: "supportCandidate",
        severity: "info",
        title: "明細書本文との用語照合候補",
        target: term,
        message: `請求項側の用語「${term}」について、要約・課題・効果・本文側で同じ表現が十分に見えるか確認してください。`,
        reason:
          "請求項だけに現れるように見える用語は、本文側の説明との対応を人手で確認すると安全です。",
        suggestions: [
          "同じ表現または対応する言い換えが、明細書本文に含まれているか確認してください。",
          "本文側では別表現を使っている場合、用語の対応関係が読み手に伝わるか確認してください。",
        ],
        source: "rule",
      });
    }

    const allClaimsText = claims.join("\n");
    for (const group of TERM_VARIATION_GROUPS) {
      const found = group.filter((term) =>
        includesVariationTerm(allClaimsText, term)
      );
      if (found.length < 2) continue;
      addItem(items, {
        id: `term-consistency-${found.join("-")}`,
        category: "termConsistency",
        severity: "info",
        title: "用語の揺れ確認候補",
        target: found.join(" / "),
        message: `請求項内で ${found.join(" / ")} の表記が混在している可能性があります。`,
        reason:
          "同じ概念を指す語が複数ある場合、検索式やレビュー時に対応関係を確認しやすくするため表示しています。",
        suggestions: [
          "同じ概念を指す場合は、代表語を決めるか、本文側で対応関係を説明できているか確認してください。",
          "あえて別概念として使う場合は、違いが読み取れる記載になっているか確認してください。",
        ],
        source: "dictionary",
      });
    }

    claims.forEach((claim, index) => {
      const claimNumber = index + 1;
      const refs = claim.match(/前記|当該|該|上記|前述/g) ?? [];
      if (refs.length === 0) return;
      addItem(items, {
        id: `antecedent-${claimNumber}`,
        category: "antecedentReference",
        severity: claimNumber === 1 ? "warning" : "info",
        title: "参照語の確認候補",
        target: unique(refs).join(" / "),
        claimNumber,
        message: `請求項${claimNumber}に参照語（${unique(refs).join(" / ")}）があります。`,
        reason:
          "前記・当該・該などの語は、参照先が自然に追えるかを人手で確認すると安全です。",
        suggestions: [
          "参照語の直前または前段に、対応する構成要素が明確に現れているか確認してください。",
          "複数の候補に読める場合は、対象物を具体的に言い換えられるか確認してください。",
        ],
        source: "rule",
      });
    });

    claims.forEach((claim, index) => {
      const claimNumber = index + 1;
      const refs = parseClaimReferences(claim);
      if (refs.length === 0) return;
      const missingRefs = refs.filter((ref) => ref < 1 || ref > claims.length);
      const selfRefs = refs.filter((ref) => ref === claimNumber);
      const severity: ClaimCheckSeverity =
        missingRefs.length > 0 || selfRefs.length > 0 || claimNumber === 1
          ? "needsReview"
          : "info";
      addItem(items, {
        id: `dependency-${claimNumber}-${refs.join("-")}`,
        category: "claimDependency",
        severity,
        title: "請求項間の引用関係確認",
        target: `引用先: ${refs.join(", ")}`,
        claimNumber,
        message: `請求項${claimNumber}は請求項${refs.join(", ")}を参照しているように見えます。`,
        reason:
          "引用先番号や引用範囲は、請求項間の関係を読むうえで重要なため確認候補として表示しています。",
        suggestions: [
          missingRefs.length > 0
            ? `存在しない可能性のある引用先（${missingRefs.join(", ")}）がないか確認してください。`
            : "引用先の請求項番号が意図どおりか確認してください。",
          selfRefs.length > 0
            ? "自分自身を参照しているように見える箇所がないか確認してください。"
            : "複数請求項を引用する場合、引用範囲が広すぎないか確認してください。",
        ],
        source: "rule",
      });
    });

    const limitedItems = items.slice(0, 14);
    return {
      summary:
        limitedItems.length === 0
          ? "主要な確認候補は検出されませんでした。人手レビューでは用語の一貫性と参照関係を確認してください。"
          : `請求項ドラフトの人手確認候補を ${limitedItems.length} 件表示しています。`,
      items: limitedItems,
      humanCheckpoints,
      disclaimer: DISCLAIMER,
    };
  } catch {
    return {
      summary: "請求項記載チェックを安全にスキップしました。",
      items: [],
      humanCheckpoints: [
        "請求項・本文・構成要素の対応は、最終的に人手で確認してください。",
      ],
      disclaimer: DISCLAIMER,
    };
  }
}
