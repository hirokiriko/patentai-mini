# 03 Architecture

## 推奨方針
PoC では **複雑な分散構成は不要** です。まずは以下で十分です。

- Frontend: Next.js (App Router)
- API / Orchestrator: Next.js API Routes (Route Handlers)
- 言語: TypeScript のみ（DR-0004 により Python 併用なし）
- ORM: Drizzle ORM + drizzle-kit（DR-0005）
- DB: Postgres（DR-0010）
- Vector store: 現時点では専用storeなし。必要なら pgvector/Qdrant へ拡張
- LLM: AI SDK (Vercel AI SDK) でプロバイダー切り替え（DR-0003）
- パッケージマネージャ: pnpm（DR-0006）
- File storage: ローカルディスク

## 論理コンポーネント
1. Upload Service
2. Patent Draft Parser
3. Query Builder
4. Search Result Importer
5. Claim Element Extractor
6. Similarity Engine
7. Risk Report Generator
8. Patent Watch Service

## 最小データモデル
### Case
- case_id
- title
- status
- base_application_mode (boolean) — 公開前ベース出願 + 新規事項モード
- base_application_number (任意・メタ情報のみ。例: 特願 2026-40454)
- created_at
- updated_at

### DraftPatent
- draft_id
- case_id
- kind ("main" | "base" | "addition")
  - "main": 通常モードまたは統合済み特許案
  - "base": 公開前のベース出願（baseApplicationMode 時のみ）
  - "addition": 追加する新規事項（baseApplicationMode 時のみ）
- source_file_path
- parsed_text
- extracted_claims_json

### SearchQuerySet
- query_set_id
- case_id
- broad_query
- balanced_query
- narrow_query
- rationale_json

### PriorArtDocument
- doc_id
- case_id
- publication_no
- title
- abstract
- claims_text
- source_csv_row_json
- normalized_elements_json

`PriorArtDocument`は案件単位の検索結果・比較対象であり、次のglobal公報corpusとは
分離する。global公報を案件へ追加する場合も、global rowを直接関連付けず、比較に
必要な値と限定provenanceを`PriorArtDocument`へsnapshot copyする。

### KohoImportRun / KohoImportDocument
- package typeとsource SHA-256で識別するglobalな公報package取込履歴
- identity確認済みのA1／P1／B1／B2 full publicationだけを保存する公報document
- case_idを持たず、case削除の対象にしない
- 保存契約は[公報package保存仕様](07-koho-import-persistence-spec.md)を参照
- 管理者の明示操作による手動取込経路は[公報package手動取込API仕様](08-koho-manual-import-api-spec.md)に従う。raw ZIPは一時fileへbounded streamingし、保存後に残さない
- 案件への検索・snapshot追加は[公報corpus案件接続仕様](09-koho-corpus-case-connection-spec.md)に従う

### Global corpusから案件への接続
- `GET /api/cases/[caseId]/koho-corpus`は公開番号、出願番号、発明名称をliteral substringで検索し、公開用summaryだけを返す
- `POST /api/cases/[caseId]/koho-corpus`は選択したglobal documentを既存`prior_art_documents`へ単一transactionでsnapshot copyする
- attach transactionは対象caseをlockし、同一案件の並行attachを直列化する。schemaやrelation tableは追加しない
- snapshotの`source_csv_row_json`はsource種別、package type、source/content digest、正規化entry path、parse status、kind、公開日だけをcanonical JSONで保持する
- raw XML／CSV、description、reference、画像、添付、Applicant／IPC／FI JSON、issue messageはcase snapshotへ含めない
- global rowの更新・削除は既存snapshotへ伝播せず、case削除もglobal corpusへ影響させない
- insertまたはupdateがあった場合だけ、同じtransactionで対象caseの`comparison_results`を削除する
- 案件pageの初期renderはglobal corpusへqueryせず、ユーザーの明示検索時だけAPIを呼ぶ

### ComparisonResult
- result_id
- case_id
- draft_claim_id
- prior_doc_id
- lexical_score
- semantic_score
- structural_score
- matched_elements_json
- risk_label

### CaseWatchSetting / CaseWatchRun / CaseWatchFinding

- `CaseWatchSetting`は案件ごとに1件だけ持ち、有効状態、監視開始日、前回成功runのcursor tupleを保存する
- cursorは`koho_import_runs.updated_at`と`import_id`を同時にnullまたは同時にnon-nullで保持する
- `CaseWatchRun`は開始transactionで監視開始日、base cursor、現在のupper cursorを固定し、running／completed／failedと処理件数を保存する
- `CaseWatchFinding`はwatch内で公開番号とcontent digestから作る安定source identityをuniqueにし、比較結果と確認状態を保存する
- findingと公開用API／CSV／HTMLにはraw XML／CSV、全文claims、source hash、entry path、DB／AI raw errorを含めない
- 詳細契約は[出願後ウォッチングMVP仕様](10-patent-watching-mvp-spec.md)を参照する

## 処理流れ
1. 特許案を解析して請求項と構成要素を抽出
2. 検索式候補を生成
3. ユーザーが J-PlatPat で調査し結果を持ち帰る
4. CSV／個別fileを取り込むか、global公報corpusから公報を明示選択し、案件の比較対象を作る
5. 自身の請求項と既存文献要素を比較
6. 総合スコアと説明文を生成
7. レポート表示

## 出願後ウォッチングの処理流れ

1. ユーザーが案件のウォッチ設定と監視開始日を保存する
2. 「今すぐ監視」で単一transactionを開始し、case／setting／重複running runを検証してbase／upper cursorを固定する
3. 初回は監視開始日以降、以後はbaseより後かつupper以下のglobal corpus documentだけを読む
4. 独立請求項（なければ全請求項）との決定的な語彙重なりで最大100件へ絞る
5. 既存`screenPriorArt`で最大20件を選び、既存`analyzeOverlap`で比較する。AI失敗時は決定的fallbackを用いる
6. finding insert、run complete、setting cursor更新を単一transactionで確定する。失敗時はrunをfailedにしcursorを進めない
7. 案件画面、CSV、印刷用HTMLで新着確認候補とrun履歴を提供する

corpus保存とupper固定は共通のtransaction-scoped advisory lockで直列化し、import timestampをmicrosecond精度で単調にする。この直列化とfixed upper cursorにより、run中に追加されたimportは今回の対象へ混入せず、次回runへ残る。案件pageの初期renderはwatch tableを直接参照せず、独立client sectionがwatch状態だけを取得するため、Production migration未適用でも既存フローを壊さない。

## ベース出願モード（FR-07）の処理流れ
0. 案件作成時にベース出願モードを選択
1. ベース出願ファイル（公開前）と新規事項ファイルを別々にアップロード
2. AI がベース出願テキスト + 新規事項テキストを読み込み、両者を統合した「新しい発明全体のテキスト」を生成し main draft として保存
3. 以降は通常フロー（請求項抽出 → 検索式生成 → 先行技術取込 → 重なり分析）と同じ

## なぜこの構成か
- J-PlatPat の手動工程を外部依存として切り離せる
- AI の不安定性を中間 JSON 保存で吸収できる
- 後からベクトル DB を差し替え可能

## 将来拡張
- OCR 付き PDF 詳細解析
- 公報package scheduler／自動取得／Production有効化（parser・保存基盤・管理者限定の手動取込APIまでは実装済み）
- 代理人向けレビュー画面
- semantic／vector corpus検索、advanced filter、pagination、公報詳細画面
- 出願後ウォッチングのscheduler、自動取得、queue、外部通知、PDF binary生成
