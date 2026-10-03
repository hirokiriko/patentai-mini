# 標準特許ウォッチ運用

## Issue #140 の月限定完遂承認

`ISSUE140_COMPLETION_V2` のOWNER原本は非公開で保持し、原本digest、対象月、期限、
有効profile、全履歴の累計枠を既存の署名reviewへ拘束する。具体値は公開しない。
通常profileの月額上限と従来のrelease履歴を変更・リセットしない。
互換コードの初回配備は、署名済み `release-start` のIssue140専用stepで行う。
このstepは既存Standard profileと通常月planにも通る予約に限定し、全履歴累計を追加照合する。
保存stateは旧形式のままとし、fresh CAS ACKだけを一度限りの実行許可とする。
App/Job/image/buildの対応確認後、署名month reviewで10月限定 `completionAllowance` を
適用・読戻しする。業務は当該profileの通常入口を使い、workerやstage再開でも期限を検証する。
11月には例外を使わず通常月額と月枠へ戻すが、全履歴・予約・不明usageは保持する。
新形式適用後は非互換imageへ戻さず、承認内で互換コードまたは正規設定復帰を使用する。
この手順の記載やLocalテストだけでは、配備・帳票引渡しの完了にならない。

仕様・実行承認の正本は [Issue #129](https://github.com/hirokiriko/patentai-mini/issues/129)、
承認済みサービス契約は [親 #128](https://github.com/hirokiriko/patentai-mini/issues/128)。
本書は運用手順を記録する。実装中の手順を本番受入済みとは扱わない。

## OWNERの操作：ZIPからPDF・CSVまで

Issue #140の表示方針では、画面・印刷・新規生成PDF/CSVのリスク段階を廃止します。
比較説明と原文根拠、未確認・取得不足・処理失敗の注意は残します。旧納品版の閲覧画面も
現在の表示形式で示しますが、「保存原本のPDF/CSVを取得」は生成当時の原本を返します。
新形式で渡す場合は保存済み比較結果から別の納品版を作り、旧原本は保持してください。
表示変更のための再比較・再AI実行は不要です。

1. 正規経路で取得した差分公報ZIPを用意し、固定Production URLへOWNERとしてログインします。
2. 案件一覧の「公報データの更新」を開き、ZIPを1本選びます。表示されたファイル名とサイズを確認し、
   「アップロードして取り込む」を押します。アップロード完了までは画面を開いたままにします。
3. 「取込完了」と件数を確認します。クラウドで保存内容を検証して取り込みます。
   処理状態のリンクを保存すれば、別端末からOWNERとして開いて続きの状態を確認できます。
4. 案件の標準ウォッチ画面で対象公開期間を指定して準備し、「比較を開始」を押します。
   受理後の比較は既存クラウドJobで動きます。完了後にAI比較結果と原文・確認状態を確認します。
5. 同じ期間の納品版を作成し、保存済みのPDF・CSVを取得します。OWNERが内容を確認して手動納品します。

取得不足・未解析・未実行・失敗・結果不明は正常0件ではありません。少量だけ取り込んだ期間は
網羅済みになりません。未完了の納品版には不足範囲が残ります。同じZIPはDBへ二重追加しません。
応答不明時は同じ処理の「状態を確認」を使い、別処理として再送しないでください。
予算予約後の中断は予約済み・開始未確認として表示します。照合リンクと実行番号を運用担当に伝えます。

初回受入は少量の正規公開packageで本番経路を確認します。
全21 ZIP・約100GiBの投入、過去全量バックフィル、月間全量能力の実証は今回のGO条件に含めません。
配布元取得の自動化、scheduler、顧客向け自動メール・ポータル・課金は対象外です。
本番受入成立後の「OWNERによる実運用用差分ZIP投入待ち」は正常な完了状態です。

対象は1社・監視元最大5件の公開/登録済み日本特許、運営者はOWNER1名。
同時に有効な監視設定を5件までとし、無効化済み設定と過去の結果・原本は保持できます。
対象を入れ替える場合は既存設定を無効化し、署名済みprofileとallowlistも正規手順で対応させます。
設定を無効化しても、実行履歴・費用・予約・releaseの累積上限はリセットされません。
受入試験の最大5件と、署名済み標準運用profileの最大5件は別枠です。試験履歴・費用・
未確定予約は台帳に残します。OWNERが事前設定した公開サンプルを引き続き使う場合は、
その原本と設定を保持して標準運用profileへ含めます。不要な試験用設定だけを限定cleanupします。
標準運用profileの有効化時には、ZIP・watch設定と `MANAGED_ARTIFACT_APPROVAL` を
`STANDARD_MANAGED_WATCH_STANDARD_V1` に揃え、allowlistを当該profileの監視元へ更新します。
正規取得した日本の新着公開系公報を候補選別し、採用文献の請求項全文と
指定請求項全文を比較する。専門的評価・最終判断は納品先が原文で行う。
明細書全頁、図面、外国公報、権利状態、侵害判断は対象外。標準は個別見積、
カスタムは別見積。PDF/CSVのメール送信は運営者が手動で行う。

## 日程と確認

契約日、監視開始日、公報公開日、取得日、比較日、生成日、納品日を分ける。
監視開始日から最初の25日までを初回とし、26日以降の開始は翌月25日まで。
以後は26日〜翌月25日。25日の公開期間境界は固定し、納品日は月末が土日祝なら
直前営業日とする（親D3）。祝日暦の確認済み範囲外を営業日と推定しない。
祝日源は [内閣府](https://www8.cao.go.jp/chosei/shukujitsu/gaiyou.html)。

週次で正規配布一覧と取得ファイルを照合し、締め時にも不足を確認する。
取込済みの翌周期公報、遅延掲載、訂正版、同内容再掲載を区別する。
未取得、未解析、未実行、失敗、結果不明、fallbackは正常0件ではない。
請求項全文が未確認の候補は要原文確認として残し、詳細AI比較の対象には選びません。
不足時は対象範囲を記した連絡用文案を作り、解消後は元納品版と関係を持つ
補足/訂正版を発行する。元のPDF/CSVと同時点の確認状態は変更しない。

## 実行・復旧境界

Local rootが唯一のwriter、独立レビューは読み取り専用。旧#123の試験枠、
不明usage、費用、復旧予約を今回へ移転/解放しない。既存Manual Jobを再利用し、
import LOGINとwatch用最小権限LOGINを分離する。共通公報を顧客情報から分離する。
OWNER認証と非公開保存の確認前に本番試験案件を作らない。

追加実費は税込50,000円（目標30,000円）、既存基礎料金を含む月額は30,000円
（目標20,000円）。不明費用を0にせず、各有料工程前に残工程・保存・復旧を予約。
8割で内部再見積し、収まらない場合は新しい有料処理を停止する。

Issue #129の追加承認に限り、2026年9月のrelease月次planには独立レビュー・
署名済みの`releaseMonthlyCapYen`を保持できる。金額の原本は非公開の承認・台帳で照合し、
通常profile、指定月外、省略時の月3万円、追加累計・回数・期限は維持する。
互換コードのApp/Job配備前は旧plan形式を維持し、承認された全残工程の非公開見積と
既存pool内の段階release許可を照合する。配備確認後に新形式の月次planをCAS適用する。
旧imageへ戻せるのは、月3万円を超えるforecastを持つ設定・manifestの保存前に限る。
新規処理を停止し、元snapshotを基に当該optional項目だけを省略した署名month planへ
戻してから配備する。保存後は、当該形式を読める互換imageで引用修正を戻すか修正配備する。
費用・消費・不明予約を削らず、旧上限を超える間は業務開始が停止することを確認する。
認証・原本・保存結果や保存済み設定を削除・改変して復旧扱いにしない。

本リリース累計上限は架空case5、watch開始40、normal900/fast80、Job24実行/48時間、
package64/合計96GiB、forward deploy8/rollback2。1package8GiB、1Job120分/2vCPU/4GiB、
parallelism1/completionCount1/retry0。全文watchだけnormal41/fast0・30分、
1要求35秒・保守的入力見積normal150,000/fast50,000・出力8,192tokens。
結果不明のwrite/AI/Job startを再送せず、保存済み対応情報で照合する。

比較が失敗した場合は、保存されたrunのerror_codeとdispatchの段階・status・usageを限定読取する。
`incomplete:<段階>:<固定理由>`は原因区間の記録であり、成功した比較結果ではない。
`unclassified`はその段階で分類未確定を意味し、引用位置の誤りやDB障害と断定しない。
不明dispatchがあれば従来どおり`outcome_unknown`を優先し、追加AI・別runの盲目的な再送を止める。
例外本文・SDK応答・請求項・秘密は診断コードに保存しない。旧runへ後から理由を推定追記しない。

まとめ比較が途中で失敗した場合も、まず同じ処理の状態を照合する。固定実行ID・templateが
一致したAzureのFailed/Stopped終端を確認した場合だけ、未着手の予約済みrunを失敗確定する。
実行開始・AI送信・保存結果のあるrunはこの処理で変更しない。旧runと費用・回数予約は保持し、
未着手分の再比較は新しい実行準備と新しい有限予約から行う。状態照合はJobを再開始しない。
記録済み実行でAzure応答の秘密参照名だけが異なる場合は、実行IDと通常設定（保存config文字列を
含む）の完全一致に加え、同じ予約・config・snapshot・実行IDでworkerが受理し終端したDB記録を
ロック内で確認する。秘密参照名そのものが同一とは推定しない。受付証拠がない場合や通常設定が
異なる場合は未着手runも変更しない。この代替証明は、応答不明時の実行探索には使用しない。

2026-09-23の追加承認は圧縮ZIPの各8GiB/累計96GiBだけ。旧pilotの各2GiBを変更しない。
managed取込は従来のparser上限を保持し、宣言展開総量16GiB、実読取展開総量8GiB、
1entry2GiB、directory128MiB/25万件、CSV128MiB/XML64MiBを超えれば未完了として停止する。
大きいZIPに連動して上限を緩めず、実RSS・一時disk・時間の適合も取得前/本番開始前に確認する。

契約中と終了後90日は顧客対応・設定・結果・納品物を保持する。期限プレビュー、
所属照合、明示実行、結果確認を行う。共通公報/他案件は削除しない。
バックアップの残存期間と復元後の削除再適用を記録する。復元試験は実際の
非公開保管経路から今回架空対象だけを隔離PG16へ行い、全体災害復旧とは区別する。

## リリース判定

必須test/CI、独立レビュー、情報保護、少量packageの画面uploadから実DB/実AI、最大5対象、新公報を挟む2巡、
無変更AI0、本番PDF/CSV全頁全文、固定Production URLの主要操作とLocal PC非依存、費用、限定cleanup、正式資材保持、
製品経路の架空サンプルと納品セットをすべて照合する。実行結果はIssue/PRと
非公開Local証跡に記録し、全成立時だけSTANDARD_MANAGED_WATCH_PRODUCTION_GOとする。
2026-09-29のOWNER決定に従い、現行Productionの固定URL・App/Job/image/build・DB/Storage設定を、
本番受理→クラウド終端→永続保存→OWNER認証付き再取得の記録へ対応付ける。
同一build・設定・対象の有効な証拠を再利用する。HTTP200だけを業務完了の根拠にしない。
ローカルトンネル・ローカルサーバー・常駐workerを本番経路に使わない。
PC実停止・別端末・OSログ提出や、代替のブラウザー終了・通信切断試験は要求しない。
未実施のPC停止をPASSにせず、未実施を停止理由にもしない。#137はnot_plannedで依存から外す。

## 初回準備と標準コマンド

以下は運用担当の初期設定・復旧用です。通常のOWNER更新は上記の画面から行います。
Web入口には対象を照合した `MANAGED_KOHO_UPLOAD_SETTINGS` と `MANAGED_WATCH_WEB_SETTINGS`、
既存共通予算bindingをAppへ設定します。設定にsecret値を含めず、既存Jobの専用secretRefを参照します。
App/Jobの実imageとbuild SHA、watch/importの異なるDB LOGIN、OWNER認証、予算期限を一致させます。
AppのJob起動・状態照合には既存App identityを `MANAGED_ARM_IDENTITY_CLIENT_ID` で指定します。
共通予算bindingの `MANAGED_BUDGET_IDENTITY_CLIENT_ID` はJob側のidentityを維持し、Appへ兼用しません。

これはOWNERの管理手順であり、ブラウザーのログインcookieや資格情報をJSON・argvへ入れない。
対象resource、code SHA、app/Jobのimage digest、DB LOGIN、case allowlistを照合した非公開bindingを一度用意する。
秘密は既存OSストアから保護processの環境へ渡し、コマンド結果・JSONは追跡外の保護された場所だけに保存する。
以下のコマンドはrepository rootで実行し、JSONは標準入力へ渡す。実値をshell履歴やGitHubへ貼らない。

```text
pnpm install --frozen-lockfile
node scripts/build-managed-operators.mjs
node .koho-ops/managed/scripts/managed-base-preview.js
node .koho-ops/managed/scripts/managed-koho-preview.js
node .koho-ops/managed/scripts/managed-koho-transfer.js
node .koho-ops/managed/scripts/managed-koho-operator.js
node .koho-ops/managed/scripts/managed-watch-operator.js
```

buildは未変更のレビュー済みcheckoutだけを受け付け、2つのworkerと管理入口をcompileして
`.managed-build-sha`を固定する。Job実行用のstage/startは配備imageに対応したコードだけで行う。
Jobを起動しない`archiveOnly`の保存に限り、レビュー済みLocal SHAと現在のJob image digestを
別々にpolicyへ固定できる。Local SHAを照合し、管理wrapperのARM操作を拒否して、
`start`を使用しない。原本保存のためだけにJobやappを配備しない。
過去のstatusは保存された元SHAで照合できる。実行中のビルド書換えは禁止。

初回は次の順で行う。

1. OWNERとして固定URLにログインし、架空又は承認対象の案件を作る。
2. 正規取得したA1/P1/B1/B2の監視元XML原本を案件の参考文献アップロードから保存する（4MiB以内）。
   標準全文比較は確認済みXML経路を使う。PDF等の既存AI抽出結果を全文の証明として流用しない。
3. `managed-base-preview`へ `sourcePath, documentId, packageType, entryPath, kind, publicationNumber, publicationDate, sha256` を渡す。
   `documentId`は保存した原本のID、`entryPath`と書誌事項は正規配布の索引と一致させる。
   出力の`base/source`は完全な公開請求項を含む非公開作業用入力。標準設定JSONへそのまま組み込む。
4. watch operatorの`setting-save`で契約日・監視開始日・終了日又はnull・enabled・指定請求項番号を登録する。
   原本Blobの読戻し、SHA・全文・番号・版・出願番号が一致しなければ保存しない。
   画面と固定原本URLで読み戻す。選択集合に必要な参照請求項は実原文に存在するものだけを含める。

watch operatorの入力は `{schema:1,binding,request}`。bindingは`managed-cloud-config`の
operationId/runs/expiresAt/budgetProof以外の固定項目。各requestは次の表の項目だけを持つ。

| command | 追加項目と用途 |
| --- | --- |
| setting-save | setting: caseId・日付・enabled・base・source・selectedClaimNos |
| start | operationId, runIds（最大3）, budgetProof。台帳予約後に既存Jobを一度だけ開始 |
| start-reconcile | operationId。固定Jobの実行と永続runを読み戻す |
| status | caseId。実行履歴と納品版の保存状態を確認 |
| finding-status / finding-review | caseId, findingId。変更時は reviewed, expectedVersion も指定 |
| distribution-acquire | 最新の公式配布一覧を取得してhashと取得日時を固定 |
| backup-create / backup-reconcile | caseId, backupId。reconcileは必要時だけabandonMissing |
| backup-verify-restore | caseId, backupId, recoveryOperationId。backupIdとは別の固定UUIDで予約し、実保管bytesから今回対象だけ隔離PG16へ復元 |
| deletion-preview | caseId。削除予定graph・原本・納品物・backupを固定 |
| deletion-execute / deletion-reconcile | caseId, deletionId, manifestDigest。特定previewだけを実行/照合 |

比較の実行準備と納品版作成は固定Web画面を使い、候補選別・PDF/CSV生成・保存をAzure上で完結させる。
`delivery-reconcile`はcaseId/deliveryId/abandonPartialによる管理用照合だけを行い、再生成しない。

## 週次取得から納品まで

1. [JPO公報発行サイト](https://www.gazette.jpo.go.jp/)の正規配布一覧と利用条件・掲載保持期間を確認し、
   今回対象のJPAを1 packageずつ手動取得する。下記の転送専用slotを使用し、全周期ZIPをLocalへ蓄積しない。
   既存ユーザー保存原本は保持し、取得日・公開日・号・サイズ・SHAを台帳へ記録。
   許可されたpackage/累計サイズを超えるものはpreview/uploadせず停止する。
2. `managed-koho-preview`へ `{schema:1,sourcePath,byteLength,sha256}` を渡し、元ファイルを変えず有限parseする。
   plan/Sources/Receiptのhash、A1/P1/A5/P5件数、未解析、補正の原番号/原日付欠落、展開量、時間・実測RSSを確認。未解析を0とみなさない。
3. まず1 packageだけの`archiveOnly:true` manifestを作り、`acquiredAt`も固定する。
   import operatorへ `{schema:1,command,config,manifest,job,sources}` を渡す。
   通常運用のconfigは有効な標準profileのSTANDARD_MANAGED_WATCH_STANDARD_V1を使う。
   過去のリリース試験記録はRELEASE_V1のまま保持する。manifestは配布一覧hash・preview結果・8GiB以内の各package・
   6時間以内の期限・累計予約を固定。sourcesは各`sha256/path`。先にread-onlyの`prepare`で
   料金表・固定対象に結合したconfig/manifestを取得し、Localへ保存してから`stage`に渡す。
   `stage`の返すETag付きconfig/manifestと`archive`参照も保管する。これは原本保存でありJobを開始しない。
   Azure正本の完全性と台帳のstage完了を確認した`release-transfer`だけで転送slotを解放し、次の1 packageへ進む。
4. 保存済み`archive`参照を各packageへ付け、`archiveOnly`なしのJob manifestを作る。
   1〜4 package・合計8GiB以内でまとめ、各ZIPの原本identityは保持する。Local ZIPは不要、`sources:[]`とする。
   取込Jobの全量ZIP取得は、短いmetadata処理のserver timeoutを流用せず、Blobのサイズ別既定値を使う。
   転送中もJob停止signalとmanifest・予算permitの最短残期限で中断する。SDK/body再試行なし、
   ETag・全量SHA・既存解析上限は維持する。保存前の失敗でも同じ実行を再起動せず、正式receiptと
   非稼働を確認して旧予約を保持し、原因解消後に既存archiveを参照する新しい通常取込を予約する。
   このmanifestも`prepare`→`stage`で固定し、`start`は返却済みconfig/manifestで一度だけ実行する。`status`は元の入力又は確定入力のどちらでも
   同じoperationの保存結果を読み戻す。stageの応答喪失でも新operationへ迂回せず、固定markerとmanifestを回収する。
   `partial`又は`start_requested`は完了ではない。finished receiptがなければJob metadataと既知IDを照合し、再POSTしない。
   文献保存は500件ごとに分け、package全体は同一transactionを維持する。各SQL/COMMITにも共通期限を適用し、
   期限超過・中断時は残処理を停止する。確認済みcommitは保持し、ACK不明は照合対象として残す。
5. 固定URLの標準特許ウォッチ画面で最大5監視元の比較を準備し、statusでrun IDを読み戻す。
   台帳の残枠・費用・不明予約を確認してstartする。旧budgetProofだけでは新規開始できず、
   operatorが固定共通台帳の当月料金表から実行参照を作り、予約・開始権のACKを確認する。
   Job受理後の実行はクラウド内。PCやブラウザーを開き続ける必要はない。statusとstart-reconcileで完了を確認する。
6. 25日締めの対象期間を変えず、配布一覧・実取込・全文不足・補正・各runを照合する。
   訂正の元国内公開日が特定できない場合、WO番号の年を国内公開年の代用にしない。
7. 固定URLの案件→標準特許ウォッチで納品版を作成する。失敗時は同じ版の「保存結果を照合」を使う。
   書込開始の結果不明を再送しない。10分以上経過した未完成版だけ明示的に中断し、その後の版は別IDで作る。
8. PDF全頁・CSV全列・件数・期間・原文確認方法・説明末尾を確認する。現在の確認状態を取得して更新する場合は、
   更新前versionを照合する。応答不明・競合時は先に再取得する。旧納品版は不変で、反映は更新版として作る。
9. 運営者が手動メール納品する。不足時は保存版の連絡用文案を確認して手動使用する。自動送信は行わない。

### 1 packageの転送・中断再開

転送CLIはprivate stdin JSONだけを受け付ける。プロジェクト内のGit追跡外`_imports/.managed-transfer/current`が唯一の稼働slotを指し、
未解放のslotがあれば次packageのcopy/download割当を拒否する。既存のユーザー保存原本と通常の`_imports`原本は削除対象にしない。
ZIP自体は初めからtransferId固有ディレクトリへ置き、古い削除処理が次のZIPと同じパスを参照しない。
個人パス・取得元の認証情報はLocalだけで扱う。CLIのパス出力をGitHubや共用ログへ転記しない。

| command | inputと意味 |
|---|---|
| copy | `{sourcePath,byteLength,sha256,acquiredAt}`。既存原本を検証し、新しい専用ファイルへコピー |
| allocate-download | `{maxBytes,sourceIdentity:{packageType:"JPA",issueNumber,publicationDate,distributionTableSha256}}`。1 ZIPの正規手動取得先を割当 |
| complete-download | `{transferId,acquiredAt}`。正規ダウンロードの完了確認後にサイズ・SHA・所有記録を固定 |
| status | inputなし。同じslotのtransferIdと取得/所有記録を読戻し |

形式は`{command,input}`、statusだけ`{command:"status"}`。allocate-downloadが返すdestinationへ、正規認証済みの取得経路から
当該1 ZIPだけを保存する。割当自体は認証・取得成功の証明ではなく、実取得の完了と公式配布identityを別途照合する。
直接Azure取得は未実証の後続候補であり、このLocal転送経路の前提ではない。
copy中断は元入力へ同じ`transferId`を追加して再開する。記録済みinode・元原本SHA・既存prefixを照合し、未コピー部分だけ追記する。
別内容や所有不明ファイルは上書き・削除せず停止する。owner記録自体が確定していない中断は自動回収しない。

原本保存は`inputs/<sha>.zip`へのcreate-only書込と、ETag固定の全量streaming SHA/size読戻しで確認する。
検証中に2本目のLocal ZIPは作らない。号・公開日・配布一覧hash・取得日時・parse provenanceと検証日時を
create-only `archive-verified.json`、sealed manifest、処理receiptへ対応付ける。原本保存後もJob側は同じETag/hashを再検証する。
この経路は上書き・Blob削除を提供しない。Storage管理者に対するWORM保持policyが導入済みという意味ではない。

応答喪失時は最初に`status`を読戻す。未完のsealは元の有効な予約・同operation/intentで`reconcile-stage`を実行し、`sources:[]`とする。
予約ACKだけを失いstage=readyのままなら、同じ`stage`入力で最初のstage claim CASを一度だけ確定できる。
既にclaimed/doneなら新しい開始権は発行しない。別operationで同じ原本を再予約する方法は使わない。
ZIPの再uploadとJob startは行わず、確認済み保存物の不足markerだけをcreate-onlyで補う。既存receiptがあれば全量再読出しはしない。
全量検証には初回と明示的reconcile各1回のslotがあり、並行・再実行で増やさない。料金表は両方の最大読出しを含める。
Blob不在、検証失敗、両slot不明、期限切れは一時コピーと予約を保持して停止し、別UUIDで再送しない。

部分upload失敗について追加のOWNER承認が記録された場合だけ、Localの明示的な
`recover-archive-upload`で同operationのarchive-only単一原本を一度だけ再転送できる。
元のstage intent・予約・本番code SHAを保持し、`uploadRecovery`に別の`localCodeSha`、
`ownerApprovalSha256`、`priorFailureSha256`、`priorSenderTerminated:true`と非公開承認内の
`maxUploadElapsedMs`を渡す。実行adapterは承認原本と実際の失敗・終了証拠・対象原本を照合する。
通常stageの上限は変えず、復旧も元manifestの期限と全体上限内に収める。
確定Blob、seal、検証開始、Job開始がなく、元台帳の照合に成功した場合だけ、
create-only `upload-recovery-started.json`の成功ACKを得た呼出しが送信できる。
SDKは新しいblock IDで全量を送り、旧未commit blocksを再利用せず、条件付きcommit後に
ETag固定全量SHAを照合する。旧転送量・不明usage・予約をリセットしない。
復旧markerのACK不明、競合、再失敗は同じ全量再送を認めない。状態を読戻し、確定Blobがあれば
既存`reconcile-stage`で照合する。原本を分割せず、既存Blobの上書き・削除も行わない。

安全な部分再開が既に承認され、送信processの終了と同じ原本のSDK block一覧を確定できた場合、
`recover-archive-tail`で残部だけを送信できる。これは新しい送信時間枠を発行しない。
adapterは前回開始より前の時刻と終了確認後の時刻、その原証拠hashを照合し、区間全体を保守的に既使用時間へ計上する。
`tailRecovery`は元の承認hash・復旧marker hash・失敗/終了証拠hash・全block一覧hash・選択prefix・
元送信上限・開始/終了確認時刻を固定する。元markerの上限と一致し、残時間がある場合だけ、
create-only `upload-tail-started.json`へ既使用/残時間/固定deadlineを保存する。
選択したSDK prefixの連番と各8MiB blockを照合し、残部のみを同じSDKで送る。
全chunkと条件付きcommitは同じ残時間期限を使用する。commit一覧は選択prefixだけとし、
旧prefixを混ぜない。正常commitにより不要なuncommitted blocksはAzure側で破棄される。
前後の全block集合、Local原本、条件付きcommit、従来のETag固定全量SHAを照合してからsealする。
未知ACK、競合、再失敗では同tailを再送せず、確定状態を読戻す。予約・不明usage・旧失敗履歴は維持する。

元のarchive処理と予約が期限切れの場合、同一処理の有限期限更新がOWNERから明示承認されているときだけ、
Localの`renew-archive-expiry`を使う。`expiryRenewal`へLocal code SHA、OWNER承認/失敗確定証拠のhash、
元operation全体digestと承認内のwindowを渡す。現行policy・profile・月・未精算予約・元staging bindingを照合し、
固定名`archive-expiry-renewal.json`をcreate-onlyで作る。期限は実行直前のBlob trusted Dateから上限内とし、
元のmanifest・台帳・旧期限・予約値は変更しない。台帳schemaや旧本番の読み方も変えない。
ACK不明や同記録の存在を新しい期限発行へ使わず、同じ保存記録を読戻す。
以後は`renewalReference`のraw SHAとLocal code SHAを明示したtail/reconcileだけが新期限を利用できる。
Blob応答時刻が読み取り間で戻る場合も、発行時と読取時の期限を短い側に制限する。既存記録は
書き換えず、作成時刻窓と記録期限を照合したうえで`renewedAt + windowMs`までに限定する。
レビュー済みの修正buildで既存記録を使う場合は、`renewalReference.executionCodeSha`を明示する。
発行時の`localCodeSha`とraw SHAを保持し、実行SHAをtail入力と実buildの両方で照合する。
commit済みZIPの全量検証だけが通信中断した場合も、ZIPを再送しない。既存recovery検証markerの
作成から元の検証上限内であること、停止済みsenderと失敗証拠、marker原文/hashとETagを照合できれば、
`reconcile-stage`の`verificationContinuation`で同じ期限の残時間だけ検証できる。Local code SHA・
失敗hash・停止確認・marker hashを明示し、専用create-only markerで一度に限定する。
大容量streamの通信設定を短いserver timeoutで上書きせず、元の検証AbortSignalで全体を制限する。
既存検証枠で完了しない場合、期限経過だけを再実行の権限にしない。OWNERが承認した復旧範囲と
保持中の復旧予約へ追加通信の保守上界が収まることを非公開で確認できるときだけ、
`verificationRecovery`で追加の全量読出し1回を明示できる。承認/失敗確定証拠のhash・停止確認・
旧3markerのhash・Local code SHA・有限時間を指定し、manifestと有効期限内にseal用の余裕を残す。
旧markerは保持し、別のcreate-only markerでACK不明と重複を止める。通常の検証時間は変えない。
失敗読出しの未計測通信を0とせず全量上界で保持し、正式receiptがある場合は再読出しを省く。
送信残量は従来のtail証拠から差し引き、通常stage/start・別operation・新規予約へ更新期限を流用しない。
保存確定時も同記録と現在台帳を再照合し、従来CASでstage証跡だけを追加する。期限更新はJob起動や配備ではない。
旧期限を保った正式archiveは、従来の歴史receipt読取りにより後続の通常Jobと限定cleanupで利用できる。

`release-transfer`は保存済みarchive config/manifest・job・transferId・`sources:[]`をimport operatorへ渡す。

Localの同期ソフト等によるmetadata変更を検出した場合も、原因を推定して所有記録を書き換えない。
ctimeだけが異なるときは、独立レビュー済みの新Local buildから明示的な`reconcile-transfer`を使用できる。
歴史archiveのconfig/manifest・job・transferId・`sources:[]`に、
`transferRecovery: { localCodeSha, projectRoot }`を加え、Local build SHAと元の転送枠のproject rootを固定する。
新Local SHAと歴史archive SHAを区別し、本番App/Jobや旧build markerは変更しない。
台帳と非公開Azure原本の確定証跡を再照合し、元のinode・device・size・mtime・単一link・全量SHAが一致し、
検証中のctimeが不変の場合だけ追加証跡`metadata-reconciled.json`をcreate-onlyで保存して解放する。
owner/copied記録は不変。さらにmetadataが変わった場合、原本/台帳不一致、別inode、hardlink、
照合不能時は停止する。中断時は同じLocal SHA・同じ転送枠で結果照合し、新しい所有記録を作らない。
このLocal cleanupは配備・Job開始・新規の予算予約を行わない。必要なPRのmerge/deployは別途、既存の累計枠に従う。
期限後も歴史receiptと共通台帳のstage=doneを読戻し、固定slotの所有ID・inode・SHA一致を確認した1ファイルだけunlinkする。
小さい所有/削除記録はtransferId名で保持し、削除完了応答が失われても同IDを照合できる。新しいslotや既存原本へcleanupを広げない。

archive操作は共通台帳のpackages/bytesを1回、jobs/minutesを0として予約し、参照Jobはjobs1/minutes120・packages/bytes0とする。
`archivePackageYen`と`archiveGiBYen`の署名済み料金にはupload・最大2回の読戻し通信・metadata・必要保持を含め、
参照Jobの`importJobYen`にはJob読出し・parse・DB・ログを含める。料金未設定の旧policyを新経路へ暗黙適用しない。
既取得archiveは元台帳の容量・費用を残して再利用し、Jobごとに新規予約を行う。旧release archiveは同一service/targetのStandard運用でも参照できる。
CLI batchでは小さいZIPを既存batchへまとめられる。旧21 ZIP計画は今回の実行条件ではない。
画面経路はwatch 1回ごとにJobを開始するため、5対象2巡・無変更確認・復旧を含む実際の起動数を
累計24回以内で予約する。CLIの1 Job最大3 runsを画面経路の起動数へ流用しない。

Localの転送一時コピー解放は、Azure非公開正本のhash・size・source identity・処理receiptと対応付ける。
主要操作とクラウド構成は上記「リリース判定」で照合し、PC停止・別端末試験を追加しない。

## 終了・削除・復旧

終了時はsetting-saveで終了日とenabled=falseを記録し、期限までは固定URLの原本・納品物を保持する。
削除可能日は終了日+91日（JST）。原本は現在設定だけでなく過去runからも参照するため、通常の原本削除で迂回しない。
削除前にbackup-create→backup読戻し→backup-verify-restoreを行い、今回対象の一致を確認する。
バックアップは既存の最小権限で実行する。検索式・比較結果の2表には更新権限を追加せず、
親案件の行ロックで新規挿入を待機させて読み取る。他表の行ロック、案件・共通advisory lock、
READ COMMITTED、件数・容量・原本・hash検証は維持する。削除処理の全表ロックは変更しない。
放棄済み納品も履歴として保全し、元manifestにある未保存ファイルは欠落として明記する。保存済み納品・監視元原本の欠落は成功にしない。
復元時は現在・過去の監視元XMLと版・請求項全文の一致も再検証する。
復元先は既存Dockerの新規隔離PG16のみ。`WATCH_REPORT_LOCAL_DB_TEST=1`を明示し、汎用DB接続環境変数を渡さない。

deletion-previewの所属・期限・件数・完全な対象digestを確認し、同じID/digestでdeletion-executeする。
処理結果不明はdeletion-reconcileで同じ対象だけを確認し、DB不存在・Blob現在版不存在・prefix不存在・監査行保持を別々に確認する。
共通公報、他案件、費用台帳は消さない。Blob soft delete/versioningとPG自動backupの残存期限は実設定を記録する。
現行Blobの削除だけでbackup内も物理消去済みとは説明しない。復元した環境では、保持期限済み対象の削除監査を先に照合し再適用する。
全本番DBの災害復旧は、この対象限定の復元試験とは別である。

## 費用記録と通常運用の開始条件

各有料工程前の台帳には、operation、対象hash、事前予約、実消費、結果不明予約、残工程、保存/backup/転送/log、復旧予約を残す。
不明usageは最大予約を維持し、過去Issueの費用と基礎月額は分ける。正常終了のreceipt/usageがある分だけ精算する。
月額見積りは1社5監視元・月4〜5更新＋締めを維持し、実測token量・Job時間・DB/WAL・保管増分と公式単価で再計算する。
工程完了・請求API未取得を費用0の証拠にはしない。8割到達時は新しい保守見積りを固定してから続行する。

現時点のstart ledgerはリリース試験枠を永続累積する。これを月ごとに0へ戻して定例運用に使わない。
提供開始までに、少量packageによる本番経路の実測、標準運用の保守的な月額見積り・費用予約と、
試験台帳を保持した定例運用の契約を確定する。月間全量・全周期量の実処理は今回のGO条件にしない。
この確定、実際のOWNER認証、実AI2巡、固定Production URLの主要操作とLocal PC非依存、
費用・cleanupが未確認の間は本番GOではない。

### 共通予算のLocal実装状況

`managed-service-budget`と専用Blob adapterは、release累計と実処理JST月を分離する。
月額は基礎料金・残工程・保管・復旧と未精算額を合算し、watch/importの予約を同じpoolへ割り当てる。
stage/startは同じoperationを使用し、月替わり・profile改版・ACK喪失で予約を解放しない。
精算後に追加額が判明した場合も、再精算まで翌月へ保持する。

adapterは固定service prefix、HTTP Date、ETag条件付き単発書込を使い、通常の404を新しい空台帳にしない。
保存先は管理端末の信頼済み設定`MANAGED_BUDGET_STORAGE_ACCOUNT`、`MANAGED_BUDGET_CONTAINER`、
`MANAGED_BUDGET_TARGET_SHA256`で固定し、requestからは選ばない。既存Storage接続又は同じJobのMIを使う。
OWNER bindingと、既存user-assigned MIを使う場合の`MANAGED_BUDGET_IDENTITY_CLIENT_ID`も独立設定へ固定する。
予算のclaim ACKが不明な呼出元に開始権を返さず、受理済みworkerの読戻しは別処理とする。
workerの二重実行防止には既存のDB/receipt実行claimも必要である。

精算証拠は連番と最新64件のfingerprintを保持し、上限後の追加料金も記録して再確認を要求する。
古い証拠の再確認には、同じoperation/連番のimmutable原本を管理adapterで照合する。
署名が有効な期間に登録済みの原本は、Blobのcreation timeを確認して期限後も同じ精算を再開できる。
Last-Modifiedや端末時刻を登録時刻の代用にしない。原本登録/状態CASのACK不明は、先にread-onlyで照合する。

Local専用の`managed-budget-admin`はstdinの`command`と`evidenceDigest`だけを受け付ける。
`status`、`review-apply`/`review-reconcile`、`settlement-apply`/`settlement-reconcile`を提供し、金額・GO判定・
保存先・鍵を業務requestから受け付けない。build後の入口は`.koho-ops/managed/scripts/managed-budget-admin.js`。
statusの月/時刻は最後に記録された値であり、当月開始の許可ではない。

根拠は固定prefixの`evidence/<raw-bytes-sha256>.json`、精算reviewは`settlement-reviews/<review-digest>.json`、
管理reviewは`administration-reviews/<review-digest>.json`へcreate-onlyで保管する。各128KiB以下、根拠は最大16件。
reviewは対応するstrict schemaで正規化し、そのJSON SHA256の32bytesをEd25519で署名する。
schemaに従うreviewとbase64署名を持つenvelopeのJSON SHA256がreview-digestになる。
app/Jobに秘密署名鍵を渡さず、別のLocal管理・独立確認後にだけ署名を発行する。署名は実測や請求確定の代用ではない。
実行receipt/usageのoperation対応を確認し、金額未確定は部分観測だけにする。全9単位の最終量と費用が確認できるまで予約を保持する。

公開検証鍵は`MANAGED_BUDGET_REVIEW_PUBLIC_KEY`（Ed25519 SPKI/base64）、独立SHA256は
`MANAGED_BUDGET_REVIEW_KEY_SHA256`、OWNERは`MANAGED_BUDGET_OWNER_SHA256`で固定する。
標準profile有効化には、独立した本番受入後だけ設置する`MANAGED_BUDGET_PRODUCTION_GO_SHA256`も必要。
管理review内の自己申告GOだけでは有効化しない。実測/価格/GO根拠の各bytes hashとprofileの対応を照合する。

開設reviewだけがstateをcreate-onlyで作成でき、既存stateの初期化・置換はしない。
`opening-intent.json`→初期state→`opened.json`の順にcreate-onlyで確定し、開設完了markerがない台帳からの
業務開始を拒否する。開設途中の再開は署名済み初期stateの全体digestと一致する場合だけ。
開設済みmarkerがあるのにstateが失われた場合は復元を要する事故として停止し、古い開設reviewを再適用しない。
開設時は旧費用の不明予約と今回既実行分を別々に引き継ぎ、今回の予約をrelease累計から落とさない。
空の履歴配列を累計消費0の証拠にせず、同じcut-offまでの実行記録の完全性を確認する。
月額計画・profile改版は署名時のstate digest、連続sequence、直前review digestをCASで確認する。
競合した古い計画を再適用せず、現状を再確認して新reviewを作る。適用済みdigestは永続historyから照合し二重反映しない。
1200管理変更・768 operationを越える前に容量確認が必要で、履歴を削除して枠を再開しない。

証拠の収集・独立判定・署名発行とcreate-only配置は、Local管理手順で原本hash・対象・連番を照合して行う。
watch/import operatorとworkerには共通予算adapterを接続した。watchは共通予約→DB予約→submitting ACK→
共通start claim→ARM POST、importは共通予約→stage claim→保存済みmanifest照合→stage確認→start claim→ARM POSTの順。
新規startは当月planのraw pricing SHAと現profileを使い、受理済みworkerは元のimmutable policy/profileを検証する。
各phaseはBlob Dateで設定期限の必要残時間を確認し、workerも再確認する。statusは旧設定・旧期限の読取りを保持する。
旧設定に任意の初期値を補って新規startすることはない。Standardは別approvalと承認済みprofileを必須とし、
release累計を再開・リセットしない。JobのDB履歴は最大1000件、release上限はrelease行だけに適用し、
watch/import全体の費用・単位は共通台帳で制限する。DBの95分worker枠と共通台帳の120分Job枠を混同しない。

料金表は固定Job/environment、code/image、watch/importの異なるDB login・secretRef、AI、保存先、OWNERを結合する。
金額は料金表の保守的予約額とrun数/ZIP GiBから導出し、業務requestの自己申告額を採用しない。
料金表原文は署名済み月額計画へ含め、profileのpricing/measurement digestとも照合する。
納品・backup・restoreは、新規処理の前に共通台帳の予約とstart claimを同じCASで確定する。
CAS ACK不明・再送は実行許可にせず、定額予約を保持する。料金は既存の最大出力/読取量を含む保守額とし、
納品・backupはstorage、隔離復元はrecovery poolへ割り当てる。9実行単位をwatch/Job/ZIPとして加算しない。
料金表の`targets.artifactStorage`に実成果物の既存保存先を明示し、実clientのcontainer URLを完全一致で確認する。
watchの署名済み料金表には`watchAiRates.inputYenPerMillion`と`outputYenPerMillion`を、
対象deploymentの公式単価に税・余裕を含めて整数円へ切上げて固定する。業務requestから料金を指定しない。
workerは元operationのpricingから`watchRunYen`と単価を取得し、各runの送信予約transactionで
全dispatchの保守入力見積×入力単価＋最大出力×出力単価を累積照合する。予約円額を超える次送信は0、
runは未完了として停止する。既に精算できたusageやrun間の残額によって送信中の枠を復活させない。
41要求・入力150,000・出力8,192・実usage照合・期限・unknown保持は維持する。署名料金がないwatch開始/workerは拒否し、
import/archive/statusの旧policy読取りは維持する。`watchJobYen`にはJob/DB/Blob/ログ等の非AI費を含める。
これは請求遅延を含む厳密な請求上限保証ではない。低い予約で途中停止した試験は本番受入成功にしない。
共通台帳/取込containerへ成果物を移動しない。installed `MANAGED_ARTIFACT_APPROVAL`、実build SHA、watch DB targetを使い、
API/stdinから料金や保存先を指定しない。納品はAPIの90秒、backup/復元は管理入口の5分期限を予算IOにも引き継ぐ。
隔離復元はbackupIdと別のrecoveryOperationIdで、DB確定sha/bytesを拘束してから原本を読み戻す。
期限後は今回作成した隔離fixtureの有限cleanupのみを継続する。保存済みread/reconcileに新規予約や自動返金はない。
検証/配備は既存`managed-budget-admin`の署名済み`release-start` actionで予約する。
stdinは従来どおりreview digestだけであり、CLI引数から金額・対象・unitsを受け付けない。
専用の別release基盤やpublic CI向けの台帳資格情報は追加しない。

署名対象はIssue129/repository、具体trigger、PR/対象ref、対象branchのremoteBeforeSha、head/base/tree、
CI/deploy workflowの原文SHA256、pricing/preflightの原文digest、税込の保守的予約額である。
preflightにはその操作から起動するCI・既存preview候補・ACR build/push・app/Job更新・保持/復旧を漏れなく割り当てる。
validationは9単位0、forward/rollbackは対応する一方だけ1をコードで導出する。旧不明額・既消費単位を引き継ぐ。
review有効期間は最大15分。現state digest、連続admin sequence、当月pricing/policy期限と90分の処理余裕を照合し、
reserve＋start claim＋admin sequenceを一度のCASで保存する。新規成功ACKの`admitted`だけが開始根拠になる。
`already_applied`・reconcile・CAS ACK不明から開始権を復元しない。予約は残し、結果を先に照合する。

Local担当は`admitted`のexecuteBefore（Blob Date基準の最大60秒）より前に対象を再照合して固定操作を一度だけ行う。
PR push/作成/再開はCI等の起動前、main merge/dispatchは全配備triggerの起動前に予約する。
main CIとAzure deployは独立起動するため、main CI成功後に配備されるとは説明しない。
merge前にheadと統合treeの検証・独立review・必須CI・停止条件を確認する。expected-headはbaseのCASではないため、
base/対象ref/workflow/Job bindingが変わった場合は停止して再検証・新reviewを作る。auto-merge待機や自動rebaseはしない。
queued/running・結果不明の既存実行があれば新操作を止め、待ち行列を重ねない。
workflowのCI20分・deploy40分timeoutを予約へ織り込む。初回操作でも、実際のtrigger/refで実行されるworkflow原文を確認し、
未反映のtimeout変更を適用済みとして見積もらない。PR未作成branchのpushはPR番号・旧remote SHAのnullも署名し、PR作成とは別に予約する。
発火後は実行ID/attempt/SHA/開始時刻を照合し、
20分以内に開始しない実行は既知IDの取消・結果確認へ進む。自動rerunや別triggerへの迂回はせず、取消成功でも不明費用を0にしない。
これはLocalの実行手順による制御であり、キューや請求遅延を含む厳密な請求上限の機械保証ではない。

証拠収集/署名・create-only配置、予約枠、本番統合受入の実行状態はIssue #129の最新記録を正本とする。
詳細比較のAI出力には、根拠の請求項番号と原文どおりの短い引用だけを要求する。
位置は、その請求項または許可済み参照請求項内で引用が一度だけ一致するときにサーバーがUTF-16で計算する。
原文にない引用、複数箇所への一致、空白等の補正を要する引用、surrogateの分断は拒否する。
保存時の番号・組合せcoverage・位置・原文一致の検証は維持し、過去の保存結果を補正・上書きしない。
標準profileは、独立受入の根拠・通常月額計画・現行価格と数量を照合して有効化する。
設定切替とreadback、限定cleanupを終えた最終GOと、切替前の受入証拠を区別して記録する。

### 月次の有限枠と更新

月4〜5回の週次更新では、配布一覧と取得不足を確認する。ZIP本数と比較回数は実際の処理ごとに別計上する。
締め時の最大5監視元の比較、各ZIPの実圧縮bytes・Job数、納品版・backup・復旧・保持を別々に計上する。
通常profileは税込月30,000円以内と署名済み全9単位の上限を持ち、当月のrelease消費も含める。
1 ZIPは8GiB以下、Jobは120分/2vCPU/4GiB、各watchの全文・AI制限は上記のまま。
profile改版や月替わりで過去台帳、未精算額、不明usage、予約、原本を消さない。

料金表の有効期間は最大32日。開始時に有効な価格と当月planが必要で、月替わりだけでは開始できない。
通常更新は既存の管理CLIへ、現行target/build/image・実測/保守数量・未精算繰越・保存/復旧を含む
レビュー済みmonth/profile証拠を渡す。独立確認後に既存管理鍵で署名し、非公開原本のcreate-only配置と読戻し、
連続sequenceと現state digestのCASで反映する。期限切れのrelease枠を延長・復活させない。
未知のZIP量や新しい比較snapshotへ過去サンプルの費用・全量性能を保証しない。
当月残枠に収まらなければ新規有料処理を止め、不足表示と既存データの取得経路を保持する。
この定型管理に新Issue・新環境・新規開発を必須としない。個別の費用・数量原本は非公開の運用引継ぎに保持する。

Azure AIへの送信は必要な公開請求項に限定する。Microsoftの[データ保護説明](https://learn.microsoft.com/en-us/azure/foundry/responsible-ai/openai/data-privacy)に従い、
他顧客/基盤モデル学習への提供とは区別し、abuse monitoringやGlobal処理場所の条件も記録する。保持0を未確認のまま表示しない。
