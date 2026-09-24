# 標準特許ウォッチ運用

仕様・実行承認の正本は [Issue #129](https://github.com/hirokiriko/patentai-mini/issues/129)、
承認済みサービス契約は [親 #128](https://github.com/hirokiriko/patentai-mini/issues/128)。
本書は運用手順を記録する。実装中の手順を本番受入済みとは扱わない。

対象は1社・監視元最大5件の公開/登録済み日本特許、運営者はOWNER1名。
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

本リリース累計上限は架空case5、watch開始40、normal900/fast80、Job24実行/48時間、
package64/合計96GiB、forward deploy8/rollback2。1package8GiB、1Job120分/2vCPU/4GiB、
parallelism1/completionCount1/retry0。全文watchだけnormal41/fast0・30分、
1要求35秒・保守的入力見積normal150,000/fast50,000・出力8,192tokens。
結果不明のwrite/AI/Job startを再送せず、保存済み対応情報で照合する。

2026-09-23の追加承認は圧縮ZIPの各8GiB/累計96GiBだけ。旧pilotの各2GiBを変更しない。
managed取込は従来のparser上限を保持し、宣言展開総量16GiB、実読取展開総量8GiB、
1entry2GiB、directory128MiB/25万件、CSV128MiB/XML64MiBを超えれば未完了として停止する。
大きいZIPに連動して上限を緩めず、実RSS・一時disk・時間の適合も取得前/本番開始前に確認する。

契約中と終了後90日は顧客対応・設定・結果・納品物を保持する。期限プレビュー、
所属照合、明示実行、結果確認を行う。共通公報/他案件は削除しない。
バックアップの残存期間と復元後の削除再適用を記録する。復元試験は実際の
非公開保管経路から今回架空対象だけを隔離PG16へ行い、全体災害復旧とは区別する。

## リリース判定

必須test/CI、独立レビュー、情報保護、実DB/実AI、5対象・1周期量、新公報を挟む2巡、
無変更AI0、本番PDF/CSV全頁全文、実停止中PC_OFF、費用、限定cleanup、正式資材保持、
製品経路の架空サンプルと納品セットをすべて照合する。実行結果はIssue/PRと
非公開Local証跡に記録し、全成立時だけSTANDARD_MANAGED_WATCH_PRODUCTION_GOとする。

## 初回準備と標準コマンド

これはOWNERの管理手順であり、ブラウザーのログインcookieや資格情報をJSON・argvへ入れない。
対象resource、code SHA、app/Jobのimage digest、DB LOGIN、case allowlistを照合した非公開bindingを一度用意する。
秘密は既存OSストアから保護processの環境へ渡し、コマンド結果・JSONは追跡外の保護された場所だけに保存する。
以下のコマンドはrepository rootで実行し、JSONは標準入力へ渡す。実値をshell履歴やGitHubへ貼らない。

```text
pnpm install --frozen-lockfile
node scripts/build-managed-operators.mjs
node .koho-ops/managed/scripts/managed-base-preview.js
node .koho-ops/managed/scripts/managed-koho-preview.js
node .koho-ops/managed/scripts/managed-koho-operator.js
node .koho-ops/managed/scripts/managed-watch-operator.js
```

buildは未変更のレビュー済みcheckoutだけを受け付け、2つのworkerと管理入口をcompileして
`.managed-build-sha`を固定する。配備imageと異なるコードで新しいstage/startを行わない。
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
| backup-verify-restore | caseId, backupId。実保管bytesから今回対象だけ隔離PG16へ復元 |
| deletion-preview | caseId。削除予定graph・原本・納品物・backupを固定 |
| deletion-execute / deletion-reconcile | caseId, deletionId, manifestDigest。特定previewだけを実行/照合 |

比較の実行準備と納品版作成は固定Web画面を使い、候補選別・PDF/CSV生成・保存をAzure上で完結させる。
`delivery-reconcile`はcaseId/deliveryId/abandonPartialによる管理用照合だけを行い、再生成しない。

## 週次取得から納品まで

1. [JPO公報発行サイト](https://www.gazette.jpo.go.jp/)の正規配布一覧と利用条件・掲載保持期間を確認し、
   今回対象のJPAを手動取得する。取得日・公開日・号・サイズ・SHAを台帳へ記録。
   許可されたpackage/累計サイズを超えるものはpreview/uploadせず停止する。
2. `managed-koho-preview`へ `{schema:1,sourcePath,byteLength,sha256}` を渡し、元ファイルを変えず有限parseする。
   plan/Sources/Receiptのhash、A1/P1/A5/P5件数、未解析、補正の原番号/原日付欠落、展開量、時間・実測RSSを確認。未解析を0とみなさない。
3. import operatorへ `{schema:1,command,config,manifest,job,sources}` を渡す。
   configはSTANDARD_MANAGED_WATCH_RELEASE_V1、manifestは配布一覧hash・preview結果・8GiB以内の各package・
   6時間以内の期限・累計予約を固定。sourcesは各`sha256/path`。`stage`の返すETag付きconfig/manifestを保管する。
4. `start`は返却済みconfig/manifestで一度だけ実行する。`status`は元の入力又は確定入力のどちらでも
   同じoperationの保存結果を読み戻す。stageの応答喪失でも新operationへ迂回せず、固定markerとmanifestを回収する。
   `partial`又は`start_requested`は完了ではない。finished receiptがなければJob metadataと既知IDを照合し、再POSTしない。
   文献保存は500件ごとに分け、package全体は同一transactionを維持する。各SQL/COMMITにも共通期限を適用し、
   期限超過・中断時は残処理を停止する。確認済みcommitは保持し、ACK不明は照合対象として残す。
5. 固定URLの標準特許ウォッチ画面で最大5監視元の比較を準備し、statusでrun IDを読み戻す。
   台帳の残枠・費用・不明予約を含むbudgetProofを確認してstartする。
   Job受理後の実行はクラウド内。PCやブラウザーを開き続ける必要はない。statusとstart-reconcileで完了を確認する。
6. 25日締めの対象期間を変えず、配布一覧・実取込・全文不足・補正・各runを照合する。
   訂正の元国内公開日が特定できない場合、WO番号の年を国内公開年の代用にしない。
7. 固定URLの案件→標準特許ウォッチで納品版を作成する。失敗時は同じ版の「保存結果を照合」を使う。
   書込開始の結果不明を再送しない。10分以上経過した未完成版だけ明示的に中断し、その後の版は別IDで作る。
8. PDF全頁・CSV全列・件数・期間・原文確認方法・説明末尾を確認する。現在の確認状態を取得して更新する場合は、
   更新前versionを照合する。応答不明・競合時は先に再取得する。旧納品版は不変で、反映は更新版として作る。
9. 運営者が手動メール納品する。不足時は保存版の連絡用文案を確認して手動使用する。自動送信は行わない。

## 終了・削除・復旧

終了時はsetting-saveで終了日とenabled=falseを記録し、期限までは固定URLの原本・納品物を保持する。
削除可能日は終了日+91日（JST）。原本は現在設定だけでなく過去runからも参照するため、通常の原本削除で迂回しない。
削除前にbackup-create→backup読戻し→backup-verify-restoreを行い、今回対象の一致を確認する。
放棄済み納品も履歴として保全し、元manifestにある未保存ファイルは欠落として明記する。保存済み納品・監視元原本の欠落は成功にしない。
復元時は現在・過去の監視元XMLと版・請求項全文の一致も再検証する。
復元先は既存Dockerの新規隔離PG16のみ。`WATCH_REPORT_LOCAL_DB_TEST=1`を明示し、汎用DB接続環境変数を渡さない。

deletion-previewの所属・期限・件数・完全な対象digestを確認し、同じID/digestでdeletion-executeする。
処理結果不明はdeletion-reconcileで同じ対象だけを確認し、DB不存在・Blob現在版不存在・prefix不存在・監査行保持を別々に確認する。
共通公報、他案件、費用台帳は消さない。Blob soft delete/versioningとPG自動backupの残存期限は実設定を記録する。
現行Blobの削除だけでbackup内も物理消去済みとは説明しない。復元した環境では、保持期限済み対象の削除監査を先に照合し再適用する。
全本番DBの災害復旧は、この対象限定の復元試験とは別である。

## 費用記録と提供開始前の未確定事項

各有料工程前の台帳には、operation、対象hash、事前予約、実消費、結果不明予約、残工程、保存/backup/転送/log、復旧予約を残す。
不明usageは最大予約を維持し、過去Issueの費用と基礎月額は分ける。正常終了のreceipt/usageがある分だけ精算する。
月額見積りは1社5監視元・月4〜5更新＋締めを維持し、実測token量・Job時間・DB/WAL・保管増分と公式単価で再計算する。
工程完了・請求API未取得を費用0の証拠にはしない。8割到達時は新しい保守見積りを固定してから続行する。

現時点のstart ledgerはリリース試験枠を永続累積する。これを月ごとに0へ戻して定例運用に使わない。
提供開始までに、実測で成立する1周期の容量・費用予約と、試験台帳を保持した定例運用の契約を確定する。
この確定、実際のOWNER認証、全周期量、実AI2巡、PC_OFF、費用・cleanupが未確認の間は本番GOではない。

### 共通予算のLocal実装状況

`managed-service-budget`と専用Blob adapterは、release累計と実処理JST月を分離する。
月額は基礎料金・残工程・保管・復旧と未精算額を合算し、watch/importの予約を同じpoolへ割り当てる。
stage/startは同じoperationを使用し、月替わり・profile改版・ACK喪失で予約を解放しない。
精算後に追加額が判明した場合も、再精算まで翌月へ保持する。

adapterは固定service prefix、HTTP Date、ETag条件付き単発書込を使い、404を新しい空台帳にしない。
保存先は管理端末の信頼済み設定`MANAGED_BUDGET_STORAGE_ACCOUNT`、`MANAGED_BUDGET_CONTAINER`、
`MANAGED_BUDGET_TARGET_SHA256`で固定し、requestからは選ばない。既存Storage接続又は同じJobのMIを使う。
予算のclaim ACKが不明な呼出元に開始権を返さず、受理済みworkerの読戻しは別処理とする。
workerの二重実行防止には既存のDB/receipt実行claimも必要である。

精算証拠は連番と最新64件のfingerprintを保持し、上限後の追加料金も記録して再確認を要求する。
古い証拠の再確認には、同じoperation/連番のimmutable原本を管理adapterで照合する必要がある。
開設証拠、実usageによる精算、月額再見積とGO/価格/実測の独立pinを検証する管理入口は未接続。
現在のoperator/workerもこの共通予算adapterへ未接続であり、定例運用が成立したとは扱わない。
予約枠の確定・上記接続・実DB/SDK統合試験を終えるまで、標準profileの有効化は行わない。

Azure AIへの送信は必要な公開請求項に限定する。Microsoftの[データ保護説明](https://learn.microsoft.com/en-us/azure/foundry/responsible-ai/openai/data-privacy)に従い、
他顧客/基盤モデル学習への提供とは区別し、abuse monitoringやGlobal処理場所の条件も記録する。保持0を未確認のまま表示しない。
