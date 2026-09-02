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
  kohoCorpusRepo,
  patentWatchRepo,
} from "./drizzle";

export {
  KohoImportRepositoryValidationError,
  PatentWatchRepositoryError,
} from "./types";

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
  KohoCorpusRepository,
  PatentWatchRepositoryErrorCode,
  PatentWatchRepository,
} from "./types";

export type {
  CaseWatchSetting,
  CaseWatchRun,
  CaseWatchFinding,
  PatentWatchCursor,
  PatentWatchCorpusDocument,
  PatentWatchCorpusBatch,
  PatentWatchRunStart,
  PatentWatchFindingInsert,
  PatentWatchRunCounts,
  PatentWatchRunSuccessInput,
  PatentWatchRunFailureInput,
  PatentWatchRunRepository,
} from "@/lib/patent-watch/types";
