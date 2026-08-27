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
  kohoImportRepo,
} from "./drizzle";

export { KohoImportRepositoryValidationError } from "./types";

export type {
  Case,
  DraftPatent,
  DraftKind,
  SearchQuerySet,
  PriorArtDocument,
  ComparisonResult,
  KohoImportRun,
  KohoImportDocument,
  KohoImportSaveResult,
  KohoImportRepositoryValidationErrorCode,
  CaseRepository,
  DraftPatentRepository,
  SearchQuerySetRepository,
  PriorArtDocumentRepository,
  ComparisonResultRepository,
  KohoImportRepository,
} from "./types";
