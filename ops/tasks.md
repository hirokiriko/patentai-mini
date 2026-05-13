# Tasks

## Inbox
- [ ] LLM 呼び出し失敗時のリトライ・部分保存
- [ ] 重なり分析の4層スコアを独立アルゴリズム化（現在は AI 一括推定）
- [ ] ベクトル検索の有効化（L3 意味類似の精度向上）
- [ ] J-PlatPat CSV の全列パターンの網羅テスト
- [ ] GOOGLE_GENERATIVE_AI_API_KEY のローテーション（セッション中に露出したため）

## Next
- [ ] J-PlatPat 構文修正版検索式の本番デプロイ＋父による再検証
- [ ] 構文エラーが再発した場合の sanitize / 検証関数追加（タグ付き式のネスト検出）
- [ ] 方法B単独フロー+payload警告のデプロイ+実機検証（方法B複数ファイル、4MB警告、4.5MBブロック、HTTP413）
- [ ] pdfjs-dist 出力の字間スペース正規化（公報PDFで `所 定 の ...` のようになる問題、要調査）
- [ ] Phase B: クライアント側で PDF/DOCX をテキスト抽出して画像を除外（pdfjs-dist + mammoth.browser + サーバー JSON 経路追加）
- [ ] 環境選択 UI（要件確定待ち、追加要望B）
- [ ] 実施例4 の仕様ヒアリング実施
- [ ] UI/UX 改善（ローディング状態、エラー表示の統一）
- [ ] 従属請求項の分析対応（現在は独立請求項のみ）
- [ ] 新プロバイダー追加（anthropic 等）を ai-model.ts に追加

## In Progress

## Blocked

## Done
- [x] 検索式生成 504 対策: `generate-queries.ts` を fast モデル + 入力圧縮に変更（Vercel Hobby 60 秒制限対応、未デプロイ）
- [x] FR-07 国内優先権主張出願モード（DR-0009）— cases に baseApplicationMode/baseApplicationNumber、draft_patents に kind 追加。AI 統合 lib + API + UI（Step 1 を 1-A/1-B/1-C に分岐）。Turso 本番にスキーマ反映済、Vercel 未デプロイ
- [x] J-PlatPat 検索式の構文エラー根絶（中庸でタグ後置のカッコ式を二重ネストしないようプロンプト書き直し、eslint vendor/ ignore 追加で lint も復旧）
- [x] 方法B の PDF 取り込みバグ修正（unpdf → pdfjs-dist vendor/ 方式、@napi-rs/canvas 含む依存整備、ローカル dev + Vercel 本番の両方で日本語公報 PDF 3 件の取り込みを実機確認）
- [x] 改善点カタログ作成（`/Users/mao/.claude/plans/distributed-meandering-shell.md`、30+ 指摘・Top 10 Quick Wins 付き）
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
- [x] J-PlatPat CSV 取り込み（実データ検証済み、要約列オプショナル）
- [x] 重なり分析・リスクレポート（2段階: スクリーニング + 詳細4層分析）
- [x] LLM プロバイダー切り替え（AI_PROVIDER / AI_MODEL 環境変数）
- [x] テキスト長制限（請求項・要約優先保持、30,000文字上限）
- [x] リポジトリパターン導入（DB 実装の差し替え対応）
- [x] Turso (libSQL クラウド) 移行（kiriko アカウント、Vercel 環境変数設定済み）
- [x] Vercel 上での DB 接続確認・動作確認

## 運用ルール
- In Progress は 1〜3 件まで
- Done に移したら関連ファイル更新を確認する
- 「思いつき」は Inbox に入れ、仕様と混ぜない
