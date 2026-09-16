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
