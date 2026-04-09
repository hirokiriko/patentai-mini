# Handoff

## 現在地
PoC の土台文書はできたが、まだ**実データ前提の検証**に入っていない。

## 次セッションの最優先
1. 実際の特許案ファイル 1 件を解析対象として受ける
2. 想定される請求項抽出 JSON を決める
3. J-PlatPat 検索結果 CSV の実物を取り込み、列マッピングを作る

## 触るファイル
- `docs/02-requirements.md`
- `docs/04-query-generation-spec.md`
- `docs/05-overlap-analysis-spec.md`
- `ops/tasks.md`
- `ops/session-log.md`

## 注意事項
- 推測で CSV 列名を固定しない
- 類似度だけで危険判定しない
- 独立請求項を主軸に据える
