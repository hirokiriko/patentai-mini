# Handoff

## 現在地
主要フロー全7ステップの PoC 実装完了。Turso + Vercel で本番動作確認済み。全ステップ（アップロード〜リスクレポート）がローカルで end-to-end 動作確認済み。**次はブラッシュアップフェーズ**。

## 次セッションの優先候補
1. UI/UX 改善（ローディング状態の統一、エラー表示、レスポンシブ対応）
2. 従属請求項の分析対応
3. ファイルアップロードの Vercel Blob 対応（Vercel 上で完全動作させる場合）
4. LLM プロバイダー追加（anthropic 等）

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
