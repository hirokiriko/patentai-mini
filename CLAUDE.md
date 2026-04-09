# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト概要

特許先行技術調査の個人向け PoC。ユーザーの特許案から J-PlatPat 用検索式を生成し、検索結果 CSV を取り込んで請求項・構成要素レベルの重なり検出と拒絶リスクの早期把握を行う。

主要フロー: 特許案アップロード → 請求項抽出 → 検索式生成（広/中/狭） → ユーザーが手動で J-PlatPat 検索 → 結果 CSV 再アップロード → 多層類似度分析 → リスクレポート

## 開発コマンド

ランタイム管理に mise を使用（`mise.toml` でプロジェクトローカルに設定済み）。

```bash
mise exec -- pnpm dev        # 開発サーバー起動（Turbopack）
mise exec -- pnpm build      # プロダクションビルド
mise exec -- pnpm lint       # ESLint
mise exec -- pnpm start      # プロダクションサーバー起動

mise exec -- pnpm db:push     # スキーマを DB に反映（開発用）
mise exec -- pnpm db:generate # マイグレーションファイル生成
mise exec -- pnpm db:migrate  # マイグレーション適用
mise exec -- pnpm db:studio   # Drizzle Studio（DB ブラウザ）
```

## プロジェクト構成

```
src/
├── app/
│   ├── page.tsx                  # 案件一覧・作成
│   ├── cases/[caseId]/page.tsx   # 案件詳細（全ステップ統合）
│   └── api/
│       ├── cases/
│       │   ├── route.ts              # GET/POST 案件 CRUD
│       │   └── [caseId]/
│       │       ├── route.ts          # GET/PATCH/DELETE 案件個別
│       │       ├── draft/            # 特許案アップロード・テキスト抽出
│       │       ├── draft/[draftId]/extract/  # AI 請求項抽出
│       │       ├── queries/          # 検索式生成
│       │       ├── prior-art/        # CSV 取り込み
│       │       └── analyze/          # 重なり分析
│       └── health/route.ts       # ヘルスチェック（DB 接続確認）
├── repositories/
│   ├── types.ts   # リポジトリインターフェース（DB 実装非依存）
│   ├── drizzle.ts # Drizzle/Turso 実装
│   └── index.ts   # エントリ（実装切り替えはここを変更）
├── db/
│   ├── schema.ts  # テーブル定義（5テーブル）
│   └── index.ts   # DB 接続（遅延初期化、Turso 認証対応）
└── lib/
    ├── ai-model.ts            # LLM プロバイダー/モデル切り替え
    ├── parse-file.ts          # PDF/DOCX/TXT テキスト抽出
    ├── extract-claims.ts      # AI 請求項・構成要素抽出
    ├── generate-queries.ts    # AI 検索式生成
    ├── parse-jplatpat-csv.ts  # J-PlatPat CSV パーサー
    └── analyze-overlap.ts     # 2段階重なり分析（スクリーニング + 詳細）
drizzle.config.ts
```

### DB 実装の切り替え方

`src/repositories/index.ts` の import 先を変更するだけで DB 実装を差し替え可能:
```typescript
// 現在: Drizzle/Turso
export { caseRepo, ... } from "./drizzle";
// Firebase に切り替える場合:
export { caseRepo, ... } from "./firebase";
```

## 仕様との実装差異・制限事項

- **重なり分析の4層スコア**: 仕様では独立した4アルゴリズムだが、PoC では AI に一括推定させている。L3 意味類似はベクトル検索未使用
- **重なり分析の2段階方式**: 全文献を1件ずつ分析するとコスト・時間が非現実的なため、スクリーニング（上位20件選定）→ 詳細分析の2段階にしている
- **ファイルアップロード**: ローカル fs 保存のため Vercel 上では永続化されない。本番運用時は Vercel Blob 等に切り替え必要
- **J-PlatPat CSV**: 実データで検証済み（要約列オプショナル対応）。ただし全列パターンの網羅テストは未実施
- **エラーハンドリング**: API の基本バリデーションのみ。LLM 呼び出し失敗時のリトライや部分保存は未実装
- **従属請求項**: 重なり分析は独立請求項のみ対象。従属請求項の分析は未対応

## ドキュメント構成（読む順番）

1. `docs/01-product-brief.md` — 価値提案・成功条件・非目標
2. `docs/02-requirements.md` — 機能要件 FR-01〜FR-06、非機能要件
3. `docs/03-architecture.md` — 技術構成・データモデル・処理フロー
4. `docs/04-query-generation-spec.md` — 検索式生成の入出力・戦略
5. `docs/05-overlap-analysis-spec.md` — 4層類似度分析（L1文字列〜L4構造）・スコア重み・リスクラベル
6. `ops/runbook-manual-search.md` — J-PlatPat 手動検索手順
7. `AGENTS.md` — AI エージェント作業規約

## セッション運用（必須）

**作業開始時**: `ops/handoff.md` → `ops/tasks.md`（In Progress）→ `ops/decisions.md` → `ops/session-log.md` を読む。

**作業終了時**: 以下を必ず更新する。更新しないと複数セッション運用が破綻する。
- `ops/tasks.md` — タスク状態の反映
- `ops/session-log.md` — 実施内容と未解決事項
- `ops/handoff.md` — 次セッションが即着手できる状態に
- `ops/decisions.md` — 設計判断があれば記録

## ドメインルール

- **法的断定禁止**: 「登録可能」「拒絶されない」と断言しない。「重複候補」「一致候補」等の表現を使う
- **請求項ベース**: 独立請求項を主軸に据え、従属請求項と分けて扱う
- **構成要素の分解**: 名詞句の列挙で終わらせず、要素・関係・制約・作用効果に分解する
- **検索式は3系統**: 広め / 中庸 / 狭め を基本とする
- **推測で固定しない**: J-PlatPat の CSV 列定義や PDF 仕様を未確認のまま断定しない

## 想定技術スタック

| レイヤー | 技術 |
|----------|------|
| Frontend | Next.js (App Router) |
| API | Next.js API Routes (Route Handlers) |
| 言語 | TypeScript のみ（Python 併用なし） |
| ORM | Drizzle ORM + drizzle-kit |
| DB | Turso (libSQL) — ローカルは SQLite フォールバック可 |
| DB アクセス | リポジトリパターン（`src/repositories/`）で実装差し替え可能 |
| ベクトル検索 | 未実装（将来 pgvector/Qdrant に拡張可能） |
| LLM | AI SDK — `AI_PROVIDER` / `AI_MODEL` 環境変数で切り替え |
| ファイル保存 | ローカル（`./data/uploads`, `./data/artifacts`） |
| パッケージマネージャ | pnpm |
| デプロイ | Vercel（GitHub 自動連携） |

## 確定済み設計判断

- **DR-0001**: J-PlatPat はユーザーが手動操作。システムは検索式生成と結果分析に集中する
- **DR-0002**: 初期保存層は Turso (libSQL クラウド)。リポジトリパターンで Firebase 等への差し替え可能
- **DR-0003**: LLM 統合に AI SDK を採用。プロバイダー（openai/anthropic/google 等）を .env でコード変更なしに切り替え可能にする
- **DR-0004**: All JS/TS 構成。Python ワーカーは使わず Next.js + TypeScript のみ
- **DR-0005**: ORM に Drizzle を採用。drizzle-kit でスキーマ管理・マイグレーション
- **DR-0006**: パッケージマネージャに pnpm を採用

## 環境変数

`.env.example` を参照。主要な設定:
- `DATABASE_URL` — Turso URL（`libsql://...turso.io`）またはローカル SQLite（`file:./data/app.db`）
- `TURSO_AUTH_TOKEN` — Turso 認証トークン（ローカル SQLite の場合は不要）
- `AI_PROVIDER` — `google` / `openai`（デフォルト: `google`）
- `AI_MODEL` — プロバイダーごとのモデル名（省略時はデフォルト）
- `GOOGLE_GENERATIVE_AI_API_KEY` / `OPENAI_API_KEY` — 使用するプロバイダーの API キー

### Git author 設定

このリポジトリは `kiriko/` 配下にあるため、親ディレクトリの `.envrc`（direnv）で KIRIKO の git identity が適用される。プロジェクトルートの `.envrc` で `hirokiriko` に上書き済み。
