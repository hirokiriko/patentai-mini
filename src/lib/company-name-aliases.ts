export type CompanyNameHintConfidence = "high" | "medium" | "low";
export type CompanyNameHintSource = "ai" | "dictionary";

export type CompanyNameHint = {
  observedName: string;
  relatedNames: string[];
  reason: string;
  confidence: CompanyNameHintConfidence;
  source?: CompanyNameHintSource;
};

type CompanyNameAliasEntry = {
  names: string[];
  reason: string;
  confidence: CompanyNameHintConfidence;
};

const COMPANY_NAME_ALIAS_REASON =
  "\u65e7\u793e\u540d\u30fb\u73fe\u793e\u540d\u30fb\u82f1\u8a9e\u8868\u8a18\u306e\u9055\u3044\u306b\u3088\u308a\u3001\u51fa\u9858\u4eba\u540d\u691c\u7d22\u3067\u6f0f\u308c\u304c\u8d77\u304d\u308b\u53ef\u80fd\u6027\u304c\u3042\u308a\u307e\u3059\u3002";

const COMPANY_NAME_ALIAS_ENTRIES: CompanyNameAliasEntry[] = [
  {
    names: [
      "\u677e\u4e0b\u96fb\u5668\u7523\u696d",
      "\u677e\u4e0b\u96fb\u5668",
      "\u30d1\u30ca\u30bd\u30cb\u30c3\u30af",
      "Panasonic",
    ],
    reason: COMPANY_NAME_ALIAS_REASON,
    confidence: "high",
  },
  {
    names: [
      "\u5bcc\u58eb\u5199\u771f\u30d5\u30a4\u30eb\u30e0",
      "\u5bcc\u58eb\u30d5\u30a4\u30eb\u30e0",
      "FUJIFILM",
      "Fujifilm",
    ],
    reason: COMPANY_NAME_ALIAS_REASON,
    confidence: "high",
  },
  {
    names: [
      "\u6771\u4eac\u901a\u4fe1\u5de5\u696d",
      "\u30bd\u30cb\u30fc",
      "Sony",
      "SONY",
    ],
    reason: COMPANY_NAME_ALIAS_REASON,
    confidence: "high",
  },
  {
    names: [
      "\u65e5\u672c\u96fb\u88c5",
      "\u30c7\u30f3\u30bd\u30fc",
      "DENSO",
      "Denso",
    ],
    reason: COMPANY_NAME_ALIAS_REASON,
    confidence: "high",
  },
  {
    names: [
      "\u6771\u4eac\u829d\u6d66\u96fb\u6c17",
      "\u6771\u829d",
      "Toshiba",
      "TOSHIBA",
    ],
    reason: COMPANY_NAME_ALIAS_REASON,
    confidence: "high",
  },
];

function normalizeCompanyName(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(
      /\u682a\u5f0f\u4f1a\u793e|\u6709\u9650\u4f1a\u793e|\u5408\u540c\u4f1a\u793e|\uff08\u682a\uff09|\(\u682a\)|inc\.?|corp\.?|corporation/g,
      ""
    )
    .replace(
      /[\s\u3000\u30fb\uff65.\-_/\/\uff0f\uff08\uff09()\[\]\u3010\u3011\u300c\u300d\u300e\u300f]/g,
      ""
    );
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.trim().length > 0)));
}

export function findCompanyNameHints(text: string): CompanyNameHint[] {
  const normalizedText = normalizeCompanyName(text);

  return COMPANY_NAME_ALIAS_ENTRIES.flatMap((entry) => {
    const observedName = entry.names.find((name) =>
      normalizedText.includes(normalizeCompanyName(name))
    );
    if (!observedName) return [];

    const normalizedObservedName = normalizeCompanyName(observedName);
    return [
      {
        observedName,
        relatedNames: unique(
          entry.names.filter(
            (name) => normalizeCompanyName(name) !== normalizedObservedName
          )
        ).slice(0, 6),
        reason: entry.reason,
        confidence: entry.confidence,
        source: "dictionary" as const,
      },
    ];
  }).slice(0, 3);
}

export function mergeCompanyNameHints(
  aiHints: CompanyNameHint[],
  dictionaryHints: CompanyNameHint[]
): CompanyNameHint[] {
  const merged: CompanyNameHint[] = [];
  const seen = new Set<string>();

  for (const hint of [...dictionaryHints, ...aiHints]) {
    const key = normalizeCompanyName(
      [hint.observedName, ...hint.relatedNames].sort().join("|")
    );
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(hint);
    if (merged.length >= 3) break;
  }

  return merged;
}
