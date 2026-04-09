/**
 * リポジトリのエントリーポイント。
 * DB 実装を切り替えるにはここの import 先を変更する。
 *
 * 例: Firebase に切り替える場合
 *   export { caseRepo, ... } from "./firebase";
 */
export {
  caseRepo,
  draftPatentRepo,
  searchQuerySetRepo,
  priorArtDocumentRepo,
  comparisonResultRepo,
} from "./drizzle";

export type {
  Case,
  DraftPatent,
  SearchQuerySet,
  PriorArtDocument,
  ComparisonResult,
  CaseRepository,
  DraftPatentRepository,
  SearchQuerySetRepository,
  PriorArtDocumentRepository,
  ComparisonResultRepository,
} from "./types";
