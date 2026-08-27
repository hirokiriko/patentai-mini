# 公報package保存仕様

本書は、`parseKohoPackage`が返す`KohoPackageParseResult`から、確認済みの
full publicationをglobal公報corpusへ保存する契約を定める。対象は取込plan、
Postgres schema、repository coreまでであり、公報の法的評価を行うものではない。

現行実装では公報packageのparserと保存基盤までを提供する。API、UI、scheduler、
remote download、自動取得、J-PlatPatの自動操作、およびProduction DBへのmigration
適用は未実装または本仕様の対象外である。

## 1. 既存modelとの境界

- `prior_art_documents`は`case_id`に紐付く、案件単位の検索結果・比較対象である。
- `koho_import_runs`と`koho_import_documents`は案件に紐付かないglobal corpusである。
- global corpusを既存`prior_art_documents`へ混在させず、既存repository／API contractを
  変更しない。
- case削除時にglobal corpusを削除しない。
- global corpusと案件を結び付ける検索、選択、比較APIは本仕様に含めない。

## 2. import plan

`src/lib/koho-import/**`は次を公開する。

- `buildKohoImportPlan(input)`
- `KohoImportPlan`
- `KohoImportDocumentPlan`
- typed validation error

inputは`packageResult: KohoPackageParseResult`と`sourceSha256: string`である。
`sourceSha256`はlowercase ASCII hex 64文字だけを受理する。trim、大小文字変換、
欠損補完は行わない。不正値はpackage resultのsource本文を参照せずtyped errorとする。

builderはpureかつ決定的でなければならない。同じinputからは同じdocument順、JSON、
content digestを返し、DB IDや時刻を生成しない。

### 2.1 runtime object shape

TypeScript型だけを信用せず、repository境界へ渡されたplanとdocumentをruntimeでexactに
検証する。planは通常のplain objectかつown fieldだけで構成し、次のfieldだけを持つ。

- `packageType`
- `sourceSha256`
- `packageStatus`
- `documentCount`
- `amendmentCount`
- `nestedSt26Count`
- `countsJson`
- `issuesJson`
- `documents`

`packageType`は`JPA`または`JPB`、`sourceSha256`はlowercase ASCII hex 64文字、
`packageStatus`は`success`、`review_required`、`failed`のいずれかとする。
3種のcountはnon-negative safe integer、`countsJson`と`issuesJson`はstring、
`documents`はarrayとする。

`documents`だけを配列として許可し、他のfieldへ配列やobjectを渡してはならない。fieldの
欠損、余分なfield、継承field、custom prototypeへ依存する値を拒否する。

各documentも通常のplain objectかつown fieldだけで構成し、次のfieldだけを持つ。

- `normalizedEntryPath`
- `parseStatus`
- `kind`
- `publicationNumber`
- `applicationNumber`
- `publicationDate`
- `registrationNumber`
- `registrationDate`
- `inventionTitle`
- `abstractText`
- `claimsText`
- `applicantsJson`
- `ipcJson`
- `fiJson`
- `parseIssuesJson`
- `sourceMetadataJson`
- `contentSha256`

`parseStatus`は`success`または`review_required`、`kind`は`A1`、`P1`、`B1`、`B2`の
いずれかとする。`registrationNumber`、`registrationDate`、`abstractText`はstringまたは
null、それ以外のscalar fieldと5種のJSON textはstring、`contentSha256`はlowercase
ASCII hex 64文字とする。`normalizedEntryPath`は正規化済みprimary XML pathであり、
package type、kind、sectionの対応を満たす。

documentでも欠損field、余分なfield、配列、継承field、custom prototypeへ依存する値を
拒否する。契約外fieldを無視して保存してはならない。既存のpackage type、status、kind、
path、nullable field、count、hashの制約と、`documentCount === documents.length`を維持する。

### 2.2 documentの選択

`primaryXmlResults`のうち、次をすべて満たすresultだけをdocument planへ含める。

- `entryType === "full_publication"`
- `identityConfirmed === true`
- `document !== null`
- kindが`A1`、`P1`、`B1`、`B2`のいずれか

`status === "review_required"`でもidentityが確認済みなら保存し、parse statusとissue
codeを保持する。次はdocument rowへ保存しない。

- A5／P5 amendment
- nested ST.26
- unknown、unsupported、failed result
- identity未確認candidate

amendmentとnested ST.26はdocument化しないが、確認済みamendment件数とnested候補
件数をrun summaryへ残す。package issueと全primary XML issueも集計して残す。

### 2.3 document順と重複

保存対象は`normalizedEntryPath`、次いで`entryId`の昇順に並べる。同じ
`normalizedEntryPath`が複数ある場合は上書きやdeduplicateを行わず、typed errorとする。

## 3. document projection

document planと`koho_import_documents`には次だけを保存する。

| field | projection |
|---|---|
| `normalizedEntryPath` | package resultに付与された正規化entry path |
| `parseStatus` | XML resultのstatus |
| `kind` | `A1`、`P1`、`B1`、`B2` |
| `publicationNumber` | 公開番号の正規化値 |
| `applicationNumber` | 出願番号の正規化値 |
| `publicationDate` | 公開日の正規化値 |
| `registrationNumber` | 存在する場合の登録番号、なければnull |
| `registrationDate` | 存在する場合の登録日、なければnull |
| `inventionTitle` | 発明名称のplain text |
| `abstractText` | 要約のplain text、存在しなければnull |
| `claimsText` | source順の各`claim.plainText`をexact `\n\n`で連結した文字列 |
| `applicantsJson` | 第3.1節の出願人projection |
| `ipcJson` | 第3.1節のIPC projection |
| `fiJson` | 第3.1節のFI projection |
| `parseIssuesJson` | 第3.1節のXML issue projection |
| `sourceMetadataJson` | 第3.1節のsource metadata projection |
| `contentSha256` | 第3.2節の永続化payload digest |

claimsへ独自見出し、要約、番号補完を加えない。raw XML snapshot、description全文、
reference、画像・添付物、raw CSV rowはprojectionへ含めない。

### 3.1 JSON projection

7種のJSON文字列である`countsJson`、`issuesJson`、`applicantsJson`、`ipcJson`、
`fiJson`、`parseIssuesJson`、`sourceMetadataJson`は、単に`JSON.parse`可能であるだけでは
不十分である。保存前とDB読取時に、各JSON textを次の順で検証する。

1. JSONとしてparseする。
2. 本節と第4節のexact shape、key、型、enum、整数条件を検証する。
3. 許可fieldだけを規定key順で再構築する。
4. `JSON.stringify(canonicalValue)`が元のJSON textと完全一致することを確認する。

余分なkey、欠損key、key順変更、不要な空白、型違い、unknown enum、重複key、その他の
非canonical表現を拒否する。不正なJSONをsilent normalizeして保存してはならない。
配列順は、別途sortを規定する`issuesJson`を除きsource順を維持する。

`applicantsJson`はarrayであり、各要素は`ordinal`、`sequenceNumber`、`names`の順で
exactに持つ。`ordinal`はnon-negative safe integer、`sequenceNumber`はstringまたは
null、`names`はarrayとする。各nameは`value`、`sourceValue`、
`originalLanguageIndicator`の順でexactに持ち、最初の2 fieldはstring、最後はboolean
またはnullとする。

`ipcJson`と`fiJson`はarrayであり、各要素は`ordinal`、`role`、`value`、
`sourceValue`の順でexactに持つ。`ordinal`はnon-negative safe integer、`role`は
`main`または`further`、残りはstringとする。

`parseIssuesJson`はarrayであり、各要素は`code`、`status`、`field`の順でexactに持つ。
`code`は現行`KohoIssueCode`、`status`は`review_required`、`unsupported_type`、
`failed`のいずれか、`field`はstringまたはnullとする。`message`、raw source、path等を
追加してはならない。

`sourceMetadataJson`はobjectであり、`normalizedEntryPath`、`rootLocalName`、
`rootNamespaceUri`、`schemaBasename`、`st96Version`、`ipoVersion`、`languageCode`、
`xsdValidation`の順でexactに持つ。`normalizedEntryPath`はstringかつdocumentの
`normalizedEntryPath`と完全一致し、続く6 fieldはstringまたはnull、`xsdValidation`は
exactに`not_performed`とする。

parserが保持するsource snapshot、複数のsource表現、attributes、description、reference
等を便宜的にJSONへ追加してはならない。

### 3.2 content SHA-256

`contentSha256`は、`contentSha256`自身、DB ID、import IDを除く永続化document payload
全体を固定key順でJSON化したcanonical UTF-8 bytesから算出する。digestはlowercase
ASCII hex 64文字とし、同じinputの同じdocumentは常に同じ値になる。

payloadのfield名と順序は第3節のtable順を唯一の正本とし、nested JSONは第3.1節で
検証したcanonical JSON textのままpayloadへ含める。許可fieldからpayloadを再構築し、
UTF-8の`JSON.stringify(payload)`へSHA-256を適用するpure helperを
`src/lib/koho-import/**`へ置く。builder生成、repository保存前検証、DB document読取
検証は同じcanonical projection／digest helperを共有し、計算を別々に複製しない。

repository境界では、形式検証に加えて全documentのdigestを再計算する。lowercase hex
64文字でない値は既存のhash validation error、形式は正しいが再計算値と異なる場合は
安定したtyped error code `content_sha256_mismatch`で拒否する。

## 4. run summary

runはpackage単位の処理状態を保持し、documentが0件でも保存する。

- `packageStatus`: package resultのstatus
- `documentCount`: 保存対象document件数
- `amendmentCount`: `counts.confirmedAmendments`
- `nestedSt26Count`: `counts.nestedXmlCandidates`
- `countsJson`: package count summaryの決定的JSON
- `issuesJson`: package issueと全primary XML issueの決定的aggregate

`issuesJson`はraw issue配列、message、entry ID、pathを保存しない。次のkeyで同一issueを
集計し、`count`を付ける。

- `source`: `package`または`xml`
- `code`
- `status`
- `kind`: XML issueに対応するkind。該当しなければnull
- `section`: package issueに対応するsection。該当しなければnull
- `count`

配列順は`source`、`code`、`status`、`kind`、`section`の昇順へ固定する。

各aggregateは`source`、`code`、`status`、`kind`、`section`、`count`の順でexactに
持つ。`source`は`package`または`xml`、`code`はstring、`status`は
`review_required`、`unsupported_type`、`failed`のいずれか、`kind`は`A1`、`A5`、
`P1`、`P5`、`B1`、`B2`またはnull、`section`は`P_A1`、`P_A5`、`P_P1`、`P_P5`、
`P_B1`またはnull、`count`はpositive safe integerとする。`source === "package"`では
`kind === null`、`source === "xml"`では`section === null`を要求する。
`source`、`code`、`status`、`kind`、`section`が同じaggregateを複数含めてはならず、
規定順でない配列も拒否する。

`countsJson`は`KohoPackageCountSummary`を固定key順で再射影する。top-levelは
`primaryXmlCandidates`、`finalXmlResults`、`confirmedFullPublications`、
`confirmedAmendments`、`nestedXmlCandidates`、`documentFolders`、
`documentListRecords`、`roleCounts`、`bySection`の順とする。`roleCounts`は
`directory`、`xml`、`csv`、`schema`、`image`、`other`、`bySection`は`P_A1`、
`P_A5`、`P_P1`、`P_P5`、`P_B1`の順とする。各sectionは
`primaryXmlCandidates`、`finalXmlResults`、`confirmedFullPublications`、
`confirmedAmendments`、`documentFolders`、`contents1Records`、`contents2Records`、
`attachmentCount`、`roleCounts`の順とする。

`countsJson`のtop-level、各section、各`roleCounts`は上記fieldを欠損なくexactに持ち、
余分なkeyを許可しない。すべての件数はnon-negative safe integerとする。さらに、
`confirmedFullPublications === documentCount`、
`confirmedAmendments === amendmentCount`、
`nestedXmlCandidates === nestedSt26Count`をplan保存前とrun読取時に確認する。

## 5. Postgres schema

既存tableは変更せず、次の2 tableを追加する。

### 5.1 `koho_import_runs`

| column | contract |
|---|---|
| `import_id` | serial primary key |
| `package_type` | text not null |
| `source_sha256` | text not null |
| `package_status` | text not null |
| `document_count` | integer not null |
| `amendment_count` | integer not null |
| `nested_st26_count` | integer not null |
| `counts_json` | text not null |
| `issues_json` | text not null |
| `created_at` | timestamptz not null default now |
| `updated_at` | timestamptz not null default now |

`(package_type, source_sha256)`へunique indexを設定する。

### 5.2 `koho_import_documents`

| column | contract |
|---|---|
| `document_id` | serial primary key |
| `import_id` | integer not null、run参照、on delete cascade |
| `normalized_entry_path` | text not null |
| `parse_status` | text not null |
| `kind` | text not null |
| `publication_number` | text not null |
| `application_number` | text not null |
| `publication_date` | text not null |
| `registration_number` | text nullable |
| `registration_date` | text nullable |
| `invention_title` | text not null |
| `abstract_text` | text nullable |
| `claims_text` | text not null |
| `applicants_json` | text not null |
| `ipc_json` | text not null |
| `fi_json` | text not null |
| `parse_issues_json` | text not null |
| `source_metadata_json` | text not null |
| `content_sha256` | text not null |

`(import_id, normalized_entry_path)`へunique indexを設定する。DB constraintだけに依存せず、
builder／repository境界でもpackage type（`JPA`／`JPB`）、package status
（`success`／`review_required`／`failed`）、document parse status
（`success`／`review_required`）、kind、hash、pathの既知値に加え、runtime objectの
exact shape、canonical JSON、count整合、source metadata path、content digestを検証する。
未知値や契約外rowを成功扱いしない。

migrationは`drizzle-kit generate`で新規追加し、既存migrationを書き換えない。
Production DBへ`db:migrate`または`db:push`を実行しない。

## 6. repository transactionと冪等性

additiveな`KohoImportRepository`は少なくとも次を公開する。

- `savePlan(plan)`
- `findRunBySource(packageType, sourceSha256)`
- `findDocumentsByRunId(importId)`

`savePlan`はtransactionを開始する前にplan全体を第2節から第4節の契約で検証する。
違反時はDBへ触れず、既存の`KohoImportRepositoryValidationError`契約に従うtyped errorを
返す。errorの型、`name`、安定した`code`を維持し、error本文へ入力値、path、publication
number、JSON本文、content digest、payload本文を含めない。
検証時に許可fieldだけからdeep snapshotを作成し、transaction内ではそのsnapshotだけを
使用する。呼出元が`savePlan`開始後に元planやdocumentを変更しても保存内容へ反映しない。

`savePlan`は単一Postgres transactionで次を行う。

1. `(packageType, sourceSha256)`でrunをupsertする。
2. 既存runでは`createdAt`を保持し、status、counts、issues、`updatedAt`を更新する。
3. そのrunの既存documentを削除する。
4. plan documentを決定順でinsertする。
5. `{ run, savedDocumentCount }`としてrunと保存document件数を返す。

途中失敗時はrun更新、document削除、insertをすべてrollbackする。同じplanを繰り返し
保存しても同じrun IDを使い、run数とdocument数を増やさない。空document planはrunだけ
保存し、同じrunの既存documentを0件へ置換する。

境界検証の追加は、このupsert／replace／empty plan／`createdAt`保持／rollbackの
transaction semanticsを変更しない。

`findRunBySource`のDB row変換では、既知値とID／時刻に加えて`countsJson`と
`issuesJson`のcanonical shape、およびrun countとの整合を検証する。
`findDocumentsByRunId`のDB row変換では、documentのexact persistence payload、全JSON、
親runのpackage typeとdocumentのkind／source path、source metadata path、content digestを
保存前と同じ契約で検証する。
DB rowが契約外の場合は黙って返したりnormalizationしたりせず、同じrepository typed
validation errorとする。既存の正常row、公開entity type、method signature、読取順は
変更しない。

## 7. 対象外と実装境界

次は本仕様に含めない。

- 既存`prior_art_documents`、repository、APIの意味変更
- package parserからの直接DB書込
- API、UI、scheduler、通知、remote download、自動取得
- J-PlatPatの自動操作
- A5／P5のdocument保存またはfull publicationへの自動統合
- nested ST.26の内容保存
- description全文、raw XML／CSV、reference、画像、添付物の保存
- Production DBへのmigration適用、Production dataの読取・更新
- 公報内容からの法的結論

schemaとrepository coreは現行runtimeのAPI／schedulerへ未接続である。Production
migrationを適用していない環境でも、既存runtimeが新tableを参照してはならない。

## 8. 検証境界

公開repositoryの自動testは、完全な架空`KohoPackageParseResult`と架空文献だけを使う。
projection、除外条件、決定性、exact plan／document shape、7種のcanonical JSON、count
整合、issue順序／重複、source metadata path、content digest、DB row相当input、invalid
hash、duplicate path、empty plan、および公開型の後方互換性を確認する。raw XML、
description、reference、raw CSV、その他の未知fieldを追加したinputも拒否する。

実JPA／JPB ZIP、顧客・実案件資料、Production DB、secret、認証URLをfixture、Issue、PR、
commit、CI logへ含めない。実packageと一時Postgresを用いたupsert、replace、empty plan、
`createdAt`保持、rollback、constraint、retryは先行Local検証で確認済みである。本仕様の
境界検証では新しいDB test基盤やmock transactionを先制追加せず、pure regressionを中心に
確認する。
