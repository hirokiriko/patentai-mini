# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト概要

特許先行技術調査の個人向け PoC。ユーザーの特許案から J-PlatPat 用検索式を生成し、検索結果 CSV を取り込んで請求項・構成要素レベルの重なり検出と拒絶リスクの早期把握を行う。

主要フロー: 特許案アップロード → 請求項抽出 → 検索式生成（広/中/狭） → ユーザーが手動で J-PlatPat 検索 → 結果 CSV 再アップロード → 多層類似度分析 → リスクレポート

## 現在のステータス

**ドキュメント・仕様策定フェーズ**。アプリケーションコード（`package.json`、`app/`、`src/` 等）は未作成。`patent_poc_scaffold.zip` にスキャフォールドが同梱されているが未展開。

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
| Frontend | Next.js or 軽量 Web UI |
| API | Next.js API Routes or FastAPI |
| 分析ワーカー | Python |
| DB | SQLite（`file:./data/app.db`） |
| ベクトル検索 | SQLite拡張 → pgvector/Qdrant に拡張可能 |
| LLM | OpenAI（CHAT_MODEL, EMBEDDING_MODEL） |
| ファイル保存 | ローカル（`./data/uploads`, `./data/artifacts`） |

## 確定済み設計判断

- **DR-0001**: J-PlatPat はユーザーが手動操作。システムは検索式生成と結果分析に集中する
- **DR-0002**: 初期保存層は SQLite + ローカルファイル。将来の pgvector/Qdrant 移行を想定した抽象化が必要

## 環境変数

`.env.example` を参照。主要な設定:
- `OPENAI_API_KEY` — LLM/エンベディング用
- `DATABASE_URL` — SQLite パス
- `VECTOR_BACKEND` — `sqlite` / `pgvector` / `qdrant`
- Feature flags: `ENABLE_VECTOR_SEARCH`, `ENABLE_CLAIM_GRAPH`, `ENABLE_MANUAL_REVIEW_QUEUE`
