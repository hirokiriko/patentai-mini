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
