---
name: diagnose-vercel-500
description: |
  Vercel 上で API ルートが 500 エラーを返す場合の診断ガイド。
  エラーログの読み方、よくある原因パターン、修正手順を提供する。
  Use when: 500エラー、Internal Server Error、API が動かない、Vercel エラー、デプロイ後に壊れた。
---

# diagnose-vercel-500

Vercel 上の API ルートで 500 が出た場合の診断フロー。

## Step 1: Vercel Function Logs を確認

ユーザーに以下を確認してもらう:
- Vercel Dashboard → プロジェクト → **Logs** タブ
- 該当エンドポイントの POST/GET リクエストを探す
- エラーメッセージをコピーしてもらう

## Step 2: エラーパターン別の対処

### `AI_LoadAPIKeyError: ... API key is missing`

Vercel に API キーが未設定。`.vercelignore` で `.env` を除外しているため、ローカルの値は反映されない。

1. Vercel Dashboard → Settings → Environment Variables
2. `GOOGLE_GENERATIVE_AI_API_KEY`（または `OPENAI_API_KEY`）を追加
3. **再デプロイ**（環境変数追加後はデプロイが必要）

### `FUNCTION_INVOCATION_TIMEOUT`

Vercel サーバーレス関数のタイムアウト。

1. 該当ルートに `export const maxDuration = 60;` を追加
2. Hobby: 最大60秒、Pro: 最大300秒

### `Unexpected end of JSON input`（クライアント側）

サーバーが空ボディの 500 を返し、`res.json()` がパース失敗。

- サーバー側: `try-catch` を追加し `{ error: message }` を返す
- クライアント側: `res.json()` を `try-catch` で囲みフォールバック表示

### `LibsqlError` / DB 接続エラー

`DATABASE_URL` または `TURSO_AUTH_TOKEN` が未設定・無効。

1. Vercel に `DATABASE_URL`（`libsql://...turso.io`）を設定
2. `TURSO_AUTH_TOKEN` を設定
3. Turso ダッシュボードでトークンの有効期限を確認

### エラーメッセージが見えない

API ルートに `try-catch` がなく、未ハンドルの例外が空 500 になっている。

```typescript
try {
  // AI 呼び出し等
} catch (err) {
  console.error("[route-name] failed:", err);
  const message = err instanceof Error ? err.message : "エラーが発生しました";
  return NextResponse.json({ error: message }, { status: 500 });
}
```

## Step 3: 修正後の確認

1. `mise exec -- pnpm build` でビルド成功を確認
2. `/safe-commit` でコミット＆プッシュ
3. Vercel デプロイ完了後、該当機能を再テスト
