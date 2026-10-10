# Issue #148: OWNER限定試用

正式仕様・承認値は [Issue #148](https://github.com/hirokiriko/patentai-mini/issues/148) と最新Lead続行記録を正本とする。Local sole writer、同じDraft PR #149。OWNER本人のみ、第三者招待なし、本番変更・mainマージ・本番配備なし。

## 提供状態と再開点

費用台帳・Job・MI認証・用途別Storage・画面接続・Local operatorを実装した。**専用環境は未構築・未配備で、TRIAL_GROUP_ACCEPTANCE_GOではない。** 実AI、実画面、実PDF/CSV、実費、本番非影響の実測は別途必要。

2026-10-10 09:35 JSTの既存経路preflightは対象・credential host・DNS照合成功、TCP有限1回timeout、TLS/SQL未到達。10:57 JSTの限定metadata照合では、既存記録間の固定対象一致、server Ready・既存public access、DNS global IPv4を確認した。独立した2つの送信元確認が一致し、そのIPv4は既存2ルールの範囲外だった。新たなTCP/SQL試行・ネットワーク変更・資源変更は0。認証失敗とは扱わない。

DB待ち中にも残実装・Local検証・独立レビュー・CIを進める。追加承認は「既存public serverに、確認済み現在IPv4だけの一時ルールを最大6時間追加し、承認済み作業後に同ルールを撤去・不在確認」の1件へ具体化する。実target/IP/rule識別はOWNER限定Local対応表に保持する。承認がない間は作成しない。既承認事項の再承認や#147の再調査は不要。

## 実装境界

- Ed25519署名policyがtenant/OWNER/audience/origin、DB/roles、Storage3用途、Web/worker別MI、AI deployment、Job/environment、code SHA/image digest、公開sample/期間を固定。HTTP入力で接続先を選ばない。
- 正式期間は2026-10-17 09:00以上〜2026-10-31 09:00未満JST。初期実機policyは最大30分。終了後の業務API/帳票取得は拒否し、データなしの終了案内を出す。既取得データの回収は保証しない。
- 案件はsampleを含む最大5件、title入力のみ。managed比較は署名sample限定・固定公開期間。持込draftのmini抽出とsample比較を分ける。原本/抽出結果、比較履歴、固定納品版、根拠、現在の確認状態を画面に接続する。
- Web pool2＋専用処理1＋worker1。TLS検証、statement30秒/lock5秒/idle-in-transaction30秒。専用DB基準サイズ＋256MiBを検査し、増分の永続予約は192MiBまでに抑えてページ等の余裕を残す。
- trial-v1/state.json は専用budget containerの単一ETag台帳。欠落・競合・不明ACKは停止、書込再試行なし。phase/月/code更新で作り直さない。過去の料金とimageを予約に固定し、非AI費用の累積・月別下限とDB基準値を保持する。
- 初期normal24/mini12/Jobs12/6時間、試用normal12/mini12/Jobs12/3時間、累計36/24/24/9時間。比較1回normal最大3（screening1＋detail最大2）。必要chunkや選別結果を切り捨てて成功にしない。mini1回、比較15分、Job30分。未知結果は予約保持・再送禁止。
- signed costは確認から最大24時間。有料開始は初期見通し4,500円以下、通常月1,800円未満、試用/保管累計9,000円未満、初期込み15,000円以下、既存全体枠の残りも満たす。承認上限5,000円/10,000円へ近づける増枠はしない。請求取得不明は0扱いしない。
- JobはManual・2CPU/4Gi・parallelism1・retry0。台帳で複数execution間も同時1。固定template読取→CAS予約→一度だけstart→worker CAS→DB claim→各AI予約→usage/結果保存→ARM終端GET照合。正常比較後もJob終了照合まで次Jobを止め、完了/失敗履歴にも照合ボタンを残す。
- AIは別MI＋Cognitive Services audience、固定URL/model、既存SDK。API key/fallback不可。MI待機後の送信直前にも署名・期限確認。送信済みusage/結果は終了後も確定できるが、新規送信は禁止。
- originals/artifacts/budgetは異なるprivate container。account key/SAS/作成や削除のHTTP経路なし。SDKの最終HTTP adapterで認証後の送信を再検査。budgetの既存予約精算は期限後PUT可。原本は実bytes、納品版全3点は48MiBを保存前予約し、不明uploadを新keyで再送しない。
- 公開packageは累計2件/入力2GiBを台帳で制限する。この最小実装は**1つ32MiBまでの完全なJPA ZIP**、展開32MiB、DB用plan/claims/receipt合計16MiBまで。大きいpackageを切り取って正規receiptと偽らず、保存前に拒否する。

## Local operator

pnpm exec tsc -p scripts/managed-watch-cloud.tsconfig.json で .koho-ops/managed/scripts/trial-operator.js とworkerを作る。引数なし、stdinの保護JSONだけを受け、stdoutはOWNER限定ファイルへ保存する。秘密や実policyをargv、shell展開、GitHub、ログへ出さない。

入力は { environment, databaseUrl, request }。environmentは DEPLOYMENT_KIND と TRIAL_POLICY_JSON / SIGNATURE / PUBLIC_KEY の4項目のみ。databaseUrlは固定T-DB/migrator。管理credentialをApp/Jobへ渡さない。.managed-build-sha は検証対象commit、policy.imageはそのACR digestと一致させる。

| request.command | 操作と確定条件 |
| --- | --- |
| initialize-ledger | budget private確認、If-None-Match:*で初回1回だけ作成・再読取。既存を置換しない。 |
| package-preview | sourcePath/sha256の完全packageをLocal検証。DB/Storage接続なし。 |
| package-import | 同入力を台帳予約、originals保存、公報/claims/receiptをT-DBへatomic insert、全field readbackで確定。 |
| package-reconcile | 同source/plan/claims/receiptとBlob SHAをGET/read-only transactionで照合。欠損sidecarを補完せず、未知の再writeなし。 |
| sample-save | caseIdと公開XMLのpath/hash/出版情報を検証し原本と監視元を保存。返したdocumentId/source/baseは保護記録へ。 |
| setting-save | sampleの固定期間とsource原本を照合し設定保存。試用者HTTPからの変更不可。 |
| status | caseIdのrun/納品/台帳revisionを読取。 |
| job-reconcile | caseId/runIdの既存予約を固定JobのGETだけで照合、終端秒数・DB状態を精算。期限後可。 |
| delivery-reconcile | caseId/deliveryIdの3成果物を検証。abandonPartialはLocal運営者のみ。旧原本/予約を保持。期限後も既存結果照合可。 |

未知のsample/setting保存は新IDでやり直さず、同原本SHA・DB行・Blobキー・台帳をLocalで照合する。照合できない予約は残す。既承認公開資料だけを用意し、架空fixtureを実受入の公報に読み替えない。

## 配備手順

1. 必要な追加ネットワーク承認後、固定server/現在IPv4/既存rule不変を再確認。一時rule作成は1回、結果不明ならGET照合し再作成しない。最大6時間以内、作業finallyで同rule削除・不在・非対象不変を確認。
2. 有限TLS管理接続でcatalog-only監査。PG16/B1ms32GB、既存DB/role/ACL、T名未使用・他DB隔離可能性を確認。既存業務行/dumpを読まない。PUBLIC権限等で既存DB変更が必要なら勝手に変更しない。
3. T-DB・NOLOGIN owner・migrator・Web/worker LOGINを作り、T内だけで既存migrationを適用。Web/workerはNOSUPERUSER/NOCREATEDB/NOCREATEROLE/NOREPLICATION/NOBYPASSRLS、owner membershipなし。migrator接続先もT-DB限定。schema/table/column/sequence ACLを最小化する。
4. Webにはcases/draftsの許可操作とmanaged prepare/review/delivery、workerにはmanaged run/dispatch/finding保存と必要SELECTのみ。公報/claims/receiptはWeb/worker読取のみ、sample/設定投入はmigrator Localのみ。他DB接続・他schema・DDL・role変更・DELETEの拒否を各LOGINで負試験。最大接続4と各timeoutを再取得。
5. 既存Storage内にprivate3用途container新設。用途scopeの別MI/RBACをWeb/workerへ付与。Webはoriginals/artifacts/budget読書、workerは必要originals読取＋budget読書。container/account管理・削除・account key取得なし。AIは固定resourceの呼出権限、Job start/readは固定T-Job scope限定。別account/環境を作らない。
6. OWNER限定Entra appを単一tenant/単一OWNERへ固定。未認証・別tenant/OWNER・偽principal負試験を準備。Webは既存P-ENV Consumption、0.5CPU/1Gi、single revision、min0/max1、ingress認証必須。Web/workerのDB passwordは別secretRef、本番OWNER/key設定を混在させない。
7. exact PR headのLocal checks・独立レビュー・CI成功後、docker build --build-arg MANAGED_BUILD_SHA=<verified-sha> で作る。既存ACRへ送りdigestをpolicy/Web/Jobへ固定。main/本番workflowは使わない。forward最大3・rollback最大1を保護記録に数える。JobはManual2CPU/4Gi/1800秒/retry0/parallel1、固定worker commandと環境7項目。起動payloadだけTRIAL_EXECUTION_JSON追加。
8. 当日料金・共有費用残枠・未知予約・保存費見通しを確認したcostとDB初期サイズを署名policyに記録。最大30分initial窓を選び、image/identity/secretRef/config/署名を双方で再取得。root ledger初期化、sampleを含む5案件以内で公開入力投入。起動前に期限制御確認。
9. OWNERログイン→cold start→sample→比較準備/開始→normal最大3→終端照合→根拠/確認状態→PDF全ページ/CSV全行→保存版再表示/原本取得を実測。別途draftのmini1回を確認。保護Localに記録し、公開するのは成否/件数/一般化した理由だけ。
10. 終了直前の認証待機と新規AI/Storage/Job送信0、送信済み精算、期限後API/PDF/CSV拒否を実測。正式窓へ戻した署名設定を再取得し、履歴/予約は保持。phase変更前のJobも終端照合。
11. Azure見込/実費/請求遅延/unknown/残枠、共有資源サイズ・本番設定不変、一時rule不在を確認。利用案内をOWNERへ渡す。全受入成立時だけGO。原本・成果物・台帳・URL保持、2027-01-29 09:00 JSTに保管見直し。自動削除なし。

## 検証と利用案内

Local: pnpm lint、pnpm type-check、pnpm exec tsc -p scripts/managed-watch-cloud.tsconfig.json、pnpm exec vitest run --maxWorkers=2、pnpm build、diff/公開情報検査。CIは通常checksにworker/operator compileを追加し、別jobで架空専用PG16のtrial/managed保存・権限回帰を実行する。実DB接続をCIへ渡さない。Local Docker未稼働ならskipを明記しCI結果と区別する。

提供時はOWNERへ専用URL、正式開始/終了JST、sample公開期間、案件上限、抽出と比較の違い、比較後の「状態を確認」、未完了/結果不明時の再送禁止、PDF/CSV固定版と現在の確認状態の違い、費用残枠、保管見直し日を伝える。新規有料操作はsigned cost有効期間内だけ。期限切れはLocal運営者が実費/未知予約を確認して更新し、自動増枠・自動再送しない。

rollbackはT-App/T-Jobのみ、既知の同SHA/image/policy組へ戻す。台帳/DB/Blobを削除・初期化しない。旧imageの未終端Jobは予約時imageで照合。未配備時点ではクラウドrollback不要。
