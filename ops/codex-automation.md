# Codex Automation Runbook

この文書は、`hirokiriko/patentai-mini`におけるCloud Issue WorkerとCloud PR Verifierの運用手順の正本です。各実装Issue本文をタスク、必須仕様、受入条件の唯一の正本とし、Issue／PRを進捗、検証、再検証、引継ぎの正本とします。

## 共通原則

- 各実装Issue本文を、それだけで担当Codexが開始からPR作成まで完遂できる自己完結した唯一の正式指示にします。公開GitHubへのリンクは補足・証拠に限り、必須指示の代わりにしません。
- チャットや過去会話を必須仕様の保存先にしません。開始指示は原則「Issue #Nを進めて」だけとし、ユーザーに長文promptの中継を要求しません。
- Local Codexの開始メッセージには、public GitHubへ保存すべきでない短いLocal専用実行補足を付加して構いません。これは非正本の実行時ヒントであり、目的、仕様、対象範囲、受入条件、優先順位、設計判断、必須テストを変更・補完しません。個人パス、顧客情報、秘密情報、実案件内容をGitHubへ転記せず、Cloud CodexはLocal専用実行補足へ依存しません。
- 不足、矛盾、判断待ちはIssue／PRへ記録して停止ラベルを付けます。禁止範囲を開いたり、チャット履歴で補完したりしません。
- Cloud Worker、Local Codex、Verifier間の開始記録、修正要求、検証、再検証、未解決事項、引継ぎはGitHub上で完結させます。
- ChatGPTは不完全なIssueへ`codex:cloud-ready`または`codex:local-only`を付けません。Workerも実行経路ラベルを自己完結性の証明として扱いません。
- 同一head SHAでchecks、reviews、labels、関連Issueの状態に変化がなければ、同じ検証と同じコメントを反復しません。

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

### 自己完結性確認

`codex:in-progress`の付与とbranch作成より前に、Issue本文だけで次を確認します。

- 背景・目的
- 正本と開始時確認
- 編集可能範囲と閲覧禁止範囲
- 実施内容、受入条件、対象外
- 必須テスト
- Production／deploy影響とrollback
- データ区分とCloud／Local実行経路
- 開始・完了・停止時の状態遷移
- 関連Issue／PRと依存関係

不足、矛盾、判断待ちがある場合は`codex:in-progress`を付けず、branchも作成しません。公開可能な不足項目だけをIssueへ1回コメントし、`codex:blocked`を付けて停止します。同じIssue本文とlabelsのまま同じ不足コメントを反復しません。作業開始後に停止条件が判明した場合は`codex:in-progress`を外し、`codex:blocked`を付け、一般化した理由と再開条件をIssueへ記録します。

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
- 現在head SHAに対する検証記録
- 未解決事項、次の担当、再開条件のGitHub上の引継ぎ
- 残存リスク

PR作成後に`codex:needs-review`を付け、Issueの`codex:in-progress`を外します。修正担当は修正後のexact head SHAとテスト結果をPRへ記録し、`codex:fix-required`を外して`codex:needs-review`へ戻します。Workerおよび修正担当自身はマージしません。

## Cloud PR Verifier

### 内容取得前のmode gate

Open Issueに`codex:automation-pause`が1件でもあれば全処理を停止します。初期候補は`codex:needs-review`、`codex:fix-required`、`codex:local-verified`のいずれかが付いたOpen PRです。

候補ごとに、PR本文、Issue本文、コメント、review本文、diff、patch、変更ファイル内容、Actions log／artifactを取得する前に、次のmetadataだけを取得します。

- PRのnumber、state、base、head SHA、labels
- GitHubのnative linkで関連付けられたIssueのnumber、state、labels

PRまたはいずれかの関連Issueに`codex:blocked`があれば候補から除外します。関連Issueをmetadataで一意に確認できない場合は`METADATA_LINK_REQUIRED`とし、内容を取得せず、`codex:needs-review`と`codex:fix-required`を外して`codex:blocked`を付けます。遷移後のstate fingerprintを公開可能な専用Verifierコメントへ保存し、GitHub上の明示的な関連付けを求める一般化コメントを1回だけ残して停止します。PRまたはいずれかの関連Issueに`codex:local-only`または`data:confidential`があれば`STANDARD_FULL_REVIEW`へ進みません。

Local-only／機密PRは、PRに`codex:local-verified`があり、現在head SHAに一致する公開可能なLocal検証記録が`success`の場合だけ`LOCAL_METADATA_ONLY`とします。Local検証記録の正本は、PR本文全体、または`<!-- codex-local-verification -->`で識別できる公開可能な専用PRコメントです。記録にはexact head SHA、result、検証日時、受入条件、差分、必須テスト、情報管理、merge conflict、未解決review threadなしをLocalで確認済みであることを、機密内容を含めず記載します。PR本文方式は本文全体を公開可能なLocal検証記録として扱える場合だけ有効とし、本文の一部だけを取得する前提にしません。本文に他の欄があり、全体取得を許可できない場合は専用PRコメント方式を使用します。

専用PRコメント方式では、認可されたLocal verifierがコメントを1件に限定して作成または更新し、そのexact comment ID／URLをGitHub由来のVerifier task／trigger inputとして渡します。CloudはそのIDを直接取得し、コメント一覧や他のコメント本文を走査しません。locatorがない、記録のissuerが認可されたLocal verifierと一致しない、または記録のhead SHAが現在headと一致しない場合は、コメントを探索せず`LOCAL_REVERIFY_REQUIRED`とします。

metadataでLocal-only／機密PRと判定した後、Cloudが取得できる本文は、上記Local検証記録と後述する公開可能な専用Verifier記録だけです。PR本文方式では本文全体を1件のLocal検証記録として取得します。専用PRコメント方式ではPR本文を取得しません。他のPR／Issueコメント、reviewコメント本文、diff、patch、追加・削除行、変更ファイル本文、commit内容、Actions log本文、artifact、添付物は取得しません。

labelまたは有効なLocal検証記録がない、検証が失敗している、あるいは記録のSHAが現在headと一致しない場合は`LOCAL_REVERIFY_REQUIRED`とします。Local検証記録以外の内容を開かず、`codex:needs-review`、`codex:fix-required`、古い`codex:local-verified`を外し、`codex:blocked`を付けます。遷移後のstate fingerprintを公開可能な専用Verifierコメントへ保存し、一般化したLocal再検証要求を1回だけ記録して停止します。Local側は現在headの`success`記録を作成した後だけ`codex:blocked`と`codex:fix-required`を外して`codex:local-verified`と`codex:needs-review`を付け、再検証へ戻します。

`LOCAL_METADATA_ONLY`では、停止labels、base、head SHA、mergeability、checks／statusesの状態と、許可されたLocal検証記録のhead一致だけを確認します。受入条件、差分、情報管理、review threadの内容確認はLocal検証記録へ委譲し、それ以外の内容を取得しません。Local-only／機密labelがなく、関連Issueをmetadataで確認できるPRだけを`STANDARD_FULL_REVIEW`へ進めます。

### state fingerprintと重複防止

1件を選ぶ前に、候補ごとに次を安定した順序で正規化し、state fingerprintを作成します。

- head SHA
- checks／statusesのname、status、conclusion
- `STANDARD_FULL_REVIEW`ではreviewのid、state、submittedAt、updatedAtと、review threadのid、isResolved、comment count、last comment id、last comment updatedAt
- PR labels
- 関連Issueのnumber、state、labels、updatedAt
- Local検証記録がある場合は記録場所、comment idまたはPR本文、head SHA、result、updatedAt

`LOCAL_METADATA_ONLY`ではreview／reviewThreadsをqueryせず、許可されたLocal検証記録のresultを使用します。公開可能な専用Verifierコメントに記録された直近のhead SHAおよびstate fingerprintが現在と同じPRは候補から除外し、コメントもlabel操作も行わず次の候補へ進みます。`codex:fix-required`付きPRも、head SHA、checks、reviews、labels、または関連Issueのいずれかが変化した場合だけ再検証します。除外後に残った候補から、優先順位に従って1回に1件だけ処理します。

Verifier記録は、`<!-- codex-verification -->`で識別できる公開可能な専用PRコメントとしてexact head SHA、mode、state fingerprint、resultを保持します。Verifier記録と通常のPR conversationコメントはfingerprintの入力に含めません。label遷移を行った場合は遷移後の最終状態からfingerprintを再計算して保存し、Verifier自身のコメントやlabel変更を次回の新しい状態と誤認しないようにします。

専用GitHub Check／commit statusをLocal検証記録またはVerifier記録の必須経路にはしません。custom Check／status方式を導入する場合は、Project指示、Verifier Task、Local Issue Form、権限、作成・更新経路を別の自己完結Issueで一括整備します。

### STANDARD_FULL_REVIEW

通常PRでは次を確認します。

- 関連Issue本文の自己完結性と受入条件
- 最新head SHA、差分、許可範囲
- CIとchecks。pendingは成功扱いしない
- 秘密情報、機密データ、個人パスの混入
- merge conflict
- reviewと未解決review thread
- Production／deploy、DB、migration、環境変数、secret、Azure resourceへの影響

checksがpendingの場合は`WAITING_CHECKS`として`codex:needs-review`を維持し、同じfingerprintで同じ待機コメントを反復しません。NGの場合は具体的なPRコメントと必要なreview threadを1回だけ残し、`codex:needs-review`を外して`codex:fix-required`を付け、遷移後のfingerprintを`FIX_REQUIRED`として記録します。

修正担当は修正、必要なthread返信、exact head SHAの検証記録をGitHubへ残し、`codex:fix-required`を外して`codex:needs-review`へ戻します。Verifierが安全に修正できる範囲へ最小commitを追加した場合も、新headを`codex:needs-review`へ戻し、その実行ではマージしません。対応を確認したreview threadは返信後にresolveし、未解決事項はIssue／PR上で次の担当と再開条件を引き継ぎます。

### Merge条件

OKの場合はmerge直前にmetadataを再取得し、同じ正規化規則でstate fingerprintを再計算して、検証済みfingerprintと完全一致することを確認します。さらにexpected head SHA、全必須checksのsuccess、merge conflictなし、有効な関連Issue、任意のOpen Issueに`codex:automation-pause`なし、PRと関連Issueに`codex:no-auto-merge`／`codex:blocked`／`codex:fix-required`なしを確認します。

`STANDARD_FULL_REVIEW`では`codex:needs-review`があり、未解決review threadがないことをCloudで確認します。`LOCAL_METADATA_ONLY`ではreview／reviewThreadsをqueryせず、`codex:needs-review`と`codex:local-verified`があり、現在headの公開可能なLocal検証記録が内容検証と未解決review threadなしを証明することだけを確認します。条件成立時のみexpected head SHAを指定してSquash Mergeし、関連IssueをCloseします。`codex:no-auto-merge`付きPRは検証結果だけを残してマージしません。

## 報告

進捗・完了報告では、GitHubへ記録済みの詳細を長文で繰り返さず、ユーザーが次に何をすべきかと作業の区切りを明示します。

### 🚨 Codexへの指示

- 次に必要な指示がある場合は、そのまま送れる文章をコードブロックで示します。
- Issue／PRが自己完結している場合は、原則`Issue #Nを進めて`または`PR #Nを進めて`だけを提示します。
- 指示がない場合も`現在、Codexへの指示はありません`と明示します。
- 長文promptは、public GitHubへ保存できない短いLocal専用実行補足が必要な場合を除いて再掲しません。

### 作業の区切り

次のいずれか1つを独立見出しで明示します。

- `地続きで続行`: 同じIssue／PR／branchで続けるべき作業がある
- `ここで一時休憩OK`: 自動処理待ち等で人の継続操作が不要
- `ここでセッション切替OK`: 引継ぎがGitHubへ記録され、別セッションから再開可能
- `作業完了`: 対象Issue／親Issueの完了条件を満たした

Localでの優先作業に区切りがついた場合、またはユーザーが現在タスクを後回しにすると明示した場合に限り、Open Issueから最大1件を`別タスク（任意）`として提案して構いません。地続きの必須対応と混同しません。

テスト未実施、実画面未確認、Production未確認は明示します。成功していない確認を成功扱いしません。
