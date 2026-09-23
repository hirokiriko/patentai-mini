# Issue #123: 限定クラウド取込と定例更新の運用手順

Issue #129の標準サービスへの拡張は `ops/standard-managed-watch.md` と最新Issue本文に従う。
以下は旧#123の試験枠の履歴であり、新しい枠の実行・費用・権限に流用しない。

この手順は [Issue #123](https://github.com/hirokiriko/patentai-mini/issues/123)
の `REGULAR_PRODUCTION_PILOT_V1` に限る。OWNERは資料準備から限定本番取込、
実AI監視、CSV・期間PDF、費用実測、回収までを承認している。通常工程ごとの
再承認は求めず、本文の範囲で同じLocal担当が続ける。本文が実行範囲の正本で、
本書は一般の本番権限や次回の実行許可を追加しない。

本書は運用契約と事前確認の手順である。文書作成、コード配備、Local試験の
成功から、予算成立、本番2巡、実AI、帳票、回収の成功を推定しない。実施時の
判定・対象code・日時はIssue/PRの公開可能な記録とprivateな実測証跡へ残す。

## 1. 実行境界

通常の `scripts/koho-manual-import.ts` はpreviewと専用loopback PG16へのapply
に限定したままにする。旧production scriptの固定入力・一回承認は流用せず、
public同期import APIも有効化しない。新入口は同repositoryの固定codeで既存の
parser、plan、immutable保存を呼び出す。画面・API・DB・保存・主要処理は既存
クラウド側で完結し、Local PCは準備と管理操作だけを担当する。

| 対象 | 今回の上限・条件 |
| --- | --- |
| 実行先 | 現行deployが指す既存Container Apps環境・DB・Storage・AI |
| Manual Job | 必要時だけ最大1件。2 vCPU/4GiB以下、parallelism=1、completionCount=1、replicaRetryLimit=0、1実行120分以下 |
| Job累計 | 初回・2回目・具体的修正後の予備を合わせ3実行、実稼働合計6時間以内 |
| 入力 | 原則JPAの異なる発行日2号。新規package最大4、各2GiB・合計4GiB以下、さらにparser・実資源容量以内 |
| 保管 | 既存Storage内にprivate container最大1件。入力・manifest・記録・成果物の30日保管費を予約 |
| AI | fast合計2送信、normal合計6送信。不明送信も消費。既存retry=0、35秒等のguardは維持 |
| 費用 | 今回増分の税込絶対上限10,000円。有料開始前に終了・復旧まで8,000円以内の見通し |

Jobを使ったpreviewも実行回数・稼働・費用へ数える。完成入力を切り捨てて
容量条件を満たしたことにしない。新environment/DB/server/storage account、
専用有料workload profile、公開ingress、scheduler、取得自動化は作らない。
取得済み資料、#121 checker、#108/#111の完成資料は有効範囲で再利用する。

## 2. 有料開始前の確認

1. 最新main、Issue本文、停止条件、並行writerを確認する。対象は既知の
   引継ぎと現行deploy metadataから特定し、名前の推測・全資源探索をしない。
   environment/DB/role/imageの対応は独立した管理metadataと実接続の両方で
   照合する。公開記録には対象一致の判定と日時だけを載せる。
2. 正規発行元の利用条件・発行表と保存済みZIPを照合する。不足する場合だけ
   正式リンクから上限内で取得する。原本は保持し、#121 checkerと既存preview
   で種別、日付・号の根拠、正確なbytes、内容hash、plan digest、保存件数、
   要確認、欠落を確定する。過去の取込済み号を新規2号の代わりにしない。
3. DBのTLS、PG16、primary、既存schema、最小権限、実使用量、backup保持、
   実行前の復旧点と既存復旧経路・権限を確認する。backup設定の存在と復元
   試験済みを区別する。不十分ならwriteを開始せず、独立したLocal作業を続ける。
4. 現在headのimage量、previewの保存対象量、DB容量・WAL/backup、ログ、通信、
   通常deployと必要な復旧、回収、30日保管を含めて費用を検算する。今回の
   確定額・未確定予約・残工程の予約と、過去分・通常基礎料金を別欄に保持する。
5. 同じ実装の架空入力・隔離PG16試験、必要checks、独立Localレビュー、公開
   情報の検査を完了する。PRは `Refs #123` とし、本番工程前に自動Closeしない。
   全必須CI・最新head・競合/未解決review・停止条件を確認してSquash Mergeし、
   通常deployと対象codeのreadyを確認する。その後も本番受入は未判定である。

### 保存容量とimageの根拠

`reservedGrowthBytes` はmanifest全体で累計消費する保存増分の予約で、現行
schema上限は1TiB（今回の実行値は実測から別途限定する）。packageごとに予約をリセットしない。ZIP容量からDB増加を
証明する値ではない。保存対象の直列化bytes、隔離DBでのtable/
index増加、WAL/backupの見通し、既存DBとserver storageの余裕を対応させる。
`pg_database_size` の差分は他の書込も含み得るうえ、server全体のWALやbackup
保管量ではない。これだけで費用・物理空き容量を確認済みにしない。

新規packageを保存する前に、実DB使用量と未消費の予約増分が許容容量へ収まることを
確認する。ACK済み保存後に容量超過を検出しても、既知のinsertedを未保存へ
書き換えない。後続保存を停止し、当該manifestだけを照合する。autogrowや
DBの増強・新設を暗黙の復旧手段にしない。

imageは現在headに対応する実build成果物で必要moduleと入口を確認し、容量を
測る。Local gzip量はregistry descriptorの実測とは区別し、metadata余裕と
保守係数を明記する。古いheadのimage量を現在headの証明にせず、同じlayerや
tagを二重に保存費へ数えない。deploy、復旧、Jobの各pullとplatform retryの
余裕を含める。maxReplicasは累積pull回数のハード上限ではない。

## 3. 最小権限とprivate設定

Job identityには既存ACRのAcrPullと、今回専用containerだけのBlob読書きを
付与する。account/subscription全体へ広げない。Job開始は既存OWNERの認可で
行い、一般利用者やCloud Codexへ委譲しない。既存アプリのidentity・secret・
認証・公開設定は変更しない。

DB LOGINは既存の適合するものを優先し、必要時だけ専用1件を用意する。
許可は対象DBのCONNECT、public schemaのUSAGE、`koho_import_runs` /
`koho_import_documents` のSELECT/INSERT、対応する2 sequenceのUSAGEだけ。
所有権、管理roleの継承、DDL、UPDATE/DELETE、共有PUBLIC ACL、既存LOGIN、
既存secret、schema/migrationは変更しない。既存保存契約が適合しなければ
原因を確認し、権限を追加して通さない。

管理用資格情報は既知のOS store/公式credential chainから保護process内で
取得する。管理者資格情報をJobへ渡さない。取込LOGINのsecretだけをJobの
secret/secretRefと既存認可済み保管機構で扱う。値をargv、shell history、
stdout/stderr、raw SDK例外、DOM/screenshot、GitHubへ出さない。

管理接続に必要な場合だけ、既にpublic accessが有効な対象DBへ、確認済みの
管理端末IPv4一つのruleを最大1件・最長6時間で用意できる。作成前に対象・
撤去権限・期限を確定し、管理処理後すぐ削除して不存在を確認する。既存rule、
public accessの状態、全Azure許可は変えない。このruleはJobの到達性を証明しない。

## 4. クラウド入口の契約

現時点の入口は `scripts/koho-cloud-import.ts`、schemaは
`src/lib/koho-import/cloud-config.ts`。実装中のschema変更は同じPRで本節へ
反映し、検証済みheadを実行時の正本とする。以下の記載だけでschemaの確定や
実imageでの実行成功を宣言しない。

公開可能なbuild commandは次のとおり。実設定をこのcommandへ追加しない。

```sh
pnpm exec tsc -p scripts/koho-cloud-import.tsconfig.json
```

Jobの固定commandは、compile出力の
`node .koho-ops/cloud/scripts/koho-cloud-import.js` を使う。追加argvは渡さない。
Dockerの通常default commandは既存web appのままで、Job templateだけを限定
設定する。imageはレビュー済みmainのSHA/digestへ固定し、業務入力からimageや
commandをoverrideしない。web appのdeployだけではJob imageは更新されない。

| private設定名 | 契約 |
| --- | --- |
| `KOHO_CLOUD_CONFIG_JSON` | 承認文字列、operation、mode、対象binding、Storage、manifestのbytes/hash/ETagを持つJSON。接続passwordは含めない |
| `KOHO_CLOUD_DATABASE_PASSWORD` | apply用の専用取込LOGIN password。Job secretRef経由のみ |

汎用 `DATABASE_URL` / `PG*` / AI設定をこの入口の入力として使わない。
configには `approval`、`operationId`、`mode`、`storageAccount`、`container`、
任意の `managedIdentityClientId`、`expectedCodeSha`、
`expectedEnvironmentResourceId`、`expectedTarget`、`manifest` を持たせる。
接続先やresource bindingはsecretそのものではなくてもprivateな運用情報であり、
公開JSON例に実値を入れない。

manifestはconfigから導かれる固定Blob名だけを使い、任意URL/他container/
Local pathを受け取らない。内容は次の対応を固定する。

- schema version、承認文字列、operation ID、preview/apply、codeとenvironment/
  DB/roleのbinding、round 1/2、期限。
- 合計入力bytes、DB許容容量、予約増分、処理時間、要確認保存の可否。
- 各packageの種別、bytes/hash/ETag、previewのplan digest/件数/要確認、
  期待inserted/reused、発行日・号、発行表との対応根拠。

現行schemaのmanifest期限は開始時点から最大6時間、処理予算は最大115分、
入口watchdogとJob timeoutは120分以内。これは各操作の期限で、Local編集や
安全なreadを含む全作業へ新しい短時間締切を設けるものではない。

Blobのprivate状態とmanifestのbytes/hash/ETagを確認し、排他的なクラウド内
作業copyへstreamする。sourceのETag/size/hash、parser/plan、原本再hashと
発行日を照合してから、TLSと対象DB/role/schema/容量を検査する。package単位
の既存immutable transactionを使い、同bytesの再利用は計画全項目の一致で
決める。全batch transactionや既存rowの上書きは追加しない。

## 5. 2巡の実行と結果不明の扱い

1巡目は承認manifestの第1号を保存する。2巡目は同じ第1号と新しい第2号を
対象にし、第1号のreused・row/更新時刻不変と第2号のinsertedを限定DB照合で
確認する。import自体でwatch cursorが進まないことも確認する。

operationごとのprivate記録は、開始marker、順序付きreceipt、終了記録を
別に持つ。開始marker作成のACK不明、二重開始、receipt保存のACK不明を自動
retryしない。同じoperationを安易に新IDで再送せず、既知operation/inputへ
限定した照合で最後の確定stepを見つける。

次の三つを独立に確認する。

| 証拠 | 確認できること・限界 |
| --- | --- |
| private receipt/終了記録の永続化ACK | 当該operationの記録保存。DBの現在状態やJob終了は別 |
| 対応する実Job executionの終了状態 | 当該実行の終了。SucceededだけではDB保存の証明にならない |
| manifestに限定したDB照合 | 現在の対象保存結果・既存row不変。実行当時のACKを後から捏造しない |

preview_not_saved、inserted、reused、review_not_saved、failed_before_save、
save_outcome_unknown、not_processedを混同しない。ACK済み保存後のreceipt/
cleanup失敗は既知の保存結果を消さず、全体を要照合のまま止める。v1 receipt
や終了footerを本番証明へ昇格しない。公開stdoutは固定codeと集計だけにする。

現行入口のexit 0は対象処理・終了記録ACK・作業copy回収の完了、exit 2は
要照合を示す。exit 0でも実Jobとの対応、現在DB、AI/帳票、費用、Issueの受入
全体が確認済みにはならない。readは個別timeoutを持たせ、同じ論理readは最大
3試行。400は原因修正後、429は待機指示に従い、401/403/MFAを反復しない。

## 6. 同じ架空案件の実AIと帳票

完全架空案件1件・TXT1件を通常UI/APIで作り、保存往復を確認して抽出を1回
実行する。公開公報を参考にした内容ならその事実を残す。実顧客情報は使わず、
全案件一覧を取らず今回IDへ直接進む。

1巡目取込後と2巡目取込後に、同じ案件で実AI監視を行う。成功時だけ既存仕様
どおりcursorが進むことを確認する。少なくとも一方のrunで候補ありを確認し、
上位最大3件の説明・書誌・原文上の構成を照合する。確認状態を変更して再読込
し、2回目が正常0候補ならそのまま記録する。入力・閾値・モデル・プロンプトを
変えて候補や成功を作らない。自己文献の検出と未知候補への有用性は区別する。

完了runのCSVと、当日を含む監視実行日JSTの期間レポートを本番から取得する。
ブラウザー印刷PDFを別rendererで全ページ確認し、画面・CSV・PDFの件数、
番号、注意文、確認状態を照合する。公報発行範囲と監視runの集計期間は別に
記録する。取得不足、説明根拠不足、請求項/明細書の混同を省かない。

各AI操作前に、その操作で起こり得る連続送信をまとめて予約する。送信数は
request/case/processを変えても累計し、usage不明、timeout、保護停止の予約を
解放しない。後続有料送信を止め、未送信/未commitと確定した範囲だけを具体的
修正後の残枠で扱う。通常のhelper/配線不備は同じ担当で修正・関係testを行う。

## 7. 費用台帳と参考算定

2026-09-21の公式小売単価に基づく検討例。円参考値159.32円/USDに税1.10と
余裕1.05を掛けると184.0146円/USDとなる。実対象・モデル・地域・価格と数量を
有料開始前に照合する。値は請求確定額でも成立済み予算でもない。

| 費目 | 検討数量・条件 | 税・余裕込み予約例 |
| --- | --- | ---: |
| AI | gpt-5.4 normal6、mini fast2、context全量をinputとし各output8192、cached割引なし | 6,124円 |
| Job | 2vCPU/4GiB、3実行合計6h、無料枠控除なし | 239円 |
| image通信 | 現在headの保守容量0.54GB以下、24 full pulls、高い0.181USD/GB | 432円 |
| image保存 | 最大2GB・30日、保守単価0.125USD/GB月 | 47円 |
| app増分 | 0.5vCPU/1GiB、旧新revision等を合算24 replica-hours、active単価 | 239円 |
| WAL/backup増分 | 根拠を確認した8GiB以下を30日全量課金、0.095USD/GB月 | 151円 |
| 追加ログ・保持 | 100MB投入と30日有料保持も予約 | 65円 |
| private Blob | input/receipt/成果物等を合計8GiB・30日 | 32円 |
| Blob操作・HTTP | 10,000 write/listとread/otherの余裕、外部HTTP10,000件 | 11円 |
| その他outbound | 管理応答・成果物回収等を1GB、高い通信単価 | 34円 |
| 復旧遅延 | 上記工程以外の追加約50 replica-hours相当を含む予備 | 500円 |
| **合計** | **各数量の根拠確認が成立条件** | **7,874円** |

normalはinput 5/output 22.5USD per 1Mの長文単価でcontext1,050,000、miniは
0.75/4.5でcontext400,000を予約した例である。既存guardのUTF-8 bytes見積を
厳密token上限と読み替えて予約を減らさない。実deploymentが異なる場合は
適用価格・contextで計算し直す。同一region内のAzureサービス間転送は無料
単価の条件を確認した場合だけ0とし、Internet outboundへ二重計上しない。

この表のimage量、DB増分、ログ量等を実測なしに採用して8,000円以内と判定
しない。各処理後に数量・usage・残工程を照合し、不明値は未確定のまま予約を
維持する。上限へ接近したら後続有料操作を止め、承認範囲の安全な終了を優先
する。過去予約を取り消したり今回枠へ付け替えたりしない。30日後も保持する
ものは月額見通しと管理者を残し、30日を自動削除期限にはしない。

既存DB/常駐app/ACR等の基礎料金は別欄で報告する。基礎料金を今回増分へ
重複加算せず、作業を止めたことを基礎料金0円とは報告しない。PITRは新server
を作るため今回の通常復旧費へ暗黙に含めない。追加DB・全体restoreが必要に
なった場合は、対象・影響・費用を具体化して本文外の操作として扱う。

公式根拠: [Retail Prices API](https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices)、
[ACA課金](https://learn.microsoft.com/en-us/azure/container-apps/billing)、
[帯域料金](https://azure.microsoft.com/en-us/pricing/details/bandwidth/)、
[PostgreSQL backup/restore](https://learn.microsoft.com/en-us/azure/postgresql/backup-restore/concepts-backup-restore)、
[GitHub Actions課金](https://docs.github.com/en/billing/concepts/product-billing/github-actions)。
public repositoryの標準runner計算料とAzureの保存・転送・実行料は分ける。

## 8. 終了・回収・受入

Job startの受付確定後にLocal操作clientを閉じ、クラウド側が終了記録とDB結果
を残すことを実測する。受付前upload中断と受付後処理を分ける。この確認は
物理PC電源断ではない。許可済み独立端末で実測できなければ `PC_OFF=NOT_RUN`
を残し、無断shutdownや他作業の停止はしない。

帳票取得後、今回の架空案件と添付だけをID/マーカー/所属で照合し、既存削除
APIで回収する。結果不明時のBlob照合は作成時に確定したobjectだけに限る。
今回の一時IP rule、作業copy、不要なcredential/processを回収し、不存在を
確認する。既存案件・公報全体の探索や削除をしない。

成功した公開公報、原本、manifest、終了記録、成果物は保持する。新設Job、
private container、最小権限は次回手動更新用に維持し、scheduled/event trigger
なし・実行中Job0で終える。保持と不要物の回収を区別し、次月の実行は今回の
承認だけで始めない。失敗時は今回所有と確認できた不要物だけを安全に回収する。

通常rollbackはrevert PR/通常deploy、Job停止、今回対象の権限・設定復元。
保存済み公報の全表DELETE、DB初期化、無断backup復元は行わない。不明write、
対象不一致、予算/容量不足、秘密露出、実権限/MFA不足、本文外変更が残る場合は
最後の確定stepと必要な人の操作1件を示す。通常の修正可能な不備を再承認待ちへ
戻さず、動いていない処理を背景実行中と表現しない。

`PRODUCTION_REGULAR_UPDATE_PILOT_ACCEPTED` は、本番insert→reuse＋insert、
既存row不変、同じ架空案件の実AI監視2回と候補あり、書誌/原文/確認状態、実CSV/
全ページPDF、client切断後の継続、費用・回収・独立レビュー・親#94への引継ぎ
がすべて実測で成立した場合だけ記録する。未実施はNOT_RUN、不成立はFAIL/
BLOCKEDとし、途中のmergeやLocal試験だけでIssueをCloseしない。

準備・操作・待機・手戻り・費用・必要な手作業は実測で記録し、#111の確認票/
ガイドへ別版で反映する。専門家評価欄は本人の評価まで空欄にする。専門家受入、
実顧客情報保護・顧客分離、全期間網羅、物理PC停止、商用提供の可否は別判定で
親#94へ残す。本番未確認を本書やLocal試験で置き換えない。

## 9. Issue #123 V3の限定継続

上記のV1実施枠と履歴は保持する。以後の限定継続は、更新済みIssue #123の
`PRODUCTION_FINISH_BATCH_V3` 本文と既受領Local承認を照合して実施する。
同じ承認を工程ごとに取り直さず、旧予約・失敗/不明送信・Job消費を引き継ぐ。

過去の請求照合と残工程の開始判断を分ける。請求API404や反映待ちは未確定を
保持し、既存証拠・適用する公式無料条件/単価・根拠付き保守数量で見通しを
算定する。cache、preview、転送、並存revision、ログ、30日保管、回収、復旧を
省略しない。独立Local検算が成立すれば請求画面の手動準備を待たず継続する。
費用詳細はLocalで管理し、公開できないこと自体を工程停止条件にしない。

PRの対象head/レビュー/CI/停止条件を確認して通常反映し、同一の新架空案件で
保存済み公報の実AI監視、実結果に基づく新規なし確認、書誌/確認状態、CSVと
実browser期間PDF、限定回収まで同じ担当が進める。旧2号の取込やJobを再実行
しない。新たな保護停止では診断を保全し、具体的欠陥が再現/修正できた場合
だけ本文の予備枠を使用する。原因不明や単なる遅延で同条件を再送しない。

全条件成立時の今回判定は `PRODUCTION_LIMITED_REPORT_FLOW_GO`。元の更新間
監視、専門家評価、顧客利用、期間網羅、PC_OFFは別の未達として親#94へ残す。
本書の手順整合やLocal成功を、本番の実績へ読み替えない。
