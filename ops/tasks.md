# Tasks

> [!NOTE]
> このファイルはIssue Driven移行前の履歴資料です。新規タスク、進捗、引継ぎの正本として更新しません。
> 現行状態はGitHub Issue／PR、default branch、CI、および必要な実環境で確認してください。
> 本文を新しいIssue／PRへ無差別に転記しないでください。


## Inbox
- [ ] LLM 呼び出し失敗時のリトライ・部分保存
- [ ] 重なり分析の4層スコアを独立アルゴリズム化（現在は AI 一括推定）
- [ ] ベクトル検索の有効化（L3 意味類似の精度向上）
- [ ] J-PlatPat CSV の全列パターンの網羅テスト
- [ ] 過去に露出可能性がある認証情報のローテーション状況を確認する（値は記録せず、必要なら別承認で対応）

## Next
- [ ] J-PlatPat構文修正版検索式のdeploy後検証（指定レビュアーによる確認）
- [ ] 構文エラーが再発した場合の sanitize / 検証関数追加（タグ付き式のネスト検出）
- [ ] 方法B単独フロー+payload警告のデプロイ+実機検証（方法B複数ファイル、4MB警告、4.5MBブロック、HTTP413）
- [ ] pdfjs-dist 出力の字間スペース正規化（公報PDFで `所 定 の ...` のようになる問題、要調査）
- [ ] Phase B: クライアント側で PDF/DOCX をテキスト抽出して画像を除外（pdfjs-dist + mammoth.browser + サーバー JSON 経路追加）
- [ ] 環境選択 UI（要件確定待ち、追加要望B）
- [ ] 非公開要件の仕様確認（詳細は公開履歴へ記載しない）
- [ ] UI/UX 改善（ローディング状態、エラー表示の統一）
- [ ] 従属請求項の分析対応（現在は独立請求項のみ）
- [ ] 新プロバイダー追加（anthropic 等）を ai-model.ts に追加

## In Progress

## Blocked

## Done
- [x] analyze-overlap: flash-preview の minimal 非サポートエラーで flash-lite + minimal に戻す（未デプロイ）
- [x] 先行技術文献の削除で FK 制約違反を解消: deleteByIds 内で関連 comparison_results を先に削除（コミット `0e45909` デプロイ済）
- [x] analyze-overlap: gemini-3.1-flash-preview + thinkingLevel='minimal' に変更（コミット `0401280` デプロイ済）
- [x] analyze-overlap の thinkingLevel を 'medium' → 'low' に下げる（コミット `adffa36` デプロイ済、ただし low でも 504 出やすく追加対策へ）
- [x] 先行技術文献の選択削除 + CSV 重複時の publicationNo upsert: PriorArtTable コンポーネント・DELETE API・upsertManyByPublicationNo / deleteByIds メソッド追加（コミット `57731e2` デプロイ済）
- [x] Gemini 3.1 flash-lite (stable) + thinkingLevel への切替: getModel/getFastModel を `gemini-3.1-flash-lite`(stable) に統一、analyze-overlap に `thinkingLevel: 'medium'` 指定（コミット `b2627b0` デプロイ済）
- [x] Gemini 3.1 系 preview への移行: `getModel()` を `gemini-3.1-flash-preview` に更新（getFastModel は 3.1 preview のまま）
- [x] 検索式生成 504 対策: `generate-queries.ts` を fast モデル + 入力圧縮に変更（`9b69088` で本番デプロイ完了、実機確認済）
- [x] FR-07 国内優先権主張出願モード（DR-0009）— cases に baseApplicationMode/baseApplicationNumber、draft_patents に kind 追加。AI 統合 lib + API + UI（Step 1 を 1-A/1-B/1-C に分岐）。Turso 本番にスキーマ反映済、Vercel 未デプロイ
- [x] J-PlatPat 検索式の構文エラー根絶（中庸でタグ後置のカッコ式を二重ネストしないようプロンプト書き直し、eslint vendor/ ignore 追加で lint も復旧）
- [x] 方法BのPDF取り込み不具合を修正し、管理されたサンプル文書でローカルとdeploy先を確認
- [x] 改善点カタログ作成（ローカル個人パスは除去、技術的な指摘構造を保持）
- [x] Quick Wins 5件: `.env.example` 整理 / queries route の JSON.parse を try/catch / 案件作成フォームに IME ガード / type-check script / GitHub Actions CI
- [x] 方法B 単独フロー対応（Step 4 の表示を請求項抽出済みで解禁、UI 文言・進捗バー更新）
- [x] Phase A: 先行技術取り込みフォームの合計サイズ事前警告と res.json 防御
- [x] 本番アップロードエラー修正（fs 書き込み除去、Buffer ベースに変更）
- [x] キーワード検索用コピペキーワード生成機能
- [x] 個別特許ファイルアップロードによる比較機能
- [x] PoC の目的と対象フローを整理した
- [x] 技術スタック設計判断を確定した（DR-0003〜DR-0006）
- [x] Next.js プロジェクト初期化 + Vercel デプロイ
- [x] Drizzle ORM セットアップ（5テーブル）
- [x] AI SDK + @ai-sdk/openai 導入
- [x] .env.example を AI SDK 体系に更新
- [x] 案件 CRUD API + 画面
- [x] 特許案ファイルアップロード（PDF/DOCX/TXT）
- [x] テキスト自動抽出（unpdf / mammoth）
- [x] AI 請求項・構成要素抽出
- [x] J-PlatPat 検索式生成（広/中/狭 3段階）
- [x] J-PlatPat 検索式フォーマット修正（正しい論理式構文に対応）
- [x] J-PlatPat CSV取り込み（管理された検証データで確認、要約列オプショナル対応）
- [x] 重なり分析・リスクレポート（2段階: スクリーニング + 詳細4層分析）
- [x] LLM プロバイダー切り替え（AI_PROVIDER / AI_MODEL 環境変数）
- [x] テキスト長制限（請求項・要約優先保持、30,000文字上限）
- [x] リポジトリパターン導入（DB 実装の差し替え対応）
- [x] 旧Turso（libSQL）移行履歴（現行Postgresによりsupersede、個別アカウントと接続情報は削除）
- [x] 旧hosting環境でのDB接続確認（現行状態はdefault branchと許可された実環境で確認）

## 運用ルール
- In Progress は 1〜3 件まで
- Done に移したら関連ファイル更新を確認する
- 「思いつき」は Inbox に入れ、仕様と混ぜない
