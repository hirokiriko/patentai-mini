# 03 Architecture

## 推奨方針
PoC では **複雑な分散構成は不要** です。まずは以下で十分です。

- Frontend: Next.js あるいは軽量 Web UI
- API / Orchestrator: Next.js API Routes もしくは FastAPI
- Parser / Analysis Worker: Python
- DB: SQLite
- Vector store: 初期は SQLite 拡張またはファイルベース、必要なら pgvector/Qdrant へ拡張
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
- created_at
- updated_at

### DraftPatent
- draft_id
- case_id
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

## なぜこの構成か
- J-PlatPat の手動工程を外部依存として切り離せる
- AI の不安定性を中間 JSON 保存で吸収できる
- 後からベクトル DB を差し替え可能

## 将来拡張
- OCR 付き PDF 詳細解析
- 公報本文の自動取り込み
- 代理人向けレビュー画面
- ケース横断の先行技術ナレッジ蓄積
