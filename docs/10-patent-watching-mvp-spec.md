# 出願後ウォッチングMVP仕様

## 1. 目的と境界

出願済み案件の抽出済み請求項を起点に、既にglobal公報corpusへ取り込まれた新着公報との重なり候補を、ユーザーの明示操作で確認する。結果は調査・比較・論点整理の支援であり、法的判断ではない。

本MVPはwatch設定、差分run、finding、確認状態、CSV、browser印刷用HTMLを提供する。J-PlatPat自動操作、remote download、scheduler、queue、外部通知、公報PDF添付、PDF binary生成、Production migration、Production corpus投入、Azure resource／secret／runtime設定は対象外である。

## 2. 設定とcursor

案件ごとに最大1件のwatch settingを持つ。

- `enabled`: boolean
- `monitoringFromDate`: Gregorian calendar上の実在日を表すexact `YYYYMMDD`
- `cursorRunUpdatedAt`、`cursorImportId`: 両方nullまたは両方non-null

初回有効化ではcursorを先取りしない。監視開始日を変更しても既存findingを削除しない。

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

screeningまたは詳細分析が例外終了した場合は、prefilter上位最大20件へ決定的token overlap fallbackを適用する。入力集合にないAI返却IDは無視し、正常な空結果をAI失敗とみなさない。fallbackは`analysisMode=fallback`、risk label `Unknown`、lexical scoreにprefilter score、他3 scoreに0を保存し、説明を次の固定文言にする。

> AI分析が利用できなかったため、語彙重なりによる確認候補です。人による確認が必要です

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

共通stable error codeは`invalid_watch_setting`、`invalid_watch_review_status`、`invalid_watch_run_request`、`case_not_found`、`watch_not_configured`、`watch_disabled`、`watch_claims_not_ready`、`watch_run_in_progress`、`watch_run_not_found`、`watch_finding_not_found`、`watch_corpus_unavailable`、`watch_unavailable`、`watch_analysis_failed`、`watch_internal_error`とする。`invalid_watch_review_status`はPATCH exact body、`invalid_watch_run_request`はPOST runの非0-byte bodyの入力不正へ400で使用する。response messageへ入力本文、請求項、公報本文、DB／AI error、path、hash、secretを含めない。

## 9. UIとreport

案件詳細に既存Step番号を変えない独立section「出願後ウォッチング」を追加する。初期client renderではrequestを発生させず、mount後はstatus-only GETだけを行う。run POST、setting PUT、review PATCHはユーザーの明示操作だけで行い、corpus検索を自動実行しない。

sectionはloading、running、completed、failed、unavailable、fallbackを区別し、設定、最新run、未確認件数、finding、review操作、過去run最大20件、report／CSV導線を表示する。storage未準備時も案件page全体を壊さず、section内に利用不可を表示する。

専用report pageは非識別のnumeric案件ID、run日時、対象公報数、新着候補数、fallback有無、findingと4 score、一致候補、差分候補、説明、次の免責を含む。任意入力の案件名は顧客情報を含み得るためHTMLへ表示しない。

> 本レポートは確認候補を整理するもので、法的判断ではありません

browser印刷ではnavigationとbuttonをprint CSSで除く。アプリ内でPDF binaryを生成、保存、送信しない。

## 10. Productionとrollback

codeとmigration artifactを追加するが、本IssueではProduction DBへmigrationを適用しない。watch tableがない環境ではAPIをstable 503にし、案件pageは利用不可sectionとして継続表示する。Productionでの有効化、corpus投入、scheduler、secret／環境変数、Azure resource変更は別承認とする。

rollbackは本変更のsquash commitをrevertしてschema／migration artifact、watch repository／domain／API／UI／report／test／docsを戻す。本IssueでProduction migrationを適用しないためProduction data rollbackは行わない。
