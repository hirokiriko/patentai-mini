---
name: vercel-preflight
description: |
  Vercel デプロイ前のプリフライトチェック。環境変数の設定漏れ、ビルドエラー、
  git author の不一致を事前に検出する。
  Use when: デプロイ前、deploy、vercel、プリフライト、本番反映前。
disable-model-invocation: true
---

# vercel-preflight

プッシュ前に実行し、Vercel デプロイの失敗を事前に検出する。

## チェック手順

### 1. ビルド確認

```bash
mise exec -- pnpm build 2>&1 | tail -20
```

エラーがあればデプロイは失敗する。先に修正すること。

### 2. git author 確認

```bash
git log --format='%an <%ae>' -1
```

`hirokiriko <hirokiriko9@gmail.com>` であること。
間違っていたら `/safe-commit` の修正手順に従う。

### 3. Vercel 環境変数の確認

ローカルの `.env.example` と Vercel 上の設定を照合する。

#### 必須環境変数（AI 機能に必要）

| 変数名 | 用途 | 備考 |
|---|---|---|
| `DATABASE_URL` | Turso DB 接続 | `libsql://...turso.io` 形式 |
| `TURSO_AUTH_TOKEN` | Turso 認証 | ローカル SQLite なら不要 |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Gemini API キー | `AI_PROVIDER=google`（デフォルト）の場合は必須 |

`AI_PROVIDER=openai` の場合は `OPENAI_API_KEY` が代わりに必要。

Vercel CLI がある場合:
```bash
vercel env ls
```

### 4. API ルートの安全性確認

AI を呼び出すルートに以下が含まれていることを確認:

- `export const maxDuration = 60;`
- AI 呼び出しを `try-catch` で囲み `{ error: message }` を返す

対象:
- `src/app/api/cases/[caseId]/queries/route.ts`
- `src/app/api/cases/[caseId]/draft/[draftId]/extract/route.ts`
- `src/app/api/cases/[caseId]/analyze/route.ts`

### 5. .vercelignore 確認

`.env` が含まれていること（秘密情報がデプロイされない）:
```bash
grep '.env' .vercelignore
```
