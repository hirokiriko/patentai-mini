# Session Log

## 2026-04-09 Initial scaffold
### 実施
- PoC の目的・範囲・アーキテクチャ・継続運用ファイル群を作成
- AI エージェント用の作業規約を作成

### 決まったこと
- J-PlatPat の検索自動化はスコープ外
- 人手検索 + 再アップロード方式で進める
- 初期 DB は SQLite 前提

### 未解決
- 実際に受け取る特許案ファイル形式
- J-PlatPat 検索結果ファイルの実物列定義
- 類似度スコア閾値

### 次にやること
- 実データ 1 件で end-to-end の疑似流し込みを行う

## 2026-04-09 技術スタック確定 & リポジトリ作成
### 実施
- CLAUDE.md を新規作成
- GitHub リポジトリ作成（hirokiriko/patentai-mini, private）、初回 push
- ローカル git config で hirokiriko アカウントの認証を設定
- 技術スタック設計判断 DR-0003〜DR-0006 を確定
- docs/03-architecture.md の Python 記述を撤回し TS 構成に修正

### 決まったこと
- DR-0003: LLM 統合に AI SDK を採用
- DR-0004: All JS/TS 構成（Python 併用なし）
- DR-0005: ORM に Drizzle を採用
- DR-0006: パッケージマネージャに pnpm を採用
- Vercel にデプロイ予定

### 未解決
- .env.example の AI SDK 体系への更新（Next.js 初期化時に対応）
- Next.js プロジェクトの初期化はまだ未着手

### 次にやること
- Next.js プロジェクトの初期化（create-next-app）
- Drizzle ORM セットアップとスキーマ定義
- Vercel デプロイ

## 2026-04-09 全7ステップ実装完了
### 実施
- Next.js プロジェクト初期化（Next.js 16, App Router, Tailwind, Turbopack）
- mise.toml で Node.js 22 + pnpm 10 をプロジェクトローカルに設定
- Vercel デプロイ確認（GitHub 自動連携設定済み）
- Drizzle ORM セットアップ（5テーブル: cases, draft_patents, search_query_sets, prior_art_documents, comparison_results）
- AI SDK + @ai-sdk/openai 導入、.env.example 更新
- 案件 CRUD API + 一覧・作成・詳細画面
- 特許案アップロード + テキスト自動抽出（unpdf/mammoth）
  - pdf-parse v1/v2 は Next.js Turbopack と互換性問題があり unpdf に切り替え
- AI 請求項・構成要素抽出（generateObject + zod スキーマ）
- J-PlatPat 検索式生成（広/中/狭 3段階 + キーワード群 + 根拠）
- J-PlatPat CSV 取り込み（実データ146件で検証、要約列オプショナル対応）
- 重なり分析・リスクレポート（2段階: スクリーニング→詳細4層分析）

### 決まったこと
- PDF パースは unpdf を使用（pdf-parse は非互換）
- J-PlatPat CSV 列定義が確定（文献番号, 出願番号, 出願日, 公知日, 発明の名称, 出願人/権利者, FI, 要約(optional), 公開番号, 公告番号, 登録番号, 審判番号, その他, ステージ, イベント詳細, 文献URL）
- 重なり分析はコスト・時間の制約から2段階方式（スクリーニング→上位20件のみ詳細分析）

### 仕様との実装差異
- 4層スコアは独立アルゴリズムではなく AI 一括推定
- L3 意味類似はベクトル検索未使用
- LLM モデルは gpt-4o ハードコード（.env 切り替え未実装）
- ファイルアップロードはローカル fs（Vercel 上で永続化不可）
- 従属請求項の分析は未対応（独立請求項のみ）

### 未解決
- 実際の特許案ファイルでの end-to-end テスト
- LLM プロバイダー/モデルの動的切り替え
- Vercel 上でのファイル永続化

### 次にやること
- 実データで end-to-end 動作確認
- UI/UX 改善
- 仕様差異の段階的解消

## 2026-04-09 ブラッシュアップ・Turso 移行・Vercel 完全動作
### 実施
- LLM プロバイダー切り替え（src/lib/ai-model.ts: AI_PROVIDER / AI_MODEL 環境変数）
- @ai-sdk/google 追加、デフォルトを Google AI (gemini) に変更
- テキスト長制限（trimPatentText: 請求項・要約優先、30,000文字上限）
- J-PlatPat 検索式フォーマット修正（ダブルクォート禁止、/CL等タグ必須、角括弧等）
- 実データ end-to-end 動作確認（DOCX アップロード→請求項抽出→検索式→CSV取込→重なり分析 全ステップ成功）
- リポジトリパターン導入（src/repositories/: types.ts + drizzle.ts + index.ts）
- Turso (libSQL クラウド) 移行（kiriko アカウント、東京リージョン）
- Vercel 環境変数設定（DATABASE_URL, TURSO_AUTH_TOKEN）
- DB 遅延初期化（Proxy パターン）でビルド時の接続エラー解消
- .vercelignore でローカル .env がデプロイに含まれない対策
- Git author 問題の解決（原因: direnv の GIT_AUTHOR_* 環境変数、プロジェクト .envrc で上書き）
- includeIf 復元（原因は direnv であり git config ではなかった）

### 決まったこと
- DR-0007: リポジトリパターンで DB 抽象化。Firebase 等への切り替えは index.ts の import 先変更のみ
- DR-0008: LLM プロバイダーを環境変数で動的切り替え
- Turso は kiriko アカウント（h.sato@kiriko.tech）で管理

### 気づき・注意点
- vercel env add で heredoc 経由だと末尾改行が入る（Invalid URL の原因に）→ printf で渡す
- pdf-parse v1/v2 は Next.js Turbopack と互換性問題 → unpdf に切り替え済み
- direnv の GIT_AUTHOR_* は git config より優先される（env vars > local > global > system）
- GOOGLE_GENERATIVE_AI_API_KEY がセッション中に露出 → ローテーション推奨

### 次にやること
- UI/UX 改善
- 従属請求項の分析対応
- ファイルアップロードの Vercel Blob 対応

## 2026-04-13 本番フィードバック対応（3件）
### 実施
- **アップロードエラー修正**: `parseFile` を Buffer ベースに変更（`fs/promises` のディスク書き込みを除去）。Vercel の読み取り専用 FS で動作するようになった
- **キーワード検索対応**: `generate-queries.ts` に `keywordQueries` スキーマを追加。テーマ別（課題起点/手段起点等）のコピペ用キーワードセットを LLM が生成し、Step 3 UI に表示
- **個別特許ファイルアップロード**: `prior-art/route.ts` を拡張し PDF/DOCX/TXT の複数同時アップロードに対応。テキスト抽出して `claimsText` に保存。Step 4 に CSV と並列で個別ファイルアップロード UI を追加
- 分析ステップで `abstract` が null（個別アップロード文献）の場合 `claimsText` をフォールバックに使用

### 変更ファイル
- `src/lib/parse-file.ts` — Buffer+ext ベースに変更
- `src/app/api/cases/[caseId]/draft/route.ts` — ディスク書き込み除去
- `src/lib/generate-queries.ts` — keywordQueries スキーマ+プロンプト追加
- `src/app/api/cases/[caseId]/queries/route.ts` — keywordQueries を rationaleJson に保存
- `src/app/api/cases/[caseId]/prior-art/route.ts` — CSV+個別ファイル両対応
- `src/app/cases/[caseId]/upload-patent-files-form.tsx` — 新規: 個別ファイルアップロード UI
- `src/app/cases/[caseId]/page.tsx` — キーワード表示+個別アップロード UI 追加
- `src/app/api/cases/[caseId]/analyze/route.ts` — abstract フォールバック

### 決まったこと
- ファイルはディスク保存せず、メモリ上で処理してDB保存する方式に統一
- 個別特許アップロードでは AI による請求項分解は行わず、テキスト抽出のみ

### 次にやること
- Vercel デプロイして本番確認
- 従属請求項の分析対応
- UI/UX 改善
