# 公報package手動取込API仕様

## 1. 目的と境界

`POST /api/admin/koho-imports`は、管理者が明示的に送信したJPA／JPBのZIP packageを既存の公報取込基盤へ保存するための最小手動経路である。

処理順は次に固定する。

1. 管理設定とBearer tokenを検証する。
2. query、Content-Type、Content-Lengthをbody読取前に検証する。
3. raw ZIP bodyをOS一時領域へbounded streamingし、同じchunk列からSHA-256を算出する。
4. `parseKohoPackage`でpackageを解析する。
5. `success`または`review_required`の場合だけ`buildKohoImportPlan`を実行する。
6. `KohoImportRepository.savePlan`で既存のtransactional／idempotent契約に従って保存する。
7. 成否にかかわらず一時fileと専用directoryを削除する。

UI、一覧、GET／DELETE、scheduler、自動取得、J-PlatPat自動操作、Production migration適用は対象外である。

## 2. disabled-by-defaultと認証

次の両方が正しく設定されるまでendpointは`503 koho_import_disabled`を返し、request body、一時file、parser、DBへ触れない。

- `KOHO_IMPORT_ADMIN_TOKEN`: UTF-8で32 byte以上
- `KOHO_IMPORT_MAX_SOURCE_BYTES`: 1以上64 GiB以下の10進safe integer

認証は`Authorization: Bearer <token>`を必須とする。受領tokenと設定tokenをそれぞれSHA-256の固定長digestへ変換し、constant-time比較する。認証失敗は`401 unauthorized`であり、body以降へ進まない。

環境変数値、Authorization header、token長、digestをresponse、log、errorへ出さない。

## 3. Request

### endpoint

```text
POST /api/admin/koho-imports?packageType=JPA
POST /api/admin/koho-imports?packageType=JPB
```

`packageType`はexactに1件だけ指定し、`JPA`または`JPB`だけを許可する。

### body

bodyはZIPそのもののraw bytesとする。許可するbase media typeは次だけで、media type parameterは許容する。

- `application/zip`
- `application/octet-stream`

multipart、`formData()`、`arrayBuffer()`、`File`化、body全体の単一Buffer化は行わない。

`Content-Length`がある場合はpositive safe integerだけを受理し、設定上限超過はbodyを読まず`413 package_too_large`とする。headerがないchunked bodyは許可し、実測byte数で同じ上限を強制する。

## 4. bounded streamingとcleanup

bodyはWeb streamを逐次読み、`mkdtemp`で作ったOS一時directory内のexclusive／owner-only fileへchunk単位で書く。元file名やrequest由来file名は利用しない。

各chunkについて、上限との差分でoverflow-safeにbyte数を確認してから書き込み、同じchunkでSHA-256を更新する。設定上限を1 byteでも超える場合は追加の読取・書込を停止して`413 package_too_large`とする。

- 0 byte: `400 empty_body`
- 宣言Content-Lengthと実測値の不一致: `400 content_length_mismatch`
- 完了時SHA-256: lowercase ASCII hex 64文字

成功、request abort、stream error、limit超過、parser／validation／storage errorの全経路でfile handleを閉じ、一時fileと専用directoryを削除する。cleanup完了を確認できない場合は成功responseを返さず、入力値やpathを含まない`500 koho_import_internal_error`とする。raw ZIPはDB、Blob、repository、artifactへ永続化しない。

## 5. Package limits

`KOHO_IMPORT_MAX_SOURCE_BYTES`を`S`とする。全limitはpositive finite safe integerであり、無制限値や`Infinity`を使用しない。

### ZIP

| field | value |
| --- | ---: |
| `maxSourceBytes` | `S` |
| `maxCentralDirectoryBytes` | `min(S, 134217728)` |
| `maxEntries` | `250000` |
| `maxTotalCompressedBytes` | `S` |
| `maxTotalUncompressedBytes` | `S * 8` |
| `maxEntryCompressedBytes` | `min(S, 2147483648)` |
| `maxEntryUncompressedBytes` | `2147483648` |
| `maxTotalReadUncompressedBytes` | `S * 4` |

### CSV

| field | value |
| --- | ---: |
| `maxInputBytes` | `134217728` |
| `maxRecords` | `250000` |
| `maxColumnsPerRecord` | `512` |
| `maxCellCharacters` | `8388608` |
| `maxTotalCharacters` | `268435456` |

### XML

| field | value |
| --- | ---: |
| `maxXmlBytes` | `67108864` |
| `maxDepth` | `256` |
| `maxElements` | `5000000` |
| `maxTextBytes` | `67108864` |

`S`の設定上限を64 GiBに限定するため、`S * 8`を含む全値はJavaScript safe integer内に収まる。

## 6. Import semantics

validation済み一時fileに対して次を実行する。

```text
parseKohoPackage
  -> package status check
  -> buildKohoImportPlan
  -> KohoImportRepository.savePlan
```

- `success`: 保存する
- `review_required`: 保存する
- `failed`: 保存せず`422 package_parse_failed`
- builder／persistence contractのtyped validation error: `422 package_validation_failed`
- repository保存失敗: `503 koho_import_storage_unavailable`
- その他の予期しない失敗: `500 koho_import_internal_error`

既存のsource SHA-256をidempotency keyに用いるため、同じpackageを再送してもrepositoryの既存runを再利用する。

## 7. Response

成功は新規・再送とも`200`で、次のfieldだけを返す。

```json
{
  "packageType": "JPA",
  "packageStatus": "review_required",
  "sourceSha256": "lowercase-hex-64",
  "importId": 1,
  "documentCount": 1,
  "savedDocumentCount": 1,
  "amendmentCount": 0,
  "nestedSt26Count": 0
}
```

file名、entry path、公報番号、出願番号、title、applicant、claims、abstract、issue message、raw JSON、temp pathは返さない。

error bodyは`{"error":"stable_code"}`だけとし、入力値やlibrary／DB messageを返さない。

## 8. Stable error codes

| HTTP | code |
| ---: | --- |
| 503 | `koho_import_disabled` |
| 401 | `unauthorized` |
| 400 | `invalid_package_type` |
| 415 | `unsupported_content_type` |
| 400 | `invalid_content_length` |
| 413 | `package_too_large` |
| 400 | `empty_body` |
| 400 | `content_length_mismatch` |
| 422 | `package_parse_failed` |
| 422 | `package_validation_failed` |
| 503 | `koho_import_storage_unavailable` |
| 500 | `koho_import_internal_error` |

## 9. Production有効化前提

コードがmainへ入っても、Productionで次を完了するまでは本endpointを有効化しない。

1. `koho_import_runs`／`koho_import_documents`を含む承認済みmigrationをProduction DBへ適用する。
2. `KOHO_IMPORT_ADMIN_TOKEN`と`KOHO_IMPORT_MAX_SOURCE_BYTES`をProduction runtimeへ安全に設定する。
3. Local検証Issueで実JPA／JPB package、一時Postgres、cleanup、冪等性、既存API非回帰を確認する。

この仕様自体はProduction DB、Azure resource、secret、環境変数を変更しない。

## 10. Rollback

API route、server-only helper、test、文書更新を含む変更commitをrevertする。schema／migrationやProduction dataを変更しないため、この変更単独のdata rollbackは不要である。
