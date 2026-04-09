# Handoff

## 現在地
技術スタックが確定した（DR-0003〜DR-0006）。GitHub リポジトリ作成済み（hirokiriko/patentai-mini）。**次はアプリケーションコードの初期化**。

## 次セッションの最優先
1. Next.js プロジェクトの初期化（pnpm create next-app）
2. Drizzle ORM セットアップ + docs/03-architecture.md のデータモデルをスキーマ定義
3. .env.example を AI SDK 体系に更新
4. Vercel デプロイ確認

## 触るファイル
- `package.json`（新規）
- `src/` or `app/`（新規）
- `drizzle/`（新規）
- `.env.example`
- `ops/tasks.md`
- `ops/session-log.md`

## 注意事項
- 推測で CSV 列名を固定しない
- 類似度だけで危険判定しない
- 独立請求項を主軸に据える
- ローカル git config は hirokiriko アカウント用に設定済み（HTTPS + gh auth git-credential）
