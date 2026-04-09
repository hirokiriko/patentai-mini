# Handoff

## 現在地
主要フロー全7ステップの PoC 実装が完了。Vercel デプロイ済み（GitHub 自動連携）。**次はe2eテストと仕様差異の解消**。

## 次セッションの最優先
1. 実際の特許案ファイルで end-to-end 動作確認
2. LLM プロバイダー/モデルの .env 切り替え対応（現在 gpt-4o ハードコード）
3. UI/UX 改善（ローディング状態の統一、エラー表示）

## 仕様との主な実装差異（CLAUDE.md にも記載）
- 4層スコアは AI 一括推定（独立アルゴリズム化は後続）
- ベクトル検索未使用
- ファイルアップロードはローカル fs（Vercel 上で永続化不可）
- 従属請求項の分析は未対応

## 触るファイル
- `src/lib/*.ts`（モデル切り替え対応）
- `src/app/cases/[caseId]/page.tsx`（UI 改善）
- `ops/tasks.md`, `ops/session-log.md`

## 注意事項
- 推測で CSV 列名を固定しない（実データ検証済みだが全パターン未網羅）
- 類似度だけで危険判定しない
- 独立請求項を主軸に据える
- ローカル git config は hirokiriko アカウント用に設定済み（HTTPS + gh auth git-credential）
