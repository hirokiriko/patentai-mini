---
name: safe-commit
description: |
  kiriko/ 配下プロジェクト用の安全なコミット＆プッシュ。
  正しい git author（hirokiriko）を自動適用し、author 不一致による Vercel デプロイブロックを防止する。
  Use when: コミット、プッシュ、git commit、push、デプロイ前のコミット。
disable-model-invocation: true
---

# safe-commit

このリポジトリは `kiriko/` 配下にあり、Claude Code セッションでは direnv が自動適用されない。
デフォルトの author が `KIRIKO-HirokiSato <h.sato@kiriko.tech>` になり、
**Vercel の自動デプロイがブロックされる**（過去2回発生）。

## 手順

### 1. ステージング

```bash
git add <対象ファイル>
```

### 2. 正しい author でコミット

**必ず以下の環境変数を付与する:**

```bash
GIT_AUTHOR_NAME="hirokiriko" GIT_AUTHOR_EMAIL="hirokiriko9@gmail.com" \
GIT_COMMITTER_NAME="hirokiriko" GIT_COMMITTER_EMAIL="hirokiriko9@gmail.com" \
git commit -m "$(cat <<'EOF'
コミットメッセージ

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

### 3. author を検証

```bash
git log --format='%an <%ae>' -1
```

`hirokiriko <hirokiriko9@gmail.com>` であることを確認。
**`KIRIKO-HirokiSato` が表示されたらプッシュしない。**

### 4. プッシュ

```bash
git push
```

## 間違えた場合

未プッシュ:
```bash
GIT_AUTHOR_NAME="hirokiriko" GIT_AUTHOR_EMAIL="hirokiriko9@gmail.com" \
GIT_COMMITTER_NAME="hirokiriko" GIT_COMMITTER_EMAIL="hirokiriko9@gmail.com" \
git commit --amend --no-edit --reset-author
```

プッシュ済み（ユーザーに確認を取ること）:
```bash
# amend 後に
git push --force-with-lease
```
