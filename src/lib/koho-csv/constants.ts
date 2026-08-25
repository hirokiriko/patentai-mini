import type { KohoCsvPackageType, KohoCsvSection } from "./types";

export const ABSTRACT_SECTION_NAMES: Readonly<
  Record<KohoCsvPackageType, Readonly<Record<string, KohoCsvSection>>>
> = {
  JPA: {
    "公開特許公報（特開）": "P_A1",
    "補正の掲載（公開特許公報）": "P_A5",
    "公表特許公報（特表）": "P_P1",
    "国際公開後における補正の掲載": "P_P5",
  },
  JPB: {
    特許公報: "P_B1",
  },
};

export const KNOWN_DISPLAY_FLAGS: Readonly<
  Record<KohoCsvPackageType, ReadonlySet<string>>
> = {
  JPA: new Set(["請"]),
  JPB: new Set(["早", "際"]),
};

export const KNOWN_KINDS: Readonly<
  Record<KohoCsvPackageType, ReadonlySet<string>>
> = {
  JPA: new Set(["A", "A5"]),
  JPB: new Set(["B1", "B2"]),
};

export const ALL_KNOWN_KINDS: ReadonlySet<string> = new Set([
  "A",
  "A5",
  "B1",
  "B2",
]);
