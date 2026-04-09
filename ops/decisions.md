# Decisions

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
