## Issue

Closes #

## 正本・GitHub内完結の確認

- [ ] 関連Issue本文だけで開始からPR作成まで完遂できる自己完結した指示になっている
- [ ] チャットや過去会話を必須仕様にせず、ユーザーに長文promptの中継を要求していない
- [ ] 不足・矛盾・判断待ちがある場合はIssue／PRへ記録し、必要な停止ラベルを付けた
- [ ] Cloud／Local／Verifier間の修正要求、検証、再検証、引継ぎをGitHub上へ記録した

## 変更概要

-

## 対象範囲

-

## 対象外

-

## 受入条件への対応

| 受入条件 | 対応内容 |
| --- | --- |
|  |  |

## 実施テストと結果

- [ ] `pnpm install --frozen-lockfile`
- [ ] `pnpm lint`
- [ ] `pnpm type-check`
- [ ] `pnpm build`
- [ ] その他のIssue指定テスト

## CI／未実施確認

- CI:
- 未実施・未確認事項:

## 現在head SHAに対する検証記録

- head SHA:
- 検証日時:
- [ ] 上記head SHAに対するコマンド、CI、review、未確認事項を記録した

## Production／deploy影響

-

## 変更影響チェック

- [ ] DB schema／migration変更なし、または変更内容を記載した
- [ ] 環境変数変更なし、または変更内容を記載した
- [ ] secret変更なし、または変更内容を記載した
- [ ] Azure resource変更なし、または変更内容を記載した
- [ ] UI変更なし、または実画面確認結果を記載した
- [ ] publicで許可された情報だけを使用し、秘密情報・機密データ・個人パスを含まない

## rollback方針

-

## 自動処理停止条件

- [ ] `codex:no-auto-merge`、`codex:automation-pause`、`codex:blocked`の有無を確認した
- [ ] pending check、競合、未解決review、Issueの判断待ちを成功扱いしていない

## 未解決事項・引継ぎ

- 未解決事項:
- [ ] 未解決事項、次の担当、再開条件を関連Issue／PR上で引き継いだ

## 残存リスク

-
