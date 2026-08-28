# 09 Koho Corpus Case Connection Specification

## 1. 目的と状態

global公報corpusを公開番号、出願番号、発明名称で検索し、ユーザーが選択した
公報を案件単位の比較対象へ追加する契約を定める。結果は調査・比較・論点整理の
支援であり、法的判断ではない。

本仕様はruntime codeの契約である。Production DBへの公報migration適用、corpus
投入、Productionでの利用可能性、実画面確認、Azure resource／secret／runtime
環境変数の設定完了を意味しない。

## 2. Lifecycle境界

- `koho_import_runs`と`koho_import_documents`はcaseを持たないglobalな正本とする。
- ユーザーが選択した時点で、比較に必要な値を既存`prior_art_documents`へ
  snapshot copyする。global rowへの直接relationは追加しない。
- global rowの後続更新・削除を既存case snapshotへ自動反映しない。
- case削除はglobal corpusへ影響させない。
- 既存CSV／PDF／DOCX／TXT取り込みを置換しない。

## 3. 検索契約

`GET /api/cases/[caseId]/koho-corpus`

- `q`: trim後2〜100 Unicode code point。必須。
- `limit`: 未指定20。1〜50のASCII 10進整数。
- 重複parameterや範囲外値を拒否する。
- `publication_number`、`application_number`、`invention_title`を、大小文字差を
  吸収したliteral substringとして検索する。`%`、`_`、backslashをwildcardや
  escape命令として解釈しない。
- Postgres実装はbound parameterと`strpos(lower(column), lower(query)) > 0`を
  使用し、query文字列をSQLへ連結しない。
- 並び順は`publication_date` descending、`publication_number` ascending、
  `document_id` ascendingとし、その後にlimitを適用する。
- hitしたdocumentと親runを既存persistence contractで検証する。

成功responseは`{"items":[]}`で、各itemは次のfieldだけを持つ。

1. `documentId`
2. `packageType`
3. `parseStatus`
4. `kind`
5. `publicationNumber`
6. `applicationNumber`
7. `publicationDate`
8. `inventionTitle`
9. `abstractPreview`（nullまたは先頭300 Unicode code point）

claims全文、source/content hash、entry path、raw JSONは返さない。

## 4. Snapshot projection

選択したglobal documentから次の値だけを`prior_art_documents`へ写す。

- `caseId`: 対象case
- `publicationNo`: `publicationNumber`
- `title`: `inventionTitle`
- `abstract`: `abstractText`
- `claimsText`: `claimsText`
- `normalizedElementsJson`: `null`
- `sourceCsvRowJson`: 次のfield順を維持したcanonical JSON

```json
{
  "source": "koho-corpus",
  "packageType": "JPA",
  "sourceSha256": "lowercase-hex-64",
  "normalizedEntryPath": "normalized/path.xml",
  "parseStatus": "success",
  "kind": "A1",
  "publicationDate": "YYYYMMDD",
  "contentSha256": "lowercase-hex-64"
}
```

raw XML／CSV、description、reference、画像、添付、Applicant一覧、IPC／FI JSON、
parse issue message、source metadata JSONはsnapshotへ含めない。`publicationDate`は
8桁ASCII数字、両digestはlowercase hex 64文字でなければsnapshot化しない。

## 5. Mergeとtransaction

`POST /api/cases/[caseId]/koho-corpus`はexact
`{"documentIds":[1,2]}`を受け付ける。1〜50件のpositive safe integerとし、
余分なkey、欠損、空配列、重複IDを拒否する。

attachは単一Postgres transactionで次を行う。

1. 対象case rowを`FOR UPDATE`し、同一caseへの並行attachを直列化する。
2. 指定global IDを全件lookupし、親runを含む保存契約を検証する。
3. 欠損IDが1件でもあれば全体を拒否する。
4. 異なる選択documentが同じ公開番号なら曖昧として全体を拒否する。
5. 同一case・同一公開番号の既存snapshotを取得する。
6. 全snapshot fieldが一致すればunchanged、存在しなければinsert、差があれば
   同じ`docId`を維持してupdateする。
7. insertまたはupdateが1件以上あれば、同じtransactionで対象caseの
   `comparison_results`を全削除する。unchangedだけなら削除しない。

既存storageに同一case・同一公開番号の複数rowがある場合は任意の`docId`を選ばず、
storage invariant違反として利用不可にする。transaction中の失敗はprior artと
analysisの双方をrollbackする。

成功responseは次のexact fieldを持つ。

```json
{
  "selected": 2,
  "inserted": 1,
  "updated": 0,
  "unchanged": 1,
  "analysisCleared": true
}
```

`analysisCleared`は削除件数ではなく、比較対象が変わり無効化処理を実行したかを
表す。

## 6. Stable error

| 条件 | HTTP | code |
| --- | ---: | --- |
| 不正`q` | 400 | `invalid_query` |
| 不正`limit` | 400 | `invalid_limit` |
| 不正POST body | 400 | `invalid_request` |
| case不存在 | 404 | `case_not_found` |
| global document不存在 | 404 | `koho_document_not_found` |
| 同一公開番号の複数選択 | 409 | `ambiguous_publication_selection` |
| corpus table未準備、接続不能、persisted contract違反 | 503 | `koho_corpus_unavailable` |
| その他の予期しないhandler失敗 | 500 | `koho_corpus_internal_error` |

responseやlogへraw DB message、claims、entry path、hash、入力本文を出さない。

## 7. UI契約

案件詳細Step 4に「取り込み済み公報から追加（任意）」を表示する。

- 検索inputと明示的な検索buttonを設ける。
- page初期表示やtypingだけではAPIを呼ばない。
- loading、0件、client validation、storage unavailableを区別する。
- checkbox付き結果に公開番号、名称、公開日、kind、parse status、abstract previewを
  表示し、最大50件を追加できる。bulk select allは設けない。
- 成功時にinsert／update／unchanged件数を表示し、`router.refresh()`で既存表を
  更新する。
- `analysisCleared=true`なら重なり分析の再実行を案内する。
- 503時は「この環境では公報コーパスがまだ利用可能になっていません」と表示し、
  raw errorを表示しない。
- 自動検索、pagination、advanced filter、自動分析、公報詳細modalは追加しない。

## 8. 検証と情報安全

- testは完全な架空documentとfake repositoryだけを使用し、Production DBへ接続しない。
- validation、literal検索、deterministic sort、public response whitelist、canonical
  provenance、insert／update／unchanged、冪等性、conditional invalidation、rollback、
  stable errorを回帰化する。
- 実JPA／JPB package、顧客data、未公開資料、Production data、secret、個人pathを
  fixture、response、log、Issue、PRへ含めない。

## 9. Productionとrollback

`src/**`変更のmergeで既存CIとAzure Container Apps Deployが起動し得るが、本仕様の
実装はProduction migration、corpus投入、resource／secret／runtime設定を行わない。
storage未準備でもpage初期renderではcorpus queryを実行しない。ユーザーが明示検索・
追加した場合だけstableな503となる。

rollbackは実装PRのsquash commitをrevertし、API、UI、repository拡張、test、文書を
戻す。schemaとProduction dataを変更しないためdata rollbackは不要である。
