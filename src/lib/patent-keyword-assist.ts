export type PatentKeywordAssistItem = {
  centerTerm: string;
  synonyms: string[];
  broaderTerms: string[];
  narrowerTerms: string[];
  patentTerms: string[];
  englishKeywords: string[];
  leakageWarnings: string[];
  broadWarnings: string[];
  humanReviewPoints: string[];
};

type PatentKeywordAssistEntry = PatentKeywordAssistItem & {
  triggers: string[];
};

const ENTRIES: PatentKeywordAssistEntry[] = [
  {
    centerTerm: "\u30a2\u30a4\u30b9\u30af\u30ea\u30fc\u30e0",
    triggers: [
      "\u30a2\u30a4\u30b9\u30af\u30ea\u30fc\u30e0",
      "\u30a2\u30a4\u30b9",
      "\u51b7\u83d3",
      "\u6c37\u83d3",
      "ice cream",
      "frozen confection",
    ],
    synonyms: [
      "\u30a2\u30a4\u30b9",
      "\u51b7\u83d3",
      "\u6c37\u83d3",
      "\u51b7\u51cd\u83d3\u5b50",
    ],
    broaderTerms: [
      "\u98df\u54c1",
      "\u83d3\u5b50",
      "\u51b7\u51cd\u98df\u54c1",
    ],
    narrowerTerms: [
      "\u30bd\u30d5\u30c8\u30af\u30ea\u30fc\u30e0",
      "\u30b7\u30e3\u30fc\u30d9\u30c3\u30c8",
      "\u6c37\u83d3\u30d0\u30fc",
    ],
    patentTerms: [
      "\u51b7\u83d3\u7d44\u6210\u7269",
      "\u51b7\u51cd\u83d3\u5b50\u88fd\u9020\u65b9\u6cd5",
      "\u51b7\u83d3\u88fd\u9020\u88c5\u7f6e",
    ],
    englishKeywords: ["ice cream", "frozen confection"],
    leakageWarnings: [
      "\u30a2\u30a4\u30b9\u3060\u3051\u3067\u306f\u6c37\u3084\u51b7\u5374\u4e00\u822c\u306e\u6587\u732e\u304c\u6df7\u3056\u308b\u53ef\u80fd\u6027\u304c\u3042\u308a\u307e\u3059\u3002",
    ],
    broadWarnings: [
      "\u98df\u54c1\u3084\u83d3\u5b50\u3060\u3051\u3067\u306f\u5e83\u3059\u304e\u308b\u305f\u3081\u3001\u6750\u6599\u30fb\u51b7\u51cd\u30fb\u88fd\u9020\u5de5\u7a0b\u306e\u8a9e\u3068\u7d44\u307f\u5408\u308f\u305b\u3066\u78ba\u8a8d\u3057\u3066\u304f\u3060\u3055\u3044\u3002",
    ],
    humanReviewPoints: [
      "J-PlatPat \u3067\u306f\u51b7\u83d3\u3001\u6c37\u83d3\u3001\u51b7\u51cd\u83d3\u5b50\u306e\u8868\u8a18\u5dee\u3092\u5225\u3005\u306b\u78ba\u8a8d\u3057\u3066\u304f\u3060\u3055\u3044\u3002",
    ],
  },
  {
    centerTerm: "\u81ea\u52d5\u8eca",
    triggers: [
      "\u81ea\u52d5\u8eca",
      "\u8eca",
      "\u8eca\u4e21",
      "\u79fb\u52d5\u4f53",
      "\u4e57\u7269",
      "vehicle",
      "automobile",
    ],
    synonyms: [
      "\u8eca",
      "\u8eca\u4e21",
      "\u4e57\u7269",
    ],
    broaderTerms: [
      "\u79fb\u52d5\u4f53",
      "\u4ea4\u901a\u6a5f\u68b0",
      "\u642c\u9001\u88c5\u7f6e",
    ],
    narrowerTerms: [
      "\u96fb\u6c17\u81ea\u52d5\u8eca",
      "\u30cf\u30a4\u30d6\u30ea\u30c3\u30c9\u8eca",
      "\u81ea\u5f8b\u8d70\u884c\u8eca",
    ],
    patentTerms: [
      "\u8eca\u4e21\u5236\u5fa1\u88c5\u7f6e",
      "\u79fb\u52d5\u4f53\u5236\u5fa1\u65b9\u6cd5",
      "\u8eca\u8f09\u88c5\u7f6e",
    ],
    englishKeywords: ["vehicle", "automobile"],
    leakageWarnings: [
      "\u81ea\u52d5\u8eca\u3060\u3051\u3067\u306f\u8eca\u4e21\u3001\u79fb\u52d5\u4f53\u3001\u8eca\u8f09\u88c5\u7f6e\u306e\u6587\u732e\u3092\u53d6\u308a\u3053\u307c\u3059\u53ef\u80fd\u6027\u304c\u3042\u308a\u307e\u3059\u3002",
    ],
    broadWarnings: [
      "\u79fb\u52d5\u4f53\u306f\u30ed\u30dc\u30c3\u30c8\u3084\u822a\u7a7a\u4f53\u307e\u3067\u5e83\u304c\u308b\u305f\u3081\u3001\u7528\u9014\u3084\u5236\u5fa1\u5bfe\u8c61\u3067\u7d5e\u308a\u8fbc\u3093\u3067\u304f\u3060\u3055\u3044\u3002",
    ],
    humanReviewPoints: [
      "\u8eca\u4e21\u3068\u79fb\u52d5\u4f53\u306e\u3069\u3061\u3089\u304c\u8acb\u6c42\u9805\u306e\u8868\u73fe\u306b\u8fd1\u3044\u304b\u3092\u78ba\u8a8d\u3057\u3066\u304f\u3060\u3055\u3044\u3002",
    ],
  },
  {
    centerTerm: "\u30b9\u30de\u30db",
    triggers: [
      "\u30b9\u30de\u30db",
      "\u30b9\u30de\u30fc\u30c8\u30d5\u30a9\u30f3",
      "\u643a\u5e2f\u7aef\u672b",
      "\u60c5\u5831\u51e6\u7406\u7aef\u672b",
      "\u901a\u4fe1\u7aef\u672b",
      "smartphone",
      "mobile terminal",
    ],
    synonyms: [
      "\u643a\u5e2f\u7aef\u672b",
      "\u60c5\u5831\u51e6\u7406\u7aef\u672b",
      "\u901a\u4fe1\u7aef\u672b",
    ],
    broaderTerms: [
      "\u60c5\u5831\u51e6\u7406\u88c5\u7f6e",
      "\u901a\u4fe1\u88c5\u7f6e",
      "\u7aef\u672b\u88c5\u7f6e",
    ],
    narrowerTerms: [
      "\u30b9\u30de\u30fc\u30c8\u30d5\u30a9\u30f3",
      "\u643a\u5e2f\u96fb\u8a71",
      "\u30e2\u30d0\u30a4\u30eb\u7aef\u672b",
    ],
    patentTerms: [
      "\u7aef\u672b\u88c5\u7f6e",
      "\u60c5\u5831\u51e6\u7406\u7aef\u672b",
      "\u901a\u4fe1\u7aef\u672b",
    ],
    englishKeywords: ["smartphone", "mobile terminal"],
    leakageWarnings: [
      "\u30b9\u30de\u30db\u306f\u53e3\u8a9e\u7684\u306a\u305f\u3081\u3001\u7279\u8a31\u6587\u732e\u3067\u306f\u643a\u5e2f\u7aef\u672b\u3084\u7aef\u672b\u88c5\u7f6e\u3068\u66f8\u304b\u308c\u308b\u5834\u5408\u304c\u3042\u308a\u307e\u3059\u3002",
    ],
    broadWarnings: [
      "\u60c5\u5831\u51e6\u7406\u88c5\u7f6e\u3060\u3051\u3067\u306fPC\u3084\u30b5\u30fc\u30d0\u307e\u3067\u5e83\u304c\u308a\u307e\u3059\u3002",
    ],
    humanReviewPoints: [
      "\u901a\u4fe1\u6a5f\u80fd\u3001\u753b\u9762\u64cd\u4f5c\u3001\u30a2\u30d7\u30ea\u5b9f\u884c\u306a\u3069\u306e\u69cb\u6210\u8981\u4ef6\u3068\u7d44\u307f\u5408\u308f\u305b\u3066\u78ba\u8a8d\u3057\u3066\u304f\u3060\u3055\u3044\u3002",
    ],
  },
  {
    centerTerm: "\u30a2\u30d7\u30ea",
    triggers: [
      "\u30a2\u30d7\u30ea",
      "\u30a2\u30d7\u30ea\u30b1\u30fc\u30b7\u30e7\u30f3",
      "\u30d7\u30ed\u30b0\u30e9\u30e0",
      "\u60c5\u5831\u51e6\u7406\u65b9\u6cd5",
      "\u60c5\u5831\u51e6\u7406\u88c5\u7f6e",
      "software",
      "application",
    ],
    synonyms: [
      "\u30d7\u30ed\u30b0\u30e9\u30e0",
      "\u60c5\u5831\u51e6\u7406\u65b9\u6cd5",
      "\u60c5\u5831\u51e6\u7406\u88c5\u7f6e",
    ],
    broaderTerms: [
      "\u30bd\u30d5\u30c8\u30a6\u30a7\u30a2",
      "\u30b3\u30f3\u30d4\u30e5\u30fc\u30bf\u30b7\u30b9\u30c6\u30e0",
    ],
    narrowerTerms: [
      "\u30b9\u30de\u30fc\u30c8\u30d5\u30a9\u30f3\u30a2\u30d7\u30ea",
      "Web \u30a2\u30d7\u30ea",
      "\u5236\u5fa1\u30d7\u30ed\u30b0\u30e9\u30e0",
    ],
    patentTerms: [
      "\u30d7\u30ed\u30b0\u30e9\u30e0",
      "\u60c5\u5831\u51e6\u7406\u65b9\u6cd5",
      "\u60c5\u5831\u51e6\u7406\u88c5\u7f6e",
    ],
    englishKeywords: ["software", "application"],
    leakageWarnings: [
      "\u30a2\u30d7\u30ea\u3060\u3051\u3067\u306f\u7279\u8a31\u6587\u732e\u306e\u30d7\u30ed\u30b0\u30e9\u30e0\u8868\u73fe\u3092\u53d6\u308a\u3053\u307c\u3059\u53ef\u80fd\u6027\u304c\u3042\u308a\u307e\u3059\u3002",
    ],
    broadWarnings: [
      "\u30bd\u30d5\u30c8\u30a6\u30a7\u30a2\u3084\u30d7\u30ed\u30b0\u30e9\u30e0\u306f\u5e83\u3044\u305f\u3081\u3001\u51e6\u7406\u5185\u5bb9\u3068\u7d44\u307f\u5408\u308f\u305b\u3066\u304f\u3060\u3055\u3044\u3002",
    ],
    humanReviewPoints: [
      "\u88c5\u7f6e\u30af\u30ec\u30fc\u30e0\u3001\u65b9\u6cd5\u30af\u30ec\u30fc\u30e0\u3001\u30d7\u30ed\u30b0\u30e9\u30e0\u30af\u30ec\u30fc\u30e0\u306e\u8868\u73fe\u5dee\u3092\u78ba\u8a8d\u3057\u3066\u304f\u3060\u3055\u3044\u3002",
    ],
  },
  {
    centerTerm: "AI",
    triggers: [
      "AI",
      "\u4eba\u5de5\u77e5\u80fd",
      "\u6a5f\u68b0\u5b66\u7fd2",
      "\u5b66\u7fd2\u6e08\u307f\u30e2\u30c7\u30eb",
      "\u63a8\u8ad6\u30e2\u30c7\u30eb",
      "\u30cb\u30e5\u30fc\u30e9\u30eb\u30cd\u30c3\u30c8\u30ef\u30fc\u30af",
      "machine learning",
    ],
    synonyms: [
      "\u6a5f\u68b0\u5b66\u7fd2",
      "\u5b66\u7fd2\u6e08\u307f\u30e2\u30c7\u30eb",
      "\u63a8\u8ad6\u30e2\u30c7\u30eb",
      "\u30cb\u30e5\u30fc\u30e9\u30eb\u30cd\u30c3\u30c8\u30ef\u30fc\u30af",
    ],
    broaderTerms: [
      "\u60c5\u5831\u51e6\u7406",
      "\u30c7\u30fc\u30bf\u51e6\u7406",
      "\u30e2\u30c7\u30eb\u51e6\u7406",
    ],
    narrowerTerms: [
      "\u6df1\u5c64\u5b66\u7fd2",
      "\u5206\u985e\u30e2\u30c7\u30eb",
      "\u751f\u6210\u30e2\u30c7\u30eb",
    ],
    patentTerms: [
      "\u5b66\u7fd2\u6e08\u307f\u30e2\u30c7\u30eb",
      "\u63a8\u8ad6\u88c5\u7f6e",
      "\u60c5\u5831\u51e6\u7406\u88c5\u7f6e",
    ],
    englishKeywords: ["machine learning", "AI", "neural network"],
    leakageWarnings: [
      "AI \u3060\u3051\u3067\u306f\u8a18\u8f09\u304c\u63fa\u308c\u308b\u305f\u3081\u3001\u6a5f\u68b0\u5b66\u7fd2\u3084\u5b66\u7fd2\u6e08\u307f\u30e2\u30c7\u30eb\u3082\u78ba\u8a8d\u3057\u3066\u304f\u3060\u3055\u3044\u3002",
    ],
    broadWarnings: [
      "\u60c5\u5831\u51e6\u7406\u88c5\u7f6e\u306f\u975e\u5e38\u306b\u5e83\u3044\u305f\u3081\u3001\u5165\u529b\u30c7\u30fc\u30bf\u3001\u5b66\u7fd2\u65b9\u6cd5\u3001\u63a8\u8ad6\u51e6\u7406\u3067\u7d5e\u308a\u8fbc\u3093\u3067\u304f\u3060\u3055\u3044\u3002",
    ],
    humanReviewPoints: [
      "\u30e2\u30c7\u30eb\u3092\u5b66\u7fd2\u3059\u308b\u767a\u660e\u304b\u3001\u5b66\u7fd2\u6e08\u307f\u30e2\u30c7\u30eb\u3092\u4f7f\u3046\u767a\u660e\u304b\u3092\u5206\u3051\u3066\u78ba\u8a8d\u3057\u3066\u304f\u3060\u3055\u3044\u3002",
    ],
  },
  {
    centerTerm: "\u96fb\u6c60",
    triggers: [
      "\u96fb\u6c60",
      "\u84c4\u96fb\u6c60",
      "\u4e8c\u6b21\u96fb\u6c60",
      "\u84c4\u96fb\u30c7\u30d0\u30a4\u30b9",
      "battery",
      "rechargeable battery",
    ],
    synonyms: [
      "\u84c4\u96fb\u6c60",
      "\u4e8c\u6b21\u96fb\u6c60",
      "\u84c4\u96fb\u30c7\u30d0\u30a4\u30b9",
    ],
    broaderTerms: [
      "\u96fb\u6e90",
      "\u30a8\u30cd\u30eb\u30ae\u30fc\u8caf\u8535\u88c5\u7f6e",
      "\u84c4\u96fb\u88c5\u7f6e",
    ],
    narrowerTerms: [
      "\u30ea\u30c1\u30a6\u30e0\u30a4\u30aa\u30f3\u96fb\u6c60",
      "\u5168\u56fa\u4f53\u96fb\u6c60",
      "\u71c3\u6599\u96fb\u6c60",
    ],
    patentTerms: [
      "\u84c4\u96fb\u88c5\u7f6e",
      "\u4e8c\u6b21\u96fb\u6c60",
      "\u96fb\u6c60\u30e2\u30b8\u30e5\u30fc\u30eb",
    ],
    englishKeywords: ["battery", "rechargeable battery"],
    leakageWarnings: [
      "\u96fb\u6c60\u3060\u3051\u3067\u306f\u84c4\u96fb\u6c60\u3001\u4e8c\u6b21\u96fb\u6c60\u3001\u84c4\u96fb\u30c7\u30d0\u30a4\u30b9\u306e\u8a18\u8f09\u3092\u53d6\u308a\u3053\u307c\u3059\u53ef\u80fd\u6027\u304c\u3042\u308a\u307e\u3059\u3002",
    ],
    broadWarnings: [
      "\u96fb\u6e90\u3060\u3051\u3067\u306f\u56de\u8def\u3084\u767a\u96fb\u88c5\u7f6e\u307e\u3067\u5e83\u304c\u308a\u307e\u3059\u3002",
    ],
    humanReviewPoints: [
      "\u6750\u6599\u3001\u69cb\u9020\u3001\u5145\u653e\u96fb\u5236\u5fa1\u3001\u7528\u9014\u306e\u3069\u308c\u304c\u4e3b\u8981\u306a\u767a\u660e\u7279\u5fb4\u304b\u78ba\u8a8d\u3057\u3066\u304f\u3060\u3055\u3044\u3002",
    ],
  },
];

function normalizeKeyword(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\u3000\u30fb\uff65.\-_/\/\uff0f\uff08\uff09()\[\]\u3010\u3011\u300c\u300d\u300e\u300f]/g, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isAsciiTerm(value: string): boolean {
  return /^[a-z0-9 ]+$/i.test(value);
}

function matchesTrigger(text: string, normalizedText: string, trigger: string): boolean {
  if (isAsciiTerm(trigger)) {
    const normalizedTrigger = normalizeKeyword(trigger);
    const pattern = new RegExp(
      `(^|[^A-Za-z0-9])${escapeRegExp(trigger)}([^A-Za-z0-9]|$)`,
      "i"
    );
    if (normalizedTrigger.length <= 2) {
      return pattern.test(text);
    }
    return pattern.test(text) || normalizedText.includes(normalizedTrigger);
  }

  return normalizedText.includes(normalizeKeyword(trigger));
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.trim().length > 0)));
}

export function buildPatentKeywordAssist(
  input: string | readonly (string | null | undefined)[] | null | undefined
): PatentKeywordAssistItem[] {
  try {
    const text =
      typeof input === "string"
        ? input
        : input
          ? input.filter((value): value is string => typeof value === "string").join("\n")
          : "";
    if (!text.trim()) return [];

    const normalizedText = normalizeKeyword(text);
    return ENTRIES.filter((entry) =>
      entry.triggers.some((trigger) => matchesTrigger(text, normalizedText, trigger))
    )
      .map((entry) => ({
        centerTerm: entry.centerTerm,
        synonyms: unique(entry.synonyms),
        broaderTerms: unique(entry.broaderTerms),
        narrowerTerms: unique(entry.narrowerTerms),
        patentTerms: unique(entry.patentTerms),
        englishKeywords: unique(entry.englishKeywords),
        leakageWarnings: unique(entry.leakageWarnings),
        broadWarnings: unique(entry.broadWarnings),
        humanReviewPoints: unique(entry.humanReviewPoints),
      }))
      .slice(0, 6);
  } catch {
    return [];
  }
}
