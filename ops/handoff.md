# Handoff

## 現在地
2026-04-22 方法B の PDF 取り込みバグを vendor/ 方式で修正し、**本番 Vercel まで動作確認完了**。最終 commit は b1086fb（main）。`https://patentai-mini.vercel.app/api/cases/7/prior-art` に 3 件 POST で `{"imported":3}`（12 秒）、Turso に日本語本文が保存されることを確認。テスト用ケース caseId=6 (ローカル)・caseId=7 (本番 "prod pdf smoke test") が Turso に残っている。詳細な構成の理由は `~/.claude/projects/-Users-mao-dev-kiriko-patentai-mini/memory/reference_pdfjs_vendor.md` 参照（安易に vendor/ 方式を戻すと本番が落ちる、5 段階の罠を全部踏んだ結果の構成）。

2026-04-21 改善点カタログ作成＋ Top 10 Quick Wins のうち 5 件（`.env.example` 整理 / queries route JSON.parse try/catch / 案件フォーム IME ガード / `type-check` script / GitHub Actions CI）をローカル実装、`pnpm lint` / `pnpm type-check` 通過。未デプロイ・未プッシュ。改善点カタログは `/Users/mao/.claude/plans/distributed-meandering-shell.md` にあり、残り Quick Wins は A2 FK cascade / A3 transaction / A1 element_score / C5 active draft / G1 vitest 最小テスト。2026-04-20 の方法B 単独フロー＋ payload 警告（Phase A）も未デプロイのまま残っている。

## 次セッションの優先候補
1. **Vercel 本番へ LLM API キー設定（E4）** — `printf "$KEY" | vercel env add GOOGLE_GENERATIVE_AI_API_KEY production`。未設定のままでは本番 LLM が全滅
2. **Vercel デプロイ＋実機検証** — Quick Wins 5 件＋方法B単独フロー＋ Phase A（payload 警告）＋**pdfjs-dist 差し替え**を 1 回のデプロイで一緒に確認。pdfjs-dist の cmap/standard_fonts は `outputFileTracingIncludes` で Lambda にバンドルされる想定だが、本番 Lambda の `process.cwd()` 配下に `node_modules/pdfjs-dist/cmaps/` が存在するかは未検証（動かない場合はパス解決を見直し）
3. **残り Quick Wins** — A2 FK cascade / A3 `replaceByCaseId` トランザクション / A1 `element_score` カラム追加 / C5 複数ドラフト active 明示 / G1 主要 4 モジュール vitest テスト
4. **Phase B 実装** — クライアントで PDF/DOCX をテキスト抽出し画像を除外（unpdf + mammoth.browser）、サーバーに JSON 経路追加して payload を数百 KB 以下へ
5. **実施例4 の仕様ヒアリング** — `/Users/mao/.claude/plans/1-ui-4-eager-perlis.md` 末尾の 8 項目をユーザーに確認
6. 従属請求項の分析対応
7. LLM プロバイダー追加（anthropic 等）

## 環境情報
- **Vercel**: https://patentai-mini.vercel.app — GitHub 自動連携 + 手動 `vercel --prod` の両方可
- **Turso DB**: `kiriko` アカウント（h.sato@kiriko.tech）、東京リージョン
- **LLM**: Google AI（gemini）が `.env` でデフォルト設定
- **Git author**: `.envrc`（direnv）で `hirokiriko` に上書き。`kiriko/` 親ディレクトリの `.envrc` が KIRIKO identity を設定するため

## Vercel 環境変数（production に設定済み）
- `DATABASE_URL` — Turso URL
- `TURSO_AUTH_TOKEN` — Turso 認証トークン
- `GOOGLE_GENERATIVE_AI_API_KEY` — 登録済（2026-04-21 vercel env add で判明。既存登録の値が現行のものかは未確認）
- Vercel 上での LLM 機能の実機動作確認は未実施

## 注意事項
- `vercel env add` で heredoc 経由だと末尾改行が入る → `printf "value" | vercel env add` を使う
- `.vercelignore` で `.env` を除外済み（ローカル .env が Vercel に含まれないように）
- ~~GOOGLE_GENERATIVE_AI_API_KEY がセッション中に露出 → ローテーション推奨~~ 完了
- 推測で CSV 列名を固定しない
- 独立請求項を主軸に据える
