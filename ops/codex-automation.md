# Codex Automation Runbook

この文書は、`hirokiriko/patentai-mini`におけるCloud Issue WorkerとCloud PR Verifierの運用手順の正本です。GitHub Issueをタスク、受入条件、進捗、引継ぎの正本とし、`ops/decisions.md`は恒久的な設計判断の正本として扱います。

## 情報管理

このリポジトリはpublicです。Cloud処理では公開済み公報、公開コード、公開情報、架空データ、再識別不能な匿名データだけを扱います。

次の情報は取得、閲覧、引用、要約、生成、Issue／PR／コメント／commit／Actionsログへの保存を行いません。

- 未公開の発明、請求項、明細書、図面
- 顧客名、案件名、契約情報、個人情報
- 実案件のJ-PlatPat検索結果や調査資料
- 顧客受領のPDF、DOCX、CSV、画像
- Production DB内容、秘密ログ
- API key、token、password、接続文字列
- 認証付きURL
- ローカル個人パス、個別アカウント情報

機密情報やLocal環境が必要と判明した場合は対象を拡大せず、`codex:in-progress`を外し、`codex:blocked`を付け、一般化した理由だけをIssueへ記録します。

## ラベル

| Label | Meaning |
| --- | --- |
| `codex:cloud-ready` | Cloud Codex実装と条件成立時の自動マージを承認済み |
| `codex:local-only` | Local Codex限定 |
| `data:confidential` | 機密・実データを含むためpublic GitHubへ内容を書かない |
| `codex:in-progress` | Codexが作業中 |
| `codex:needs-review` | Cloud PR Verifierによる検証待ち |
| `codex:fix-required` | 修正後の再検証が必要 |
| `codex:local-verified` | Local環境で必要な検証を完了 |
| `codex:blocked` | 外部判断・情報・環境待ちで停止 |
| `codex:automation-pause` | Open Issueに1件でもあれば自動処理を全停止 |
| `codex:no-auto-merge` | 検証しても自動マージしない |
| `priority:P0` | 最優先 |
| `priority:P1` | 高優先度 |
| `priority:P2` | 通常優先度 |
| `priority:P3` | 低優先度 |

Worker自身は`codex:cloud-ready`を新規付与しません。

## 標準フロー

1. Open Issueを正本として対象、対象外、受入条件、必須テスト、Production影響、rollbackを確認する。
2. 最新default branchからIssue専用branchを作成する。
3. 実装と必要な検証を行う。
4. default branch向けPRを作成し、`codex:needs-review`を付ける。
5. Cloud PR VerifierがIssue、差分、CI、レビュー状態を検証する。
6. 条件を満たす場合だけexpected head SHAを指定してSquash Mergeする。
7. `Closes #...`で関連IssueをCloseする。

同一IssueをCloudとLocalで同時作業しません。`main`への直接pushは原則禁止です。Issueにない機能、将来拡張、先制的最適化は追加しません。

## Cloud Issue Worker

### Repository確認

毎回、Repository名、visibility、default branch、default branch HEAD、`AGENTS.md`、Open Issue、Open PR、関連checksとworkflow、現在時刻を確認します。Repository名、visibility、default branchが想定と異なる場合は変更を加えず終了します。

### 全自動停止

Open Issueに`codex:automation-pause`が1件でもある場合は全処理を停止します。この場合、Issueコメント、ラベル変更、branch作成、commit、PR作成を含むGitHub変更を行いません。

### 候補選定

候補はOpenかつ`codex:cloud-ready`付きに限定し、次のいずれかが付いたIssueを除外します。

- `codex:local-only`
- `data:confidential`
- `codex:in-progress`
- `codex:blocked`
- `codex:automation-pause`

優先順位はP0、P1、P2、P3、優先度なしの順です。同順位では作成日時が古いIssueを優先し、1回に1件だけ処理します。

### 重複着手防止

着手前に次を確認します。

- Issueを閉じる、または関連付けるOpen PR
- Issue番号に対応する既存作業branch
- 過去の開始コメントに残る未完了作業
- 他のCloudまたはLocal担当の作業
- 同じ受入条件を扱う別のOpen Issue／PR

重複があるIssueには着手しません。候補がない場合はGitHubへ不要なコメントを残しません。

### 着手と実装

着手時に`codex:in-progress`を付け、最新default branchから`codex/issue-<Issue番号>-<slug>`形式の専用branchを作成し、Issueへ次だけを記録します。

- 担当: Cloud Codex
- baseline HEAD SHA
- branch名
- 開始日時
- 今回の対象範囲
- 実行予定のテスト

実装はIssueと`AGENTS.md`の現在要件を満たす最小範囲に限定します。Production DB、Azure resource、secret、環境変数は直接操作しません。実データを取得せず、公開情報または架空データだけを使用します。

### 検証とPR

Issueと`AGENTS.md`指定のテストを実行し、実行不能な確認は成功扱いせず理由と未確認範囲をPRへ記載します。PRには少なくとも次を含めます。

- `Closes #<Issue番号>`
- 変更概要、対象範囲、対象外
- 受入条件への対応
- 変更ファイル一覧
- 実行したコマンドと結果
- 失敗または未実施の確認
- Production／deploy影響
- DB schema／migration影響
- Azure resource／secret／環境変数変更の有無
- rollback方法
- 残存リスク

PR作成後に`codex:needs-review`を付け、Issueの`codex:in-progress`を外します。Worker自身はマージしません。

## Cloud PR Verifier

### 対象選定

Open Issueに`codex:automation-pause`が1件でもあれば全処理を停止します。対象は`codex:needs-review`、`codex:fix-required`、`codex:local-verified`のいずれかが付いたOpen PRから1件だけ選びます。

### 検証

次を確認します。

- 関連Issueと受入条件
- 最新head SHAと差分
- CIとchecks。pendingは成功扱いしない
- 秘密情報、機密データ、個人パスの混入
- merge conflict
- 未解決review thread
- Production／deploy、DB、migration、環境変数、secret、Azure resourceへの影響

NGの場合は具体的なPRコメントを残します。安全に修正できる範囲は同branchへ最小修正できますが、Verifierが修正commitを追加した実行ではマージしません。

### Merge条件

OKの場合はmerge直前に`codex:no-auto-merge`、`codex:automation-pause`、`codex:blocked`がないことを再確認します。条件成立時のみexpected head SHAを指定してSquash Mergeし、関連IssueをCloseします。`codex:no-auto-merge`付きPRは検証結果だけを残してマージしません。

## 報告

テスト未実施、実画面未確認、Production未確認は明示します。成功していない確認を成功扱いしません。
