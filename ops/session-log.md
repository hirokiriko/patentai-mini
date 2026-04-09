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
