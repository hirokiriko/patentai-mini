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

### 2.1 documentの選択

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

### 2.2 document順と重複

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

JSON文字列は固定key順、配列はsource順で`JSON.stringify`する。保存するkeyは次に
限定する。

- applicants: `ordinal`、`sequenceNumber`、各nameの`value`、`sourceValue`、
  `originalLanguageIndicator`
- IPC／FI: `ordinal`、`role`、`value`、`sourceValue`
- parse issues: `code`、`status`、`field`。`message`は保存しない
- source metadata: `normalizedEntryPath`、`rootLocalName`、`rootNamespaceUri`、
  `schemaBasename`、`st96Version`、`ipoVersion`、`languageCode`、`xsdValidation`

parserが保持するsource snapshot、複数のsource表現、attributes、description、reference
等を便宜的にJSONへ追加してはならない。

### 3.2 content SHA-256

`contentSha256`は、`contentSha256`自身、DB ID、import IDを除く永続化document payload
全体を固定key順でJSON化したcanonical UTF-8 bytesから算出する。digestはlowercase
ASCII hex 64文字とし、同じinputの同じdocumentは常に同じ値になる。

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

`countsJson`は`KohoPackageCountSummary`を固定key順で再射影する。top-levelは
`primaryXmlCandidates`、`finalXmlResults`、`confirmedFullPublications`、
`confirmedAmendments`、`nestedXmlCandidates`、`documentFolders`、
`documentListRecords`、`roleCounts`、`bySection`の順とする。`roleCounts`は
`directory`、`xml`、`csv`、`schema`、`image`、`other`、`bySection`は`P_A1`、
`P_A5`、`P_P1`、`P_P5`、`P_B1`の順とする。各sectionは
`primaryXmlCandidates`、`finalXmlResults`、`confirmedFullPublications`、
`confirmedAmendments`、`documentFolders`、`contents1Records`、`contents2Records`、
`attachmentCount`、`roleCounts`の順とする。

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
（`success`／`review_required`）、kind、hash、pathの既知値を検証する。未知値を成功扱い
しない。

migrationは`drizzle-kit generate`で新規追加し、既存migrationを書き換えない。
Production DBへ`db:migrate`または`db:push`を実行しない。

## 6. repository transactionと冪等性

additiveな`KohoImportRepository`は少なくとも次を公開する。

- `savePlan(plan)`
- `findRunBySource(packageType, sourceSha256)`
- `findDocumentsByRunId(importId)`

`savePlan`は単一Postgres transactionで次を行う。

1. `(packageType, sourceSha256)`でrunをupsertする。
2. 既存runでは`createdAt`を保持し、status、counts、issues、`updatedAt`を更新する。
3. そのrunの既存documentを削除する。
4. plan documentを決定順でinsertする。
5. `{ run, savedDocumentCount }`としてrunと保存document件数を返す。

途中失敗時はrun更新、document削除、insertをすべてrollbackする。同じplanを繰り返し
保存しても同じrun IDを使い、run数とdocument数を増やさない。空document planはrunだけ
保存し、同じrunの既存documentを0件へ置換する。

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
projection、除外条件、決定性、invalid hash、duplicate path、empty plan、および公開型の
後方互換性を確認する。実JPA／JPB ZIP、顧客・実案件資料、Production DB、secret、
認証URLをfixture、Issue、PR、commit、CI logへ含めない。

実packageと一時Postgresを用いる全件保存、繰返し保存の冪等性、transaction rollbackは、
本Issue merge後のLocal検証で確認する。Local検証の公開記録には分類、件数、PASS／FAIL
だけを残し、実データの値や個人filesystem pathを転載しない。
