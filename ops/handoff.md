# Handoff

## 現在地
2026-04-20 本番フィードバック2件（方法B 単独フロー、複数ファイルアップ失敗）に対応。Step 4 の表示条件を請求項抽出済みで解禁し、UI 文言を方法A/B 併用形に更新。先行技術フォームに合計サイズ事前警告と `res.json` 防御を追加（Phase A）。未デプロイ・実機検証未実施。実施例4 の仕様は保留（追加ヒアリング質問を plan に整理）。lint 通過。

## 次セッションの優先候補
1. **Vercel デプロイ＋実機検証** — 方法B 単独で複数ファイル、4MB警告、4.5MBブロック、HTTP 413 ハンドリングを本番で確認
2. **Phase B 実装** — クライアントで PDF/DOCX をテキスト抽出し画像を除外（unpdf + mammoth.browser）、サーバーに JSON 経路追加して payload を数百 KB 以下へ
3. **実施例4 の仕様ヒアリング** — `/Users/mao/.claude/plans/1-ui-4-eager-perlis.md` 末尾の 8 項目をユーザーに確認
4. 従属請求項の分析対応
5. LLM プロバイダー追加（anthropic 等）

## 環境情報
- **Vercel**: https://patentai-mini.vercel.app — GitHub 自動連携 + 手動 `vercel --prod` の両方可
- **Turso DB**: `kiriko` アカウント（h.sato@kiriko.tech）、東京リージョン
- **LLM**: Google AI（gemini）が `.env` でデフォルト設定
- **Git author**: `.envrc`（direnv）で `hirokiriko` に上書き。`kiriko/` 親ディレクトリの `.envrc` が KIRIKO identity を設定するため

## Vercel 環境変数（production に設定済み）
- `DATABASE_URL` — Turso URL
- `TURSO_AUTH_TOKEN` — Turso 認証トークン
- LLM 系の API キーは Vercel 未設定（Vercel 上での LLM 機能は未テスト）

## 注意事項
- `vercel env add` で heredoc 経由だと末尾改行が入る → `printf "value" | vercel env add` を使う
- `.vercelignore` で `.env` を除外済み（ローカル .env が Vercel に含まれないように）
- ~~GOOGLE_GENERATIVE_AI_API_KEY がセッション中に露出 → ローテーション推奨~~ 完了
- 推測で CSV 列名を固定しない
- 独立請求項を主軸に据える
