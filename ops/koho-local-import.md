# Local public-corpus import

## Manual preview and isolated Local apply — Issue #99

`scripts/koho-manual-import.ts` accepts newly acquired JPA/JPB issues without
fixed filenames or document counts. It reuses the package parser and immutable
repository save. This entrypoint is restricted to a dedicated Local PostgreSQL
16 test DB; it does **not** authorize production import. The Issue #89 script
and its approval, issue-number and expected-count restrictions remain intact.

### Private input and commands

Use the existing lockfile (`pnpm install --frozen-lockfile` when needed), then:

```sh
pnpm exec tsc -p scripts/koho-manual-import.tsconfig.json
node .koho-ops/manual/scripts/koho-manual-import.js
```

Supply one UTF-8 JSON object through a private pipe, then close stdin. Interactive
TTY input is refused. Input is limited to 262,144 bytes and ten seconds. Do not
pass configuration in arguments, environment variables, shell history or public
logs. Do not load an application `.env`. Keep inputs and the OS temporary
directory local and private to the operator; UNC and linked temporary directories
are rejected before snapshot creation. On Windows confirm the directory ACL (file
mode `0600` alone does not set a restrictive Windows ACL).

Exact schema (unknown keys are refused):

| Field | Type / validation |
| --- | --- |
| `mode` | Optional `preview` (default) or explicit `apply` |
| `files` | Array of 1–64 `{ "packageType": "JPA" \| "JPB", "path": string }` |
| `files[].path` | Explicit absolute local regular-file path, at most 32,768 characters; no UNC, symlink or linked parent directory |
| `maxFileBytes` | Required positive integer, at most 8 GiB; applies to every input file |
| `maxTotalBytes` | Required positive integer, at most 8 GiB; sum of all listed file sizes |
| `allowReviewRequired` | Optional boolean, default false; operator acknowledgement for this exact supplied list |
| `connection` | Apply only: exactly `{ host, port, database, user, password }` |
| `expectedTarget` | Apply only: exactly `{ host, port, database, user }`, independently supplied and equal to connection fields |

Preview refuses both connection objects. Apply host must be exactly `127.0.0.1`
or `::1`, port an integer 1–65535, database `koho_manual_import_test_` plus an
alphanumeric suffix (total at most 63 characters). User is a nonempty string of
at most 63 characters; password at most 8,192. No string may contain NUL. Other
connection options, connection strings and remote targets are refused before
connection. No saved/default DB connection or target discovery is used.

1. Preserve original downloads. Identify their actual format; bibliographic TSV,
   PAJ or unknown XML is not a body-publication ZIP. Do not rename another issue
   to satisfy an old filename restriction.
2. Run preview with explicit files and byte ceilings. Inspect package status,
   document review counts and the generalized package/XML issue counts. Preview
   uses no DB driver, connection or external network and saves nothing.
3. For Local apply, separately supply the dedicated target and least-privilege
   login. Require PG16, matching `current_database` / `current_user`, no recovery,
   management flags, role membership, DDL/ownership or unrelated data privileges.
   The login needs only CONNECT to this DB, USAGE on public, SELECT/INSERT on
   `koho_import_runs` / `koho_import_documents`, and USAGE on their two serial
   sequences. Revoke default PUBLIC database permissions in this isolated DB
   before granting the dedicated login. Never change a shared or production DB.
4. Set `allowReviewRequired: true` only after reviewing the generalized findings
   for the supplied list. The CLI repeats parsing and byte checks during apply.
   This flag preserves review status and is not a confidentiality or production
   authorization. A separate preview and apply have no cross-process content
   binding; no unchanged-input guarantee is claimed between those invocations.
5. Each input is copied exclusively to a unique operation-owned directory, with
   size and hash checks before/after parsing and an original-content recheck.
   The parser retains ZIP/XML/CSV and cumulative expansion limits. Files run
   sequentially in supervised child processes, under a batch-wide 120-minute
   processing budget, followed by bounded process/temporary-file cleanup waits
   of at most five seconds each. Unconfirmed OS filesystem cleanup is reported
   as required; a filesystem request cannot itself be cancelled by Node.
   Connection/statement/lock waits are 30/120/30 seconds.

### Output and recovery

Stdout is one public-safe JSON result; stderr does not carry raw worker/DB/parser
errors. Input correspondence is by one-based `ordinal`, never filename/path.
The summary contains only package/parse classifications, body/review/amendment/
attachment counts, generalized issue counts and publication dates.
`nestedSt26Count` retains the existing nested XML candidate count; nested content
is not treated as a body publication or newly asserted to be verified ST.26.

Publication date minimum/maximum and daily counts describe **only this input**.
They do not prove a complete week/month or consecutive-day coverage.
`savedRecordCount` counts newly committed records, not distinct patents across
ZIPs. `reused` retains every stored row and microsecond watch-cursor timestamp.
Unknown existing mismatches stop without overwrite.

| Per-input outcome | Meaning |
| --- | --- |
| `preview_not_saved` | Parser preview completed; nothing saved, including review packages |
| `inserted` | New package transaction acknowledged |
| `reused` | Existing source identity and all plan fields matched; no row/cursor changes |
| `review_not_saved` | Explicit review acknowledgement missing; nothing saved |
| `failed_before_save` | No committed save: admission/parser/target failure or acknowledged rollback |
| `save_outcome_unknown` | Save may have committed; reconciliation required, automatic resend zero |
| `not_processed` | Later input was not attempted |

`includesReviewRequired: true` means **要確認を含む保存** for inserted/reused
packages. Failed packages and review packages containing no confirmed bodies
are refused, including unsupported-only or inconsistent-index zero-body input.

Exit codes: `0` completed preview/apply; `1` invalid private input; `2` stopped
batch or cleanup requiring attention; `3` unknown save outcome. Earlier committed
packages remain after a later failure; there is no whole-batch rollback.
On a transport error, unacknowledged COMMIT, timeout or interrupted apply child,
do not resend blindly. A new explicit invocation may reuse only an existing
identity whose full immutable plan matches. Never clear the corpus, watch runs,
findings or cursor as recovery. `cleanup: required` needs removal of only this
operation's remaining temporary objects; preserve original files and other work.

### Verification and production boundary

```sh
pnpm exec vitest run scripts/koho-manual-import.test.ts scripts/koho-manual-import-transport.test.ts
pnpm exec vitest run scripts/koho-manual-import-local.test.ts
pnpm test
pnpm lint
pnpm type-check
pnpm build
git diff --check
```

The Local test suite is opt-in with `KOHO_MANUAL_LOCAL_DB_TEST=1` set only in its
process environment. It creates one uniquely named `postgres:16` container bound
to loopback, generates ephemeral credentials in memory, applies only existing
Drizzle migrations, runs compiled-CLI real saves and reconciliation, then removes
its own container/volumes/fixtures. Docker must already be running and the image
available. No saved Docker/DB credentials are read. Without opt-in the seven
Local cases are SKIP, separately from the pre-existing seven Issue #89 DB SKIPs.
Transport-loss tests are fakes, not claims of induced real network failures.

UI/browser/PDF/real AI/real-publication acquisition and production import are not
tested or enabled here. New schema, migration, dependency, HTTP endpoint and
runtime settings are unchanged. A scoped revert PR rolls back code only.
Future production use needs a separate approval for target, authentication,
cost and cleanup; do not call the legacy script to bypass the Local restriction.

### 実公報の手動更新手順 — Issue #106

1. **取得対象を選ぶ。** [公報発行サイトの公式操作ガイド（2026年3月、第2.00版）](https://www.gazette.jpo.go.jp/ci-content-pub/guide/operation_guide_jp.pdf)
   に従い、公開公報（特許）のJPAを優先し、必要なら登録公報（特許）のJPBを選ぶ。
   [特許情報標準データ](https://www.jpo.go.jp/system/laws/sesaku/data/keikajoho/index.html)の書誌・経過TSVや
   [PAJの英文抄録](https://www.jpo.go.jp/toppage/dictionary/alphabet_p.html)は本文XMLの代用にしない。
   取得経路の利用条件を確認し、公報原文や出願人一覧を公開作業記録へ転載しない。
2. **発行日と取得日を分ける。** 公報は原則毎開庁日に発行され、ZIP名の年＋一連番号は
   発行号を表す。docs/06の従来の「週次」という呼称や末尾番号を1週間分の根拠にしない。
   種別・年月の提供元一覧（必要なら公報発行表CSV）と前回の取得記録を照合し、対象期間の
   未取得号、遅れて掲載された号、差し替えを確認する。掲載日は確認できた場合だけ記録する。
3. **原本を保管してコピーを使う。** 複数選択の外側ZIPには複数の発行号ZIPが含まれ得る。
   外側ZIP名だけで形式や対象期間を決めず、内部のJPA/JPBごとに索引CSV・XMLを確認する。
   Git追跡外の保護領域へ排他的にコピーし、リンク先・容量・内容同一性を確認する。
   同一bytesの別名を新号に数えない。各作業の承認上限とCLIの上限を守る。
4. **previewを読む。** 上記のprivate stdinで現行CLIを実行し、種別、本文／要確認／補正／
   添付件数、未対応／失敗／未処理、公開日別件数を記録する。要確認の分類と必要最小の
   XMLを確認してから、その入力一覧にだけ`allowReviewRequired`を明示する。
   0件・未取得・未処理・失敗を「監視した結果の候補0件」に置き換えない。
5. **許可された隔離Local DBで保存を照合する。** CLIのLocal限定条件と最小権限を保ち、
   保存件数・status・公開日集計と限定した元XMLの請求項／要約／書誌を確認する。
   `inserted`は新規保存、`reused`は既存の全保存項目が一致した再利用である。
   検証として明示再applyする場合は整合確認後の1回だけとし、件数・`updated_at`不変を確認する。
   `save_outcome_unknown`では停止して読取照合し、自動再送しない。要確認は保存後も保持する。
6. **取得と報告の頻度を分ける。** 当面は週次取得・月次報告を手順案とする。公式ガイドでは
   公報発行サイトの発行後2年以上の公報は取得不可とされるが、実際の期間別一覧と欠落の照合は
   別途必要である。月次取得へ変える前に、使う提供経路で1か月分を取得できることを確認する。
   この保持条件を[登録型バルクサービス](https://www.jpo.go.jp/system/laws/sesaku/data/download.html)へ流用しない。
   入力の公開日min/maxや保存件数は期間網羅の証明ではない。現在の期間レポートは
   **監視実行開始日JST**で選択するため、公報公開日の期間指定と混同しない。

Localチェック表は「種別・発行号／発行日／掲載日（不明なら未確認）／取得日／
preview・保存・再利用状態／要確認等の件数／確認済み範囲／欠落・次回対応」で足りる。
提供元一覧と取得物の欠落照合には、対象種別・期間の発行号一覧と各号の取得記録が必要。
原本と過去成果物は残し、今回のDB・LOGIN・作業コピー・中間物だけを回収する。
この手順は本番継続投入、watch実行、実AI送信、自動取得・通知の承認ではない。

## Bounded acceptance import — Issue #89

`LOCAL_IMPORT_FIRST_V1` authorizes the bounded workflow in Issue #89. The Azure
benchmark in Issue #75 / PR #76 is deferred, not passed. This entrypoint creates
no Azure infrastructure. The synchronous public import API stays disabled.

The OWNER approved `PRODUCTION_FINISH_V2` on 2026-09-14. Prefer the existing
management route; if it cannot run the reviewed import within available
resources, one current-source IPv4 rule on the already-public target DB is
permitted. Verify its exact target, existing rules, create/delete permissions,
DNS/TCP/TLS and SQL identity. Keep a private pre-change/intent record and an
expiry no later than six hours; remove only this rule and read back its absence
and unchanged other settings. Unknown writes need reconciliation, not retries.
Historical fifth-attempt managed tracking UNKNOWN remains a separate accepted
residual subject to danger signals and reserves; new cleanup cannot use that
exception. No new Azure environment or public-access enablement is authorized.

## Operator procedure

1. Confirm the Issue's residual/cost, existing TLS target, backup, migration,
   single-writer and exact reviewed-code gates. Preserve cumulative attempts;
   never retry a write with an unknown outcome before read-only reconciliation.
2. Build with the existing dependencies:
   `pnpm exec tsc -p scripts/koho-production-import.tsconfig.json`.
3. Keep original packages unchanged. Copy them to an owner-only, Git-ignored
   input directory with restrictive Windows ACLs. Bind name/size/SHA-256 to the
   previously approved input record. The entrypoint creates a bounded exclusive
   snapshot underneath that protected directory, verifies it, and parses it.
4. Pass an `ImportConfiguration` JSON to
   `node .koho-ops/scripts/koho-production-import.js` through private stdin.
   Obtain legitimate credentials inside the Local owner process only. Never
   put configuration, credentials, hashes, source text or authenticated URLs
   in command arguments, terminal output, public logs, GitHub or `.env` files.
   Connection fields are host/port/database/user/password; `expectedTarget`
   independently binds host/port/database/user. Production mode requires all
   production gates. Fixture mode is restricted to an isolated named Local DB.
5. Run JPA then JPB once each, at most 120 minutes/package. Reserve the attempt
   durably before launch and terminate only its child on deadline. Retain
   aggregate outcomes and code/input bindings privately. Same-package reuse
   validates all stored fields without changing IDs or cursor timestamps.
   Package writes and the document-count check share one transaction.
6. Reconcile counts, parser classifications, cursor, restart/OOM status and
   connection closure. Preserve successful production corpus and migrations.
   Remove only operation-owned temporary roles/grants, snapshots, processes
   and fictional cases; never delete original packages or existing cases.

Production migration uses the existing Drizzle path for missing 0001/0002 only.
Do not regenerate migrations, use db:push, change shared ACL/RLS or exceed the
Issue's temporary network exception. App/import privileges stay narrowly scoped.

## Local verification

The real PostgreSQL suite takes `KOHO_LOCAL_DB_TEST_CONFIG` from the owner
process. It refuses non-loopback targets and unrelated database names. CI
explicitly skips it without that private configuration; CI success is not
real-DB evidence. It covers admission, least privileges, immutable reuse,
corrupt-state refusal, SQL-error and suppressed-insert rollback, and the shared
import/watch lock. Run it with:
`pnpm exec vitest run scripts/koho-production-import.test.ts`.

On 2026-09-13 the same JPA/JPB inputs saved 1,048/580 documents, totaling 1,628,
on isolated PostgreSQL 16. Both retain parser status `review_required`, with
1,045/580 documents so classified. JPA took 262,810ms with peak RSS
1,961,168KiB; JPB took 36,819ms with peak RSS 1,156,800KiB. DB growth was
4,079,616/1,867,776 bytes and measured WAL delta 3,999,336/1,914,360 bytes.
These are Local functional/capacity results, not Azure or production acceptance.
Exact bindings and raw local evidence are protected; no source identifiers or
original content belong here. Later targeted fixes require their own evidence.

## AI and user procedure

The four analysis/extraction/query operations establish a request budget.
Azure uses zero SDK retries and one outer attempt: watch needs at most two
normal sends for screening/detail; extraction and queries each need one fast
send. The guards retain their maximum ceilings. Issue-wide Local durable
reservations remain normal12/fast8 across requests/cases/processes. Unknown
sends remain consumed. This is not a new global customer billing system.

The Azure guard rejects external context/non-text inputs and output above8,192
before transport. Its serialized UTF-8 byte count plus8,192 framing reserve is
a conservative engineering estimate, not an official guarantee of the model's
final token count. Missing/noninteger usage, actual input above the estimate or
role threshold, or output above its requested cap stops subsequent sends.
Only reconciled numeric usage receipts can release a private cost reservation;
unknown/failed sends retain it. Explicit35-second abort signals reach the SDK;
budget/timeout stops fail watch without fallback or cursor advancement.
The effective serialized body ceilings are141,808 bytes for normal and41,808
bytes for fast requests, including system/schema. Long Japanese inputs or many
candidates can reach them before the model's token limit. Report that refusal;
do not silently discard input or candidates to obtain a passing acceptance run.

After production acceptance, use public/fictional data only: create a case,
input the draft, review extracted claims/search queries, search the corpus and
attach candidates. Save the watch start date, run manually, review findings,
save review status, reload, export CSV or open print view. Run again without
new imports to verify no duplicates or unnecessary AI call. These are the
eventual operating steps, not a claim that production/browser tests passed.
Customer-data acceptance, login, scheduling, notifications and automatic
acquisition remain outside this Issue.

The conditional revised reserve is JPY5,326: past five attempts1,574 + shared
uncovered1,500 + production execution/storage/cleanup1,000 + AI1,252. The
cancelled unexecuted Azure allocation is3,417 from the prior8,743 plan. This is
not a final invoice or a resource cleanup guarantee. Historical managed-resource
tracking remains unknown. Local TCP/TLS connectivity to the approved production
DB was unavailable on the bounded read-only check; no network change was made.

### V2 cost reservation

The JPY5326 figure above is historical, not a fixed quote. Retain past1574,
shared1500 and production/recovery1000 reserves. Refresh the remaining AI
forecast and reserve the worst model-context cost before each possible send.
Before an HTTP action that may make two sequential sends, reserve both; never
reset counters on a new request, case or process. Inspect fixed numeric
`ai_operation_usage` receipts privately after each action. Missing receipts,
unknown sends or excess usage stop the next action without releasing reserve.

The verified model specifications are gpt-5.4 (2026-03-05), context1050000 /
input922000, and gpt-5.4-mini (2026-03-17), context400000 / input272000.
Conservatively charging the entire context as input plus8192 output gives
USD5.43432 / USD0.336864 per send, using high normal rates5/22.5 and mini
rates0.75/4.5 per million input/output tokens. Round up and apply the recorded
conservative currency/tax factors; cached discounts are not assumed. Reconcile
only measured usage below the original estimate and preserve future work's
forecast within the JPY9000 gate. This is a bounded operator acceptance process,
not a guarantee for future customer spending or a mathematical input-token cap.

Sources: [Microsoft model limits](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-sold-directly-by-azure?pivots=azure-openai#gpt-54),
[normal pricing](https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/introducing-gpt-5-4-in-microsoft-foundry/4499785),
[mini pricing](https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/introducing-openai%E2%80%99s-gpt-5-4-mini-and-gpt-5-4-nano-for-low-latency-ai/4500569).

### Issue #101: 完全架空データのwatch/report結合試験

`WATCH_REPORT_LOCAL_DB_TEST=1 pnpm exec vitest run scripts/watch-report-local.test.tsx` を明示実行する。既存Dockerと公開postgres:16 imageを使い、新規loopback専用DBだけへ既存migrationを適用する。保存済み.envは読み込まず、製品DATABASE_URLやPGHOST/PGSERVICEが設定されたprocessは開始前に拒否する。資格情報はランダム生成し、CLIへprivate stdin、Dockerへ必要なchild envだけで渡す。import/watch/reportは別LOGINで、reportはSELECTだけ。元ZIP、cursor、確認状態、失敗履歴を検証し、外部AIは呼ばない。

通常suiteではこの5件をSKIPし、専用実行を別記する。既存の通常14 SKIPや#99受入を成功へ読み替えない。previewは親と解析workerの接続0回を測定する。実repository/service/handler/pageを使い、DB moduleだけを専用実PGへ差し替える。AI応答は既存service DIで固定し、製品のmock endpoint/env switchは追加しない。境界・上限は別のnegative-control案件へ直接配置し、不正analysis JSONは架空候補の元値を保存して試験後に復元する。

追加で`WATCH_REPORT_BROWSER=1`を指定すると、最後のtestが30分以内のloopback確認用serverを保持する。`.koho-ops/issue101/browser.json`のURLを開く。案件の確認状態変更・再読込・監視、候補あり/正常0/失敗/実行中/失敗混在/未実行の出力を確認する。監視sectionと期間viewのclient操作は本物のcomponent、単一runは本物PageのSSRで、印刷ボタンへのevent接続だけは薄いharnessである。期間queryは重複も保持して本物Pageへ渡し、同じ取得結果を描画する。

browser印刷で長い日本語の期間PDFと失敗警告PDFを実保存し、別rendererの全ページ表示と抽出textで件数・期間・警告を照合する。headless印刷とOS印刷ダイアログを区別し、実AI精度/専門家受入の証明にしない。完了時はbrowser.jsonに書かれた今回専用`finishFile`を同じdirectoryに作成する。server/接続/今回のownership labelに一致するcontainerとvolumeを回収し、不存在を確認する。応答不明のcreateを再送しない。生成したDB内LOGINもcontainerとともに回収する。完成PDFと短い操作メモだけをGit追跡外Localへ残し、中間画像/fixture/専用profile/確認tabを回収する。

本試験は本番取込・追加Azure操作を許可しない。次の実案件工程には、実公報の形式・対象期間・適用条件、本番継続取込の対象/上限/権限/停止条件と回収範囲、#93の原障害・実AI確認、自社/他社識別と自己案件除外、専門家評価の承認・受入条件が別途必要となる。

### Issue #109: 監視POSTの固定停止診断

新たに許可された監視を実行したときだけ、同じPOST応答の `X-Patent-Watch-Diagnostic-Id` と、`watch_ai_stopped` bodyの任意 `diagnostic.id/stage/reason` を確認する。画面には検証済みの停止段階・固定分類・照合用番号を示す。診断なしや通信断は未確認のまま保持し、番号を過去runへ付け直さない。保存済み情報のGET再読込は監視を再実行しない。

同じIDの固定ログは対応材料であり、完全な履歴・送信完了・実請求額の証明ではない。ログ照会は別途許可された対象と範囲だけで行う。本実装を理由に案件作成/有料再送/旧ログ探索を開始せず、既存の予約・消費回数をリセットしない。過去のIDなしログから原因を逆算しない。

Local回帰は `pnpm test src/lib/ai-operation-budget-diagnostic.test.ts src/lib/patent-watch/diagnostic-sdk.test.ts src/lib/patent-watch/diagnostic-context.test.ts`。現行SDK→guardまで実装を使い、transport末端とrepositoryだけ完全架空に置換する。実.env/AI/DB/Azureは不要。loopback専用の既存watch browser fixtureにはdiagnostic-screening/detail/invalid/get-onlyを用意し、今回表示・保存済み履歴・ブラウザ再読込・GET 2/POST 1を確認する。

### Issue #116: 公報発行表の期間別確認一覧

`src/lib/koho-distribution-table` の `parseDistributionTable({ bytes, packageType, from?, to? })` は、呼出し側が渡したJPA/JPB発行表CSVの確認用関数である。ネットワーク、ファイル出力、DB、CLI実行を持たず、既存の取込CLI/APIには未接続。公式metadataの取得や本番取込を開始する操作ではない。

profile `jpo-2026-09-21` は、#115で観測した種別別11列headerと列順を固定する。入力最大1MiB、data最大10000論理CSVレコード、field最大16384 Unicodeコードポイント。UTF-8をstrict decodeし、先頭BOMあり/なし、LF/CRLF、正しく引用したcomma/quote/改行を受ける。引用符外の単独CRはエラー、引用符内のCRは元値として保持する。header/列数/日付/数字桁数/可否/同一snapshot内の号キー重複を検証し、未知の形式は修復・推測しない。headerはerror位置のrow 0、data ordinalは1起算で、引用符内の物理改行はordinalを増やさない。

番号・号の先頭0とraw値を保持する。JPAの番号範囲が空でも日件数は非0の場合があり、空を0に置き換えない。片側範囲欠損・範囲逆転、JPBの飛び番/回復内重複、発行日の逆順は警告として元値/元順を保持する。番号範囲の差や飛び番の加減を日件数との一致条件にしない。JPBの登録日は公報発行日と別に保持する。

期間指定は両端inclusiveの公報発行日で行い、可/不可の全対象行を返す。`sourceRowCount` / `observedDateRange` はsnapshot全体、`counts` は指定対象、`warnings` は期間外も含む元表の警告と期間警告。0行は `no_rows_in_snapshot` であり、正常0候補や未発行を意味しない。0bytesは `missing_header`、正しいheaderだけなら成功・範囲null・`no_observed_dates`。常に `coverageProven:false` / `acquisitionState:unknown` / `importState:unknown` を返す。

成功値のraw field・notes・`sourceSha256` はprivate callerの参照用であり、API/画面/log/GitHubへそのまま送らない。hashは入力bytesの同一性であり配布元署名ではない。失敗は固定codeと任意の行/列だけを返し、native parser例外を公開しない。入力はbytesだけで、発行表行と実取得物・receiptの対応を確認する機能は別工程。

Local回帰は `pnpm test src/lib/koho-distribution-table/index.test.ts`。fixtureは完全架空で、実CSVや実hashを追跡しない。本moduleは取得可否表示から実取得・DB反映・訂正版を含む網羅を認定せず、既存CLI/DB/watch動作を変更しない。[JPO操作ガイド](https://www.gazette.jpo.go.jp/ci-content-pub/guide/operation_guide_jp.pdf)の発行表取得/ZIP命名と、今回snapshotの観測profileを区別する。

### Issue #114: 手動CLIの非公開実行記録

private stdinへ任意の `receipt: { path: absoluteLocalPath, privateDirectoryConfirmed: true }` を加えると、処理した入力bytesと結果をUTF-8 JSONLで記録する。省略時のstdout・exit codeは従来どおり。指定時だけstdoutに `receiptStatus: complete | incomplete` が加わる。receiptのpath・実行ID・hashはstdoutへ出さない。stdinや資格情報を端末の履歴・argvへ貼らない。

操作者が既存の専用保護directoryを選ぶ。Git管理・クラウド同期・共有対象から外し、他の利用者が読めない権限を確認する。POSIXは実行uid所有でgroup/other権限なしの親が必要。Windowsでは0600でACLを保証できないため、`privateDirectoryConfirmed` は操作者がACLを確認した宣言であり、CLIによる機械的検査ではない。CLIはdirectory作成・ACL変更をしない。既存file、リンク親、UNC/相対path、入力fileと同じpathは使えない。Windowsの出力はdriveから始まる完全なpathとし、NTFS代替stream、device名、末尾dot/spaceの別名を拒否する。原本を移動・改名する必要はない。

receiptは新規fileを排他的に作り、1record最大16KiB、全体最大1MiB。全recordにschemaVersion=1、operationId（ランダムUUID）、sequence（1始まり連番）、type、observedAt（Local時計のUTC ISO）を含む。

| type | 記録する内容 |
| --- | --- |
| batch_started | mode、fileCount、filesのordinal/packageType |
| input_verified | ordinal/packageType、実測byteLength/sha256。解析後にsnapshotと原本の双方を再hashできた場合だけ |
| file_finished | 全ordinalを順に各1回。outcome、保存件数、要確認の有無、cleanup。入力確認済みの場合だけ固定summary（一般化件数・入力公報の公開日min/max、日別配列なし） |
| batch_finished | 全ordinal終了後のstatus、cleanup、inserted分だけのsavedRecordCount |

親がinput_verifiedを全量write+syncして成功ACKを返すまで、workerはDB driverのロード・保存へ進まない。解析がfailed判定でも両再hashが完了したbytesは確認済みになり得る。例外や再hash未完了の場合はbindingを補完せず、未処理の入力を後からhashしない。未確認summaryを0件で補造しない。

`receiptStatus=complete` はwrite/sync/close成功応答を受けた意味で、DB保存成功や期間網羅の意味ではない。要確認で保存拒否・保存不明でも、記録を完了できる。逆にDBのinserted/reusedが確認できた後で記録だけ失敗することもある。その場合は保存結果を保持し、receipt incomplete・後続未処理として停止する。保存不明はexit3を優先し、それ以外の記録不全はexit2。snapshot cleanup不明は別途requiredのまま残す。

終了行があっても、その直後のsync/close応答失敗や中断でstdoutがincompleteになり得る。fileの終了行だけから実行成功を逆算しない。途中までのreceiptは自動修復・削除・追記せず保存する。操作者が保存結果を確認して再実行する場合は新しいpath・新しい操作とし、既存の同一bytes再利用規則を使う。自動retryはしない。

receiptには接続先を保存しないため、保存先DBや現在のDB状態の証明にはならない。正規配布一覧、取得日時、発行号や改訂、期間全体の網羅も示さない。接続資格情報、入力path/filename、原文、XML member、出願人、案件情報は記録対象外。receiptやhashはIssue/PR、ログ、CI artifactへ掲載しない。後日の照合reader、自動取得、production importerへの接続は別工程。

回帰は `pnpm test scripts/koho-manual-import-receipt.test.ts scripts/koho-manual-import.test.ts scripts/koho-manual-import-source.test.ts scripts/koho-manual-import-transport.test.ts`。完全架空のcompiled CLIを使い、保存前の記録失敗、短いwrite、保存成功後の記録不全、sync/close失敗、中断後の遅いACK抑止、公開結果への私的field混入防止を検証する。DB stubの成功は実DB受入に数えない。

`KOHO_MANUAL_LOCAL_DB_TEST=1 pnpm test scripts/koho-manual-import-local.test.ts --testTimeout 60000` の既存隔離PG16試験は8件。新しい一時loopback containerだけへ既存migrationを適用し、実commit後のreceipt失敗、後続未処理、新pathでのreused/inserted、再実行のDB不変を追加確認する。通常CIでのSKIPを成功にしない。入力とreceiptはfixtureのものだけを回収し、運用receipt・本番DBを削除しない。
