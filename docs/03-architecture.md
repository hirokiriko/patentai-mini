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
分離する。

### KohoImportRun / KohoImportDocument
- package typeとsource SHA-256で識別するglobalな公報package取込履歴
- identity確認済みのA1／P1／B1／B2 full publicationだけを保存する公報document
- case_idを持たず、case削除の対象にしない
- 保存契約は[公報package保存仕様](07-koho-import-persistence-spec.md)を参照
- 管理者の明示操作による手動取込経路は[公報package手動取込API仕様](08-koho-manual-import-api-spec.md)に従う。raw ZIPは一時fileへbounded streamingし、保存後に残さない

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

## 処理流れ
1. 特許案を解析して請求項と構成要素を抽出
2. 検索式候補を生成
3. ユーザーが J-PlatPat で調査し結果を持ち帰る
4. CSV を取り込み既存文献を正規化
5. 自身の請求項と既存文献要素を比較
6. 総合スコアと説明文を生成
7. レポート表示

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
- global公報corpusから案件の比較対象を選択する接続機能
