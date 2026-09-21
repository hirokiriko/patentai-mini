# 出願後ウォッチングMVP仕様

## 1. 目的と境界

出願済み案件の抽出済み請求項を起点に、既にglobal公報corpusへ取り込まれた新着公報との重なり候補を、ユーザーの明示操作で確認する。結果は調査・比較・論点整理の支援であり、法的判断ではない。

本MVPはwatch設定、差分run、finding、確認状態、CSV、browser印刷用HTMLを提供する。J-PlatPat自動操作、remote download、scheduler、queue、外部通知、公報PDF添付、PDF binary生成、Production migration、Production corpus投入、Azure resource／secret／runtime設定は対象外である。

現在は取り込み済み公報だけを対象とする手動実行機能である。Issue #89で公開・完全架空データに限定した本番受入は完了済みだが、顧客データの受入・実案件提供は未承認である。週次の自動取得・比較、候補がある場合だけのメール通知、専門家が所見を付けられるレポートという製品目標はIssue #94で扱う。本MVPの手動機能だけで製品全体の完成とはしない。

## 2. 設定とcursor

案件ごとに最大1件のwatch settingを持つ。

- `enabled`: boolean
- `monitoringFromDate`: Gregorian calendar上の実在日を表すexact `YYYYMMDD`
- `cursorRunUpdatedAt`、`cursorImportId`: 両方nullまたは両方non-null

初回有効化ではcursorを先取りしない。監視開始日を変更しても既存findingを削除しない。初回は公開日条件、以後は取込差分を対象とし、開始日の変更だけでは過去分を再走査しない。

cursorは`koho_import_runs.updated_at ASC, import_id ASC`のtupleである。timestamp比較はPostgresのmicrosecond精度を保つ。run開始時の単一repository transactionでcaseとsettingを検証し、5分以内に開始された同watchのrunning runがないことを確認し、監視開始日、現在のcursorを`baseCursor`、現在存在する最大tupleを`upperCursor`としてrunning rowへ固定する。5分を超えて残っているrunning runは、120秒の同期route budgetを超えて中断されたrunとして同transaction内で`failed`／`watch_internal_error`へ回収し、cursorを変更しない。その後に新しいrunを開始できる。run開始後にsettingの監視開始日が変更されても、実行中runの対象範囲は開始時snapshotから変えない。

対象import runは`baseCursor`より大きく固定`upperCursor`以下とする。初回は全runを候補とし、documentの`publicationDate >= monitoringFromDate`を追加条件とする。corpus保存とupper固定は共通のtransaction-scoped advisory lockで直列化する。importの`updated_at`はlock取得後に、wall clockと既存最大timestamp + 1 microsecondの大きい方を設定する。これによりupper固定前に進行中のimportは今回に含まれ、固定後のimportは必ず次回へ残る。corpusに新しいimportがない場合もcompleted runを保存し、AIを呼ばない。

成功finalizeはfinding insert、run complete、setting cursor更新を単一transactionで行う。1件でも失敗した場合は全rollbackする。通常の失敗はrunだけをfailedへ更新し、cursorを変更しない。

## 3. 安定finding identity

`sourceKey`はNode標準`crypto`のSHA-256 lowercase hex 64文字とし、次のexact key orderを持つcanonical JSONのUTF-8 bytesから算出する。

```json
{
  "publicationNumber": "JP2099000001A",
  "contentSha256": "lowercase-hex-64"
}
```

同一watch内で`sourceKey`をuniqueにする。document ID、import ID、package、entry pathはidentityに使用しない。同じ公開番号でもcontent digestが変われば新しい変更候補を許容する。

source key、source/content SHA、entry pathは内部の冪等性・監査境界だけで使用し、API、画面、CSV、HTML report、logへ表示しない。

## 4. 決定的prefilter

対象請求項は独立請求項とし、独立請求項が0件なら全請求項を用いる。source textは発明名称、要約、請求項の連結である。

token化は次で固定する。

1. Unicode NFCだけを適用し、NFKC等の互換正規化は行わない。
2. locale非依存の小文字化を行う。
3. Unicode property escapeでletter／numberの語列を抽出する。
4. CJK語列はUnicode code point単位の隣接2-gramへ分解し、2 code point未満は語自体をtokenとする。その他は語単位とする。
5. 重複を除いたclaim token集合`C`とsource token集合`S`について、Sørensen–Dice係数 `2 * |C ∩ S| / (|C| + |S|)` を算出し、小数6桁へroundする。空集合またはintersection 0はscore 0とする。

既存findingと同じsource identityを除外し、score 0を補充せず、`score DESC`、`publicationDate DESC`、`publicationNumber ASC`、`documentId ASC`で決定的に並べて最大100件をAI screening候補にする。同一run内の同一source identityも1件にする。

## 5. AI分析とfallback

prefilter結果が0件ならAIを呼ばない。1〜100件を既存`screenPriorArt`へ渡し、入力集合に存在する返却IDだけを重複除去して最大20件採用する。採用documentは既存`analyzeOverlap`へ渡す。

独立請求項が0件の場合は、全請求項をwatch分析用入力では独立請求項として扱う。AIが同一文献について複数請求項結果を返した場合、次のweighted overall最大のrowを文献単位findingの代表とし、同点は請求項番号昇順とする。

```text
0.30 * lexical + 0.35 * element + 0.20 * semantic + 0.15 * structural
```

screeningまたは詳細分析が通常の例外終了をした場合は、prefilter上位最大20件へ決定的token overlap fallbackを適用する。入力集合にないAI返却IDは無視し、正常な空結果をAI失敗とみなさない。fallbackは`analysisMode=fallback`、risk label `Unknown`、lexical scoreにprefilter score、他3 scoreに0を保存し、説明を次の固定文言にする。

> AI分析が利用できなかったため、語彙重なりによる確認候補です。人による確認が必要です

時間超過・入力上限・usage未確認等によるAI保護停止は通常fallbackと区別し、`watch_ai_stopped`でfailedへ送る。保護停止時は追加送信・部分finding保存・cursor更新を行わない。失敗finalize自体が利用不可の場合も保存成功と断定しない。既存の時間・回数・入力/出力・usage照合の条件は維持する。

fallbackをAI成功として扱わない。AI／fallbackとも「拒絶される」「登録できない」「新規性がない」等の法的結論を生成・保存・表示しない。AI出力に、実際に分析へ渡したdraft claimまたはsource claimの全文が反復された場合は、finding保存前に除去または公開安全な固定文言へ置換する。

## 6. 保存model

### `case_watch_settings`

案件参照、enabled、監視開始日、nullable cursor tuple、created/updated timestampを保存する。case参照はcascade delete、caseごとにuniqueとする。

### `case_watch_runs`

setting参照、`running | completed | failed`、run開始時の監視開始日snapshot、base／upper cursor、started/completed timestamp、scanned import run／document、prefiltered、analyzed、新規finding、fallback findingの各count、`none | ai | fallback`、stable error codeを保存する。同一watchのactiveなrunning重複はtransactionで拒否する。同期route budgetを十分に超えた5分超のrunning runは、次回開始transactionでcursorを進めずfailedへ回収する。

### `case_watch_findings`

watch／first run参照、source identity、nullable corpus document参照、package type、kind、公開番号、公開日、発明名称、要約preview、4 score、risk label、canonical analysis JSON、`ai | fallback`、`unreviewed | reviewed`、first seen timestampを保存する。公開用文字列はsanitize後のUnicode code point数で公開番号100、発明名称500、要約preview 300を上限とし、API、CSV、HTMLでも同じ上限を再適用する。

raw XML／CSV、description、reference、画像、添付、Applicant／IPC／FI JSON、parse issue、全文claims、source hash、entry path、Local pathをfindingへ保存しない。

## 7. Repository transaction契約

repositoryはadditiveに次を提供する。

- setting get／upsert
- run開始transactionとbase／upper固定
- 固定cursor範囲のcorpus document読取
- 既存source identity集合
- 成功finalize transaction
- 失敗finalize（cursor不変）
- run／findingの決定的な一覧とrun取得
- case境界を含むfinding review status更新

unique conflictは同じ`(watchId, sourceKey)`だけを既存findingとして扱い、他のDB errorを成功扱いしない。成功finalizeの途中失敗はfinding、run、cursorをすべてrollbackする。

## 8. API

### `GET /api/cases/[caseId]/watch`

setting、latest run、未確認finding数、直近run最大20件、公開fieldだけのbounded finding一覧を返す。case不存在は404。watch table未準備／接続不能は503／`watch_unavailable`。

### `PUT /api/cases/[caseId]/watch`

exact body `{ "enabled": boolean, "monitoringFromDate": "YYYYMMDD" }`だけを受理する。extra／missing key、型違い、不正日付は400／`invalid_watch_setting`。成功時は保存settingだけを返す。

### `POST /api/cases/[caseId]/watch/runs`

bodyなしまたは0 byteだけを受理する。未設定／disabled／請求項未抽出／実行中／corpus未準備をstable codeで区別する。同期request内で有限時間に完了し、background promiseを残さない。既存のscreeningと詳細分析はそれぞれ35秒のtotal timeoutを持つため、routeの`maxDuration`はDB finalizeの余裕を含む120秒とする。

### `PATCH /api/cases/[caseId]/watch/findings/[findingId]`

exact body `{ "reviewStatus": "reviewed" | "unreviewed" }`だけを受理する。別caseのfindingを更新しない。

### `GET /api/cases/[caseId]/watch/report.csv?runId=<positive integer>`

指定runで初めて保存されたfindingをUTF-8 CSVで返す。列は公開番号、公開日、kind、発明名称、risk label、4 score、一致候補、差分候補、説明、分析mode、確認状態だけとする。comma、quote、改行をRFC 4180形式でescapeし、先頭の`=`, `+`, `-`, `@`およびcontrol prefixはformulaとして評価されないよう無害化する。

共通stable error codeは`invalid_watch_setting`、`invalid_watch_review_status`、`invalid_watch_run_request`、`case_not_found`、`watch_not_configured`、`watch_disabled`、`watch_claims_not_ready`、`watch_run_in_progress`、`watch_run_not_found`、`watch_finding_not_found`、`watch_corpus_unavailable`、`watch_unavailable`、`watch_analysis_failed`、`watch_ai_stopped`、`watch_internal_error`とする。`invalid_watch_review_status`はPATCH exact body、`invalid_watch_run_request`はPOST runの非0-byte bodyの入力不正へ400で使用する。response messageへ入力本文、請求項、公報本文、DB／AI error、path、hash、secretを含めない。

### HTTP実行ごとの停止診断（Issue #109）

watch POSTの入口で暗号学的乱数UUID v4を生成し、当該POSTの応答header `X-Patent-Watch-Diagnostic-Id` に設定する。外部のheaderや案件/run/入力からIDを作らず、認証・冪等性・診断検索には使わない。成功bodyと既存GET/CSV/レポートは変更しない。`watch_ai_stopped` の500 bodyだけ任意の `diagnostic: { id, stage, reason }` を加え、idをheaderと一致させる。生成不能時は診断を省略し、元の業務結果を保つ。

stageは呼出境界で確定した `screening | detail | unknown`。reasonは `request_rejected | input_limit | request_limit | timeout | aborted | upstream_http_error | transport_error | invalid_response | usage_missing | usage_invalid | usage_limit | unknown` の固定値。実際の期限signalを確認した場合だけtimeoutとし、例外名だけでは期限到達と断定しない。実行内で最初の停止を保持し、SDKによる包み直し・後着abort・失敗finalizeで上書きしない。nested budgetの累計、35秒/120秒、送信・入力・usage上限、fallback/cursor/保存仕様は維持する。

watch context中の `ai_operation_usage` は `diagnosticId/stage/reason` を追加する。非watchの既存数値ログは同じ形式。終端の `patent_watch_diagnostic` は最大1行、ID・既存結果code・固定stage/reasonのみとし、本文・token詳細・例外・provider情報を増やさない。実行/段階の終了後callbackは診断を更新せず追加送信しない。ログ・診断の失敗は業務結果を変更しない。プロセス停止や応答喪失後の記録保証、過去実行の原因確定、実請求額の証明ではない。

## 9. UIとreport

案件詳細に既存Step番号を変えない独立section「出願後ウォッチング」を追加する。初期client renderではrequestを発生させず、mount後はstatus-only GETだけを行う。run POST、setting PUT、review PATCHはユーザーの明示操作だけで行い、corpus検索を自動実行しない。

sectionはloading、running、completed、failed、unavailable、fallbackを区別し、設定、最新run、未確認件数、finding、review操作、過去run最大20件、report／CSV導線を表示する。storage未準備時も案件page全体を壊さず、section内に利用不可を表示する。

今回POSTの保護停止では、exactな診断shape・UUID v4・固定enum・header一致を検証後、停止段階・固定日本語分類・照合用番号を表示する。不正/欠損時は従来の固定説明だけ。診断を保存済みrunへ付けず、GETから復元せず、ブラウザ再読込で失われる。画面内の保存済み情報GET再読込は今回POSTの説明を保持するが、そのGETを診断の根拠にしない。非JSON/通信断は実行結果・診断情報とも不明で、自動POST再送・polling・localStorage保存をしない。

Issue #93では今回の実行結果（完了、fallback、前提不足、AI保護停止、サーバー失敗、結果不明）と最後に取得できた保存済みrun/findingsを別表示する。POST失敗・非JSON・通信断後もstatus GETを1回だけ行う（応答本文を含め15秒で打切り）。POSTは120秒のサーバー予算を超える125秒で応答確認を打切り、結果不明とする。GET成功だけでは不明POSTを成功へ変更しない。結果不明の同じ画面では監視の再送を止め、GET再読み込みを残す。GET失敗時は最新情報を未取得とし、既存結果・確認状態は保持する。明示的な「保存済み情報を再読み込み」はGETだけで、pollingやPOST自動retryを行わない。failed/runningの新着件数は未確定と表示し、正常0件と区別する。

専用report pageは非識別のnumeric案件ID、run日時、対象公報数、新着候補数、fallback有無、findingと4 score、一致候補、差分候補、説明、次の免責を含む。任意入力の案件名は顧客情報を含み得るためHTMLへ表示しない。

> 本レポートは確認候補を整理するもので、法的判断ではありません

browser印刷ではnavigationとbuttonをprint CSSで除く。アプリ内でPDF binaryを生成、保存、送信しない。

Issue #112では、watch一覧・単一run・期間レポートに表示する保存候補に`analysisMode=ai`がある場合だけ「AI比較の範囲」を画面と印刷へ表示する。現行の詳細比較は自案の独立請求項（抽出済み独立請求項が0件なら全請求項）、公報の要約、請求項テキストの先頭最大2,000文字を使い、明細書全文とそれを超える請求項を含まない。差分候補は入力範囲の一致未確認であり、公報全体の不存在を意味しない。Lowでも原文確認を要する。注記は現行方式の説明であり、過去の各結果の実送信文字数・切断有無を記録したものではない。fallbackのみ・候補0件では表示せず、混在時はai候補への説明と明示する。AI本文・分類・保存値・CSVは変えない。

### 現在の比較資料（Issue #117）

案件画面・検索式生成・通常比較は、watchと同じく読取時点で最大draftIdのmainを使う。最新mainが未抽出なら古い抽出済み資料やbase/additionへ戻らず、抽出を案内する。画面の「現在の比較・ウォッチ対象」と対象資料の表示を確認してから明示実行する。統合は最新base/additionを読み、最新mainを更新して抽出を未済へ戻す。過去の資料は削除しない。

これは出願時/登録時の版管理や、過去の実送信記録ではない。保存済み検索式・比較・watch結果を現在のmainへ結び付け直さず、自動再分析・cursorリセットをしない。base/addition差替え後の統合結果の鮮度も自動判定しない。実行中の資料差替えへの追従・排他は追加せず、手動試用では対象資料を固定し、番号・請求項版・対応runを別途確認する。

## 10. Productionとrollback

初期実装はcodeとmigration artifactを追加し、Production DBへの適用を別承認とした。後続のIssue #89で公開・完全架空データ限定の本番受入を実施済み。Issue #93はwatchの最小修正だけを行い、DB migrationや本番watch再実行を含まない。watch tableがない環境ではAPIをstable 503にし、案件pageは利用不可sectionとして継続表示する。Productionでの有効化、corpus投入、scheduler、secret／環境変数、Azure resource変更は別承認とする。

Issue #93のrollbackは同修正のrevert PRと通常deployで行う。既存DB、公報、cursor、秘密、Issue #89の正常状態は巻き戻さない。

## 11. Issue #97: 保存済み監視結果の期間レポート

案件の「出願後ウォッチング」→「期間レポート（週次・月次）」で、前週（月曜〜日曜）、前月、または任意の開始日・終了日を選び、「期間レポートを表示」を押す。前週・前月はAsia/Tokyoの暦で求める。watch無効化中でも保存済み結果は閲覧できる。

新規URLは `/cases/[caseId]/watch/period-report?from=YYYY-MM-DD&to=YYYY-MM-DD`。実在するexact日付、開始日<=終了日、両端を含む最大31日だけを受理する。重複・余分・欠損queryは固定案内で拒否し、queryなしは選択画面だけとする。初期案件表示・入力変更・リンクprefetchで集計しない。新規導線は自動prefetchのない通常のリンクとGET formを使う。

期間は**監視実行開始日（日本時間）**である。from当日JST 00:00以上、to翌日JST 00:00未満のstartedAtをDB timestampの精度で比較する。公報の発行期間・出願期間・全公報の網羅期間ではなく、週次取得した結果を月次で整理する用途にも使える。期間をまたいで完了した実行も開始日に所属する。

専用repository読取はcase境界をDB queryへ含め、read-only / repeatable read transactionで実行と候補を同じsnapshotから取得する。候補は対象のcompleted runをfirstRunIdに持つ保存済みfindingのみ。過去期間の初検出を再計上せず、同一公開番号でも本文変更による別findingは保持する。既存20run/100finding一覧を流用しない。最大200run・4,000findingを各上限+1で検出し、超過時は全体を表示せず期間短縮を案内する。DB statement timeout 5秒、lock timeout 3秒、idle transaction timeout 5秒、レポート応答待ち20秒で有限にする。応答待ち打切りだけではDB query取消の実証とはしない。設定・cursor・run・findingを更新せず、running回収・AI・取込を行わない。

案件はnumeric IDだけで示し、期間・作成日時JST・完了/失敗/実行中件数・保存findingから求めた新規候補数・確認状態・AI/fallback内訳・対象runを表示する。件数矛盾や不正row、DB失敗/timeoutは取得不能とし、0件へ補完しない。確認状態はレポート作成時点の保存状態であり履歴や専門家の所見ではない。失敗/実行中は不完全警告を見出しと印刷に残し、実行記録なし・完了runの新規候補0・取得不能・上限超過を区別する。

候補は既存文字上限とサニタイズを再利用する。原文は公開番号からJ-PlatPat等で人が確認する。対象は各実行時の取り込み済み公報であり、全公開公報の取得完了・全件AI精読・自己案件除外・「他社」判定を保証しない。risk labelはAI比較の参考で、法的判断や対応義務、専門家の確定所見ではない。長い候補は印刷時にページ間分割を許可し、期間・状態・件数・注意文・候補を残す。PDFはbrowserの印刷保存を使う。所見は印刷物や既存単一run CSVへ外部追記できる。期間CSV・所見editor・メール配信は追加しない。

段階Aは運営者の手動取得による定期レポート試用、段階Bは取得・定期実行・通知の自動化とする。リアルタイムは別需要である。本変更の受入は期間レポートの実装までで、手動公報の期間分取得・正規取込運用、Issue #93の原障害、実AI/実DBの全体試用、専門家の品質評価、実顧客受入は別残件。Issue #89の公開・完全架空データ限定受入は維持する。

本変更はDB列/table/migration/権限、AI、既存API/CSV URL、secret/env、Azure resourceを変更しない。rollbackは本変更のrevert PR→既存通常deployとし、保存済み公報・候補・設定を削除/初期化しない。

### 単一runの未完了・取得不能（Issue #101）

単一runにも完了／失敗／実行中を明示し、日本時間（Asia/Tokyo）で日時を表示する。失敗・実行中は「結果は未確定」と印刷にも残し、完了サマリーや正常0件の文言を出さない。完了結果は保存件数、取得行、所属run/watch、重複、時刻、fallback数、分析JSONを検証し、100件超過は101行目も取得して全体を拒否する。取得不能・不整合を正常0件や全件出力として扱わない。

CSVはcompletedだけを出力する。未完了はHTTP409とJSON `{"error":"watch_report_not_completed"}`、attachmentなし。画面のCSVリンクも完了runだけに表示する。完了CSVのURL/query/列順/BOM/CRLF/数式無害化と不存在・他案件runの404は維持する。report/CSVのGETは監視・AI・import・確認状態変更・cursor更新・古いrunning回収を起動しない。

実DB結合で、既存`watch_ai_stopped`がrepository許可一覧に欠けて失敗保存を拒否する不具合を再現し、許可一覧を整合した。AI保護条件やcursor仕様は変更しない。この制御された架空試験はIssue #93の原requestの原因証明ではない。

### 候補の出願人・書誌確認（Issue #103）

候補一覧・単一run・期間レポートの「出願人・書誌を確認」から `/cases/[caseId]/watch/findings/[findingId]` を開く。通常のリンクを使い、prefetchや候補ごとの追加読取は行わない。公開番号・種別・発行日・名称、出願番号、登録番号/日、出願人名を表示し、番号は明示操作でコピーできる。同じfindingの単一run内アンカーへ戻って比較説明・確認状態を確認する。

取得はcase→watch→findingの所属とその参照公報1件に限定したread-only snapshot。番号・kind・内容由来のsource identityが一致しなければ書誌全体を未確認にする。出願人は既存serializerのshapeを検証し、JSON 64KiB、100件、各名称500文字を上限として記載順の名称だけを投影する。超過・不正・redaction時は省略名を表示せず原文確認を案内し、null/未記載と区別する。SQL timeoutと応答待ち上限は期間レポートと同じ有限設定を使う。

印刷には書誌・出典状態・注意文を残す。取り込み済み公報の記載であり、最新権利者や審査経過、自社/他社の判定、自己案件除外、法的結論ではない。公式J-PlatPat入口と番号から人が原文を確認する。既存CSV・case snapshot・schema・AI・cursor・確認状態は変更しない。本番機能受入や実案件提供許可は未確認のまま維持する。
