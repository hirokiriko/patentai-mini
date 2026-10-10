# Issue #148: OWNER限定試用の実装・停止記録

正式仕様・数量・費用・操作範囲は [Issue #148](https://github.com/hirokiriko/patentai-mini/issues/148) の承認済み本文を正本とする。試用対象はOWNER本人のみ。別ユーザーの招待、mainへのマージ、本番変更・本番配備は含まない。

## 現在の提供状態

この差分は認証・期限・機能scopeの基盤であり、未配備。**試用開始可能ではなく、TRIAL_GROUP_ACCEPTANCE_GOではない。** 試用専用の永続費用台帳、Job契約、用途別Storage、実機受入は未完成。旧production経路で代用しないため、trialではAI、fallback抽出、旧Job起動、旧worker、account-keyによる原本・成果物・予算台帳の入口を明示拒否する。

2026-10-10 09:35 JSTの許可内preflightでは、既存の正規Azure認証、固定対象metadata、管理credentialとのhost照合、DNSが成功した。既存経路のTCP接続は1回の有限試行でtimeout。TLS・SQL・catalog監査には到達していない。firewall、共有ネットワーク、DB、Azure資源への変更、実AI実行は0。原因をfirewallや認証エラーと断定しない。

## 実装済みの境界

- `DEPLOYMENT_KIND=trial` とEd25519署名済みpolicyを必須化。試用を示す部分設定や未知のmodeは拒否し、本番OWNER設定・API key・Storage account key・有料OCR設定との混在も拒否する。
- policyは専用tenant/OWNER/audience/origin、DB/LOGIN、3つの異なるcontainer、Web/worker別identity、AI resource/deployment/version、Job/environment、公開サンプル案件と対象公開期間を固定する。requestのgroupId等で接続先を切り替えない。秘密鍵・署名済み実policy・接続情報はLocalの保護対応表で保持する。
- 正式期間は2026-10-17 09:00以上〜2026-10-31 09:00未満（JST）。初期検証policyは最大30分。期限後は業務API・帳票取得を拒否し、許可ページにデータなしの終了案内を表示する。取得済みデータの回収は保証しない。
- proxyと各route/pageで認証・期限・機能を確認する。未分類のroute/method、管理画面、旧同期AI、削除、設定変更を拒否する。managed機能は署名されたsample案件のみ。案件入力はtitleのみ、案件作成上限5件はDB transactionとadvisory lockで確認する。
- 試用DB接続は固定host/DB/LOGIN、TLS検証、Web pool最大2、専用処理接続最大1に限定する。healthは新しいDB接続を作らない。worker接続1・合計4の実機確認は未実施。
- 試用AI transportはACAのloopback MI endpointだけを利用し、Web/worker別client_idとCognitive Services audienceを確認する。既存SDKの空api-key headerを削除し、固定したURL/modelにのみBearerを送る。トークン待機後に署名・期限を再確認する。transport単体の架空試験は実AI受入とは別。
- 比較画面の公開期間を運営者のsample設定に固定し、試用者による部分保存中断確定を表示しない。保存版の根拠表示と現在の確認状態は既存仕様を保持する。

## 再開と残工程

最初に、既存正規経路からP-DBSERVERへ接続できる状態を確認する。現在の承認は共有firewall/network変更を含まない。接続経路が不成立のまま管理credentialをApp/Jobへ渡したり、新しい接続経路を作ったりしない。既承認事項の再承認や#147の再調査は不要。

接続成立後は同じIssue・branch・Local sole writerで以下を続行する。補助レビューはread-only。

1. catalog-only監査とT-DB限定権限試験。T-DB、NOLOGIN owner、migrator、Web/worker LOGIN、private container3、専用identity/認証を承認対象へ固定する。本番業務行・dumpは取得しない。
2. trial専用の署名費用profile、永続ETag台帳、unknown予約、mini抽出、3-call比較、Job admission/dispatch/worker/精算、保存量制限を実装・検証する。既存台帳を転用せず、月やphaseの切替で予約・回数をリセットしない。
3. 初期上限5,000円・開始見通し4,500円以下、通常目標2,000円/月・新規有料停止見通し1,800円、試用/保管の月かつ累計10,000円・停止見通し9,000円、初期込み15,000円を正本どおり適用する。既存全体枠・旧未知予約の余地も確認する。
4. 全工程normal36/mini24、Job24回/9hを初期/通常に正しく配分し、1run normal3、比較15分、Job30分を各段階で拘束する。期限後は新規送信0、送信済みの結果/usageだけ安全確定する。未完了を正常0件にしない。
5. 必須Local checks・独立レビュー・正しいheadのCI後、Localからexact image digestを試用専用App/Jobへ配備する。App/Jobサイズ、forward3/rollback1等の承認値を変えない。mainや本番workflowを使わない。
6. OWNER認証、公開sample→実AI比較→根拠/確認状態→全PDFページ/CSV行→再表示、期限後拒否、cold start、クラウド保存、費用と本番非影響を実測する。正式期間へ戻した設定を再取得する。
7. 実費/見通し/不明/残枠と利用案内をOWNERへ渡す。原本・成果物・台帳・URLは保持し、2027-01-29 09:00 JSTに保管を見直す。自動削除・別グループ転用はしない。全受入成立時だけGOを記録する。

## 検証・公開・復旧

架空fixtureのtest、lint、type-check、build、diff check、公開情報の再検索、独立Local reviewを現在headに対応させる。実ID、個人パス、raw response、秘密値・認証URL、請求明細はcommit・Issue・PR・Actionsへ含めない。実値との対応と接続記録はOWNER限定Local記録に保持する。

未配備のため現時点のクラウドrollbackは不要。実装差分は専用branchの通常commitで保持し、履歴改変をしない。配備後のrollbackは承認済み試用対象・1回枠・署名policy/image整合を確認して行い、データや台帳を削除しない。
