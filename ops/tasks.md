# Tasks

## Inbox
- [ ] LLM モデル/プロバイダーを .env から切り替え可能にする（現在 gpt-4o ハードコード）
- [ ] ファイルアップロードを Vercel Blob 等に切り替える（Vercel 上で永続化するため）
- [ ] LLM 呼び出し失敗時のリトライ・部分保存
- [ ] 重なり分析の4層スコアを独立アルゴリズム化（現在は AI 一括推定）
- [ ] ベクトル検索の有効化（L3 意味類似の精度向上）
- [ ] J-PlatPat CSV の全列パターンの網羅テスト

## Next
- [ ] 実際の特許案ファイルで end-to-end テスト
- [ ] UI/UX 改善（ローディング状態、エラー表示の統一）
- [ ] 従属請求項の分析対応（現在は独立請求項のみ）

## In Progress

## Blocked

## Done
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
- [x] J-PlatPat CSV 取り込み（実データ検証済み、要約列オプショナル）
- [x] 重なり分析・リスクレポート（2段階: スクリーニング + 詳細4層分析）

## 運用ルール
- In Progress は 1〜3 件まで
- Done に移したら関連ファイル更新を確認する
- 「思いつき」は Inbox に入れ、仕様と混ぜない
