# Decisions

> このファイルは恒久的な設計判断の正本です。現在状態は最新のAccepted判断とdefault branchを照合してください。
> 過去判断と現行実装が矛盾する場合は削除せず、後続判断で明示的にsupersedeします。

## DR-0001: PoC は手動検索を前提にする
- Date: 2026-04-09
- Status: Accepted
- Context:
  - J-PlatPat の検索工程まで自動化すると、PoC の本質である検索式生成・比較分析より外部依存が支配的になる
- Decision:
  - J-PlatPat はユーザーが手動で使う
  - 本システムは検索式生成と結果分析に集中する
- Consequence:
  - UX は 2 段階アップロードになる
  - 検索式の説明責任が重要になる

## DR-0002: 初期保存層は SQLite を採用
- Date: 2026-04-09
- Status: Accepted
- Context:
  - 個人利用の PoC であり、運用負荷を極小化したい
- Decision:
  - まずは SQLite + ローカルファイル保存で開始する
- Consequence:
  - マルチユーザー用途には向かない
  - 将来 pgvector/Qdrant へ移行可能な抽象化が必要

## DR-0003: LLM 統合に AI SDK (Vercel AI SDK) を採用
- Date: 2026-04-09
- Status: Accepted
- Context:
  - PoC フェーズでモデル・プロバイダーの切り替えを頻繁に試したい
  - OpenAI 固定だと比較実験のたびにコード変更が必要になる
- Decision:
  - AI SDK を使い、プロバイダー（openai / anthropic / google 等）をコード変更なしで切り替え可能にする
  - .env の設定でプロバイダーとモデルを指定する
- Consequence:
  - .env.example の LLM 関連変数を AI SDK のプロバイダー体系に合わせる
  - 各プロバイダーの SDK パッケージを依存に追加する必要がある

## DR-0004: All JS/TS 構成（Python 併用なし）
- Date: 2026-04-09
- Status: Accepted
- Context:
  - DR-0003 で AI SDK を採用し、LLM 呼び出しは TS で完結する
  - PDF パースは pdf-parse、DOCX は mammoth で JS 内で対応可能
  - PoC で 2 言語のランタイム管理は負荷が大きい
- Decision:
  - Next.js + TypeScript のみで構成し、Python ワーカーは使わない
- Consequence:
  - docs/03-architecture.md の「Parser / Analysis Worker: Python」は撤回
  - ファイルパースを JS ライブラリで賄う必要がある

## DR-0005: ORM に Drizzle を採用
- Date: 2026-04-09
- Status: Accepted
- Context:
  - DR-0002 で SQLite を採用しており、軽量な ORM が望ましい
  - SQL に近い記法で学習コストが低く、PoC に適している
- Decision:
  - Drizzle ORM + drizzle-kit でスキーマ管理・マイグレーションを行う
- Consequence:
  - スキーマ定義は TypeScript ファイルで管理する
  - drizzle-kit push / migrate でスキーマ変更を適用する

## DR-0006: パッケージマネージャに pnpm を採用
- Date: 2026-04-09
- Status: Accepted
- Context:
  - Vercel が pnpm を公式サポートし自動検出する
  - node_modules がハードリンクで軽量
- Decision:
  - pnpm を使用する
- Consequence:
  - pnpm-lock.yaml をリポジトリに含める
  - mise で Node.js と pnpm のバージョンを管理する

## DR-0007: DB をリポジトリパターンで抽象化し、Turso に移行
- Date: 2026-04-09
- Status: Accepted
- Context:
  - ローカル SQLite は Vercel 上で動作しない（サーバーレス環境にファイルシステムなし）
  - 将来 Firebase / AWS DynamoDB 等への切り替えも想定される
- Decision:
  - src/repositories/ にインターフェース（types.ts）と実装（drizzle.ts）を分離
  - DB を Turso (libSQL クラウド) に移行し、Vercel 上でも動作可能にする
  - 実装切り替えは repositories/index.ts の import 先変更のみで対応
- Consequence:
  - API Routes と Server Components は repositories 経由でのみ DB アクセスする
  - db/ を直接 import するのは repositories/drizzle.ts のみ

## DR-0008: LLM プロバイダーを環境変数で動的切り替え
- Date: 2026-04-09
- Status: Accepted
- Context:
  - PoC フェーズでモデル比較を頻繁に行いたい
  - openai("gpt-4o") のハードコードを排除したい
- Decision:
  - src/lib/ai-model.ts で AI_PROVIDER / AI_MODEL 環境変数を読み取り、getModel() を提供
  - 現在対応: google (gemini), openai (gpt-4o)
- Consequence:
  - 新プロバイダー追加時は ai-model.ts に case を追加するだけ

## DR-0009: 国内優先権主張出願モードを追加（FR-07）
- Date: 2026-05-08
- Status: Accepted
- Context:
  - 公開前の自身の出願済み特許に新規事項を加えて新しい別の特許として出願する戦略（特許法 41 条 国内優先権主張出願）を支援したい
  - 既存フローは「単一の特許案」を前提にしており、ベース出願 + 新規事項の 2 入力を扱えない
  - ユーザー（発明者）は制度名を意識しないので UI 上は「公開前の出願済み特許に新規事項を付け加える特許ですか？ Yes/No」で表現する
- Decision:
  - cases に `baseApplicationMode` (boolean) と `baseApplicationNumber` (任意メタ) を追加
  - draftPatents に `kind` カラム ("main" | "base" | "addition") を追加。デフォルトは "main"
  - ベース出願モード時の処理: ベース出願 (kind="base") と新規事項 (kind="addition") を別ファイルでアップロード → AI が両者を統合した新しい明細書テキストを生成 → main draft として保存 → 既存フロー (請求項抽出以降) に合流
  - 先行技術調査・重なり分析の対象は「統合した発明全体」とする。新規事項のみの調査は将来要望
  - 適用法令を機械的に断定せず、先行技術からの除外を含む法的評価は人間のレビューに委ねる
- Consequence:
  - 通常モード（baseApplicationMode=false）の挙動・データは一切変えない（後方互換）
  - 新規 API: `/api/cases/[caseId]/integrate` POST（ベース + 新規事項 → 統合 main draft 生成）
  - 新規 lib: `src/lib/integrate-claims.ts`（統合プロンプト + AI 呼び出し）
  - 新規 UI: 案件作成フォームに Yes/No、案件詳細画面の Step 1 を 2 系統に分岐

## DR-0010: 現行platformをPostgres／複数AI provider／Azure Container Appsとする
- Date: 2026-08-24
- Status: Accepted
- Supersedes: DR-0002の保存層、DR-0007のTurso部分、DR-0008のprovider一覧、およびVercelを現行deploy先とする記述
- Context:
  - 現行コードとdeploy workflowは旧platform判断から移行済みである
  - 過去の設計判断は履歴として保持しつつ、現在の正しい前提を明示する必要がある
- Decision:
  - DBはDrizzle ORM経由のPostgresを使用する
  - AI providerはGoogle、OpenAI、Azure OpenAIに対応する
  - deployはGitHub ActionsからOIDCでAzureへ認証し、ACR imageを既存Azure Container Appへ反映する
  - Azure resource作成、runtime環境変数設定、DB migrationはdeploy workflowの責務に含めない
- Consequence:
  - 旧SQLite／Turso／Vercel記述は歴史的判断として残るが、現行構成の根拠には使わない
  - 現在状態はdefault branchのコード、workflow、CI、および許可された実環境で確認する

## DR-0011: Issue Driven運用とGitHub内完結のagent handoffを採用する
- Date: 2026-08-24
- Status: Accepted
- Supersedes: 旧session文書を新規タスク、進捗、引継ぎの正本として毎回更新する運用
- Context:
  - 複数agentが同じ受入条件と公開可能な検証記録を参照できる運用が必要である
  - chat履歴や個人環境へ依存する引継ぎは再現性と情報管理を損なう
- Decision:
  - GitHub Issueをタスク、scope、受入条件、進捗、引継ぎの正本とする
  - Issue本文だけで作業を完遂できる自己完結指示を原則とする
  - agent間の引継ぎ、修正要求、検証記録は関連IssueまたはPRで行う
  - `ops/tasks.md`、`ops/session-log.md`、`ops/handoff.md`はIssue Driven移行前の履歴資料として保持し、現行運用では更新しない
  - `ops/decisions.md`は恒久的設計判断の正本として継続する
  - 公開記録にはsecret、個人パス、個別アカウント、顧客・実案件情報、未公開資料、Production dataを記載しない
- Consequence:
  - 現行状態はGitHub Issue／PR、default branch、CI、および必要な実環境から確認する
  - 旧履歴文書の本文を新しいIssue／PRへ無差別に転記しない
  - 検出結果は分類、件数、PASS／FAILで扱い、値を再掲しない

## DR-0012: global公報corpusを案件単位の先行技術から分離する
- Date: 2026-08-27
- Status: Accepted
- Context:
  - 公報package parserの結果を、案件に紐付く既存`prior_art_documents`へ混在させると、取込履歴、再利用範囲、case削除時のownershipが曖昧になる
  - full publication、補正掲載、nested ST.26、identity未確認candidateを同じdocumentとして保存すると、比較対象の根拠が不明確になる
  - raw XMLやdescription全文を初期段階から保存せず、比較・追跡に必要なsource evidenceへ限定する必要がある
- Decision:
  - `koho_import_runs`と`koho_import_documents`を案件に紐付かないglobal corpusとし、既存`prior_art_documents`の意味を変更しない
  - 初期document保存対象はidentity確認済みのA1／P1／B1／B2 full publicationに限定する。`review_required`でもidentity確認済みならstatusとissue codeを保持して保存する
  - A5／P5 amendmentとnested ST.26はdocument rowへ保存せず、run summaryの件数へ残す。identity未確認、unknown、unsupported、failed resultもdocument rowへ保存しない
  - source metadataと比較用plain textを必要最小限に決定的projectionし、raw XML／CSV、description、reference、画像・添付物を保存しない
  - package typeとsource SHA-256を冪等keyとし、同一runのdocumentを単一transactionでreplaceする
- Consequence:
  - case削除はglobal corpusへ影響せず、案件単位の比較対象と公報取込履歴のlifecycleを独立させられる
  - parser、import plan、schema、repository coreまでを保存基盤とし、API／UI／scheduler／自動取得との接続は別Issueで設計する
  - 実JPA／JPB packageと一時Postgresによる全件保存、冪等性、rollbackはLocal検証で行い、Production migrationは別途明示的に扱う

## DR-0013: 管理者限定の公報package手動取込APIはfail-closedとする
- Date: 2026-08-28
- Status: Accepted
- Context:
  - global公報corpusへpackageを投入する最小経路が必要だが、raw ZIP全体buffer化、無制限入力、secret未設定時の公開、raw source永続化は避ける必要がある
  - scheduler／自動取得／UIを同時に導入せず、既存parser・import plan・repositoryを安全に接続したい
- Decision:
  - `POST /api/admin/koho-imports`だけを追加し、管理tokenとsource byte上限の両設定が有効な場合だけ処理を許可する
  - raw ZIPはOS一時fileへbounded streamingし、同じchunk列からSHA-256を算出して既存の冪等保存keyへ使用する
  - 一時fileは成功・失敗・abortを問わず即時削除し、cleanup完了を確認できない場合は成功responseを返さずstable internal errorとする。raw ZIPをDB、Blob、repository artifactへ永続化しない
  - `success`／`review_required`だけを保存し、`failed`は保存しない
  - endpointにUI、scheduler、自動取得を追加しない
- Consequence:
  - runtime設定が欠損または不正ならendpointはbodyやDBへ触れず`koho_import_disabled`で停止する
  - Production有効化は公報保存migrationの適用、2つのruntime設定、専用Local検証を別途完了した後に行う
  - Cloud実装はProduction DB、Azure resource、secret、runtime環境変数を変更しない

## DR-0014: global公報は案件の先行技術へsnapshot copyする
- Date: 2026-08-28
- Status: Accepted
- Extends: DR-0012
- Context:
  - global公報corpusを複数案件で再利用しつつ、既存の重なり分析は案件単位の`prior_art_documents`を入力とする必要がある
  - global rowをcaseへ直接関連付けると、後続のglobal更新・削除が過去の比較対象へ意図せず伝播し、案件分析の再現性を損なう
  - 比較対象が変わっていない再追加で既存`comparison_results`を削除すると、不要な再分析を発生させる
- Decision:
  - relation tableやschemaを追加せず、ユーザーが選択した時点の比較用値を既存`prior_art_documents`へsnapshot copyする
  - 同一案件・同一公開番号を1つの比較対象とし、全snapshot fieldの完全一致でinsert／update／unchangedを決定する
  - attachはcase row lockを含む単一transactionで直列化し、lookup、保存契約検証、projection、merge、analysis invalidationをatomicに行う
  - snapshot provenanceは追跡に必要な8 fieldのcanonical JSONだけとし、raw source、description、reference、画像、添付、Applicant／IPC／FI JSON、issue messageを含めない
  - insertまたはupdateが1件以上ある場合だけ、同一transactionで対象caseの`comparison_results`を削除する
  - global rowの更新・削除を既存snapshotへ伝播せず、case削除もglobal corpusへ影響させない
- Consequence:
  - 既存分析APIと`PriorArtDocument`表示を変更せず、global corpusを比較フローへ接続できる
  - 同一内容の再追加は既存`docId`と分析結果を維持する
  - 案件pageは初期renderでcorpusへqueryせず、storage未準備時は明示検索・追加だけがstableな利用不可応答になる
  - Production migration、corpus投入、Azure resource、secret、runtime環境変数の操作は別Issueとする

## DR-0015: 出願後ウォッチングは既存corpusを固定upper cursorで差分処理する

- Date: 2026-09-02
- Status: Accepted
- Extends: DR-0012
- Context:
  - 出願済み案件について、前回確認後に取り込まれた公報だけを再現可能な範囲で比較したい
  - run中にもglobal corpusへ新しいimportが追加され得るため、単純な最新値更新では公報を飛ばす可能性がある
  - J-PlatPatの自動操作、scheduler、queue、Production設定をMVPへ先取りしない境界が必要である
- Decision:
  - J-PlatPatを自動操作せず、既に取り込まれたglobal公報corpusだけをユーザーの明示操作で処理する
  - `koho_import_runs.updated_at`と`import_id`のtupleをcursorとし、run開始transactionでbaseとupperを固定する
  - corpus保存とupper固定を共通のtransaction-scoped advisory lockで直列化し、importの`updated_at`を既存最大よりmicrosecond精度で必ず後になるよう付与する
  - 監視開始日もrun開始transactionでsnapshotし、初回はその日付以降、以後はbaseより後かつ固定upper以下のdocumentだけを処理し、成功時だけcursorをupperへ進める
  - 公開番号とcontent digestのcanonical JSON SHA-256をfinding identityとし、再取込時のDB IDやpackageに依存しない
  - 決定的prefilterでAI入力を最大100件、詳細分析を最大20件に制限し、AI失敗時は人手確認を明示した決定的fallbackを用いる
- Consequence:
  - run中の新規importは次回へ確実に残り、failed runはcursorを進めない
  - 同一内容の再取込や再実行でfindingを重複保存しない
  - scheduler、自動取得、外部通知、Production migration、Azure resource／secret／runtime設定は別承認とする
