# Handoff

## 現在地
2026-05-14（本セッション・5 件目）本番で重なり分析が 504 を返したため、`analyze-overlap.ts` の thinkingLevel を 'medium' → 'low' に下げる。`pnpm lint` / `pnpm type-check` 通過。コミット後 push して実機検証が必要。

2026-05-14 先行技術文献の選択削除 UI と CSV 重複時の publicationNo upsert を実装。チェックボックス + 一括削除のクライアントコンポーネント、DELETE API、リポジトリ層に upsert/delete メソッド追加。362 件中半分が重複している本番データは UI から削除可能になった。コミット `57731e2` で本番デプロイ完了。

2026-05-14 AI SDK と Google 公式 thinking docs を再調査し設計見直し。`getModel()` / `getFastModel()` の default を `gemini-3.1-flash-lite`（stable、preview 未使用）に統一。analyze-overlap の 2 つの generateObject に `providerOptions.google.thinkingConfig.thinkingLevel: 'medium'` を追加。コミット `b2627b0` で本番デプロイ完了。analyze-overlap の 60s 収まり実機検証は未実施。

2026-05-14 `getModel()` のモデル指定を Gemini 2.5 系 preview から 3.1 系 preview (`gemini-3.1-flash-preview`) に更新（コミット `a4877b8`、未 push）。直後にユーザー指示で `gemini-3.1-flash-lite`(stable) に再変更したため、このコミットは flash-preview を一度経由する形になっている。

2026-05-14 本番 `POST /api/cases/13/queries` の 504 Gateway Timeout に対応。`src/lib/generate-queries.ts` を `getFastModel()` + 入力圧縮（独立請求項と core 要素のみ抜き出した構造化テキスト）に変更し、`9b69088` でデプロイ完了、本番で実機確認済。

2026-05-08 FR-07 国内優先権主張出願モードを実装（DR-0009）。父の「公開前の出願済み特許に新規事項を付け加える特許」要望に対応。仕様 / DB スキーマ / Repository / 統合 AI / API / UI を一通り追加し、`pnpm lint` `type-check` `build` 通過、ローカル dev でベース出願モード案件の作成と画面描画まで確認。Turso 本番にもスキーマ反映済（`scripts/migrate-fr07.mjs` を 1 回実行）。Vercel への push は未実施。

2026-05-08 父からの追加情報を受けて J-PlatPat 検索式の構文エラー（中庸が二重ネストで `論理式のカッコの使用方法が間違っています` を返す）を根絶するプロンプト書き直しをローカル完了。`eslint.config.mjs` に `vendor/**` ignore を追加して lint も復旧。`pnpm lint` / `pnpm type-check` 通過。未コミット・未デプロイ。本番には 2026-04-22 の b1086fb までしか反映されていないので、push 後の検証で「方法B 単独フロー」「Phase A 警告」「J-PlatPat 構文修正」「Quick Wins」「pdfjs-dist 構成」「FR-07 ベース出願モード」がまとめて検証される。

2026-04-22 方法B の PDF 取り込みバグを vendor/ 方式で修正し、**本番 Vercel まで動作確認完了**。最終 commit は b1086fb（main）。`https://patentai-mini.vercel.app/api/cases/7/prior-art` に 3 件 POST で `{"imported":3}`（12 秒）、Turso に日本語本文が保存されることを確認。テスト用ケース caseId=6 (ローカル)・caseId=7 (本番 "prod pdf smoke test") が Turso に残っている。詳細な構成の理由は `~/.claude/projects/-Users-mao-dev-kiriko-patentai-mini/memory/reference_pdfjs_vendor.md` 参照（安易に vendor/ 方式を戻すと本番が落ちる、5 段階の罠を全部踏んだ結果の構成）。

2026-04-21 改善点カタログ作成＋ Top 10 Quick Wins のうち 5 件（`.env.example` 整理 / queries route JSON.parse try/catch / 案件フォーム IME ガード / `type-check` script / GitHub Actions CI）をローカル実装、`pnpm lint` / `pnpm type-check` 通過。未デプロイ・未プッシュ。改善点カタログは `/Users/mao/.claude/plans/distributed-meandering-shell.md` にあり、残り Quick Wins は A2 FK cascade / A3 transaction / A1 element_score / C5 active draft / G1 vitest 最小テスト。2026-04-20 の方法B 単独フロー＋ payload 警告（Phase A）も未デプロイのまま残っている。

## 次セッションの優先候補
1. **Vercel デプロイ + FR-07 実機検証** — main に push して Vercel デプロイ後、父にベース出願（公開前の特願 2026-40454）+ 新規事項（UI 仕様）を 2 ファイルでアップロードしてもらい、統合 → 請求項抽出 → 検索式 → 分析 までの一気通貫を確認する。統合 AI（`src/lib/integrate-claims.ts`）のプロンプトは実データなしで作っているので、出力品質の調整が必要になる可能性が高い
2. **Vercel デプロイ＋父による J-PlatPat 構文再検証** — 今回の修正版検索式（広/中/狭）を J-PlatPat に貼り付けて構文エラーが消えていることを確認。中庸は特に `((..)/CL+(..)/AB)*((..)/CL+(..)/AB)` の二重ネストが消え、`(..)/CL*(..)/CL` または `(A)/CL*(B)/CL+(A)/AB*(B)/AB` のフラット展開になっているはず
2. **構文エラーが再発した場合**: `src/lib/generate-queries.ts` に出力後の sanitize / 検証関数を追加（タグ後置の式が更にカッコで括られているケースを検出して再生成またはフラット展開に変換）
3. **残り Quick Wins** — A2 FK cascade / A3 `replaceByCaseId` トランザクション / A1 `element_score` カラム追加 / C5 複数ドラフト active 明示 / G1 主要 4 モジュール vitest テスト
4. **Phase B 実装** — クライアントで PDF/DOCX をテキスト抽出し画像を除外（pdfjs-dist + mammoth.browser）、サーバーに JSON 経路追加して payload を数百 KB 以下へ
5. **追加要望B（環境選択 UI）** — 父からの追加情報待ち（plan 末尾 4 項目）。要件が固まったら DR-0009 として記録した上で設計
6. **実施例4 の仕様ヒアリング** — `/Users/mao/.claude/plans/1-ui-4-eager-perlis.md` 末尾の 8 項目をユーザーに確認
7. 従属請求項の分析対応
8. LLM プロバイダー追加（anthropic 等）

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
