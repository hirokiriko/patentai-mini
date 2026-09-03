# private staging one-shot 公報取込 Job Runbook

## 1. 目的と適用範囲

本書は、公開 JPA／JPB package を private Blob から ingress のない手動起動
Azure Container Apps Job へ一つずつ渡し、Production から分離した本 Issue 専用の
staging PostgreSQL DB で公報取込の成立性を測定するための Runbook である。

処理経路は次に固定する。

```text
private Blob の 1 object
  -> ingress なし／manual trigger の one-shot Job
  -> 127.0.0.1 だけで待ち受ける Next.js child
  -> POST /api/admin/koho-imports
  -> parseKohoPackage
  -> buildKohoImportPlan
  -> KohoImportRepository.savePlan
  -> Production から分離した専用 staging DB
```

Job runner は既存 application image 内の
`node scripts/koho-job/runner.mjs` とする。runner は Blob を bounded streaming し、
内部で生成した一時 token を使って loopback の manual handler へ一度だけ POST する。
child は `node scripts/koho-job/server.mjs` の専用 Node HTTP server とし、外部 interface では
待ち受けず、finite request timeout を強制する。
manual handler が既存の exclusive temp file、同一 stream からの SHA-256 算出、
parser／builder／repository、transaction、stable error、cleanup 契約を担当する。
runner と handler のどちらも package 全体の単一 Buffer 化、package 全展開、複数 package の
同時処理を行わない。

本手順は Production activation ではない。次は行わない。

- Production DB の migration、query、書込み、corpus 投入、watch 実行
- Production Container App の設定、revision、secret、env、ingress の変更
- Production Container App の対話 console、`/bin/sh`、`/bin/bash` への接続
- Production manual HTTP import endpoint の有効化
- scheduler、queue、checkpoint、自動取得、自動 retry の追加
- 既存顧客 data、案件、upload、Blob object の閲覧または変更
- subscription budget、課金契約、quota の変更

benchmark の Azure 操作は Production を変更しない。一方、後日 public code を `main` へ
merge すると既存 workflow により Production application image の deploy が起動し得る。
その場合も runner は明示的な Job command なしには起動せず、migration、import、watch、
manual endpoint 有効化を自動開始しない構成でなければならない。

## 2. 情報安全と記録先

次は Local の非公開作業記録と Azure の secret 機構だけで扱い、Issue、PR、commit、
Actions log、repository file、公開 artifact へ記録しない。

- secret、credential、SAS、認証付き URL、接続文字列、token
- Azure resource の実名、resource ID、subscription／tenant 固有値
- Local path、元 file／copy 先、実 package の size／SHA-256
- raw ZIP／XML／CSV、entry path、source／content hash
- 個別公報値、publication／application number、title、applicant、claims
- Production 情報、DB error、Azure error、child の raw stdout／stderr／stack

Local 記録にも secret の値そのものは残さない。必要なのは、確認者、時刻、対象の
一意性、照合結果、aggregate、PASS／FAIL／UNKNOWN である。画面 capture を公開記録へ
添付する場合は、上記情報が一切写っていないことを目視確認する。

公開してよい記録は、branch／exact commit SHA、開始・終了日時、安全な aggregate、
各 gate の PASS／FAIL、4,500 円 gate／5,000 円上限内外、GO／NO-GO、cleanup の
残留件数だけである。公開が不適切な aggregate は数値を出さず「上限内」または
「上限超過」と記録する。

Job の stdout は runner が出す最終 aggregate JSON 1 行だけを利用する。response 全体、
特に manual handler が返す `sourceSha256` を出力してはならない。child の stdout／stderr
は drain するが公開 log へ転送しない。Azure 側で既定の platform log が出る場合も、
公開前に同じ禁止情報がないことを検査する。

最終 aggregate は private Job log／Local 検証では安全な field に限定されるが、その数値を
無条件に GitHub へ転載してよいという意味ではない。`networkBytes` や `peakTempBytes` が実
package size を実質的に示す場合、公開記録では数値を伏せて「上限内／上限超過」だけにする。

## 3. fail-closed の開始条件

次をすべて確認できる場合だけ provisioning に進む。一つでも未確認なら resource を
作らず、一般化した理由だけを Issue に記録して `codex:blocked` で停止する。

- latest `main`、作業 branch の base、実行対象 exact SHA が確定している。
- Issue #74 の完了記録を確認している。
- `AGENTS.md`、`CLAUDE.md`、関連する公報取込仕様と Azure 運用文書を確認している。
- Open `codex:automation-pause` が 0 件である。
- 同目的の Open Issue、branch、PR、別 worker がない。
- Azure Portal の既存正規認証 session が利用でき、正しい tenant／subscription を
  read-only で識別できる。
- Issue #74 で使用した read-only Production 監査経路が利用できる。ただし Production
  Container App の console や shell は開かない。
- 本 Issue 専用 resource を既存 resource から一意に区別する naming／tag 計画と削除期限が
  ある。
- worst-case 費用見積りが 4,500 円以下である。

Azure 認証 session を利用できない場合、credential の作成・共有・再発行、権限変更、
Azure CLI／extension／browser connector 等の install へ迂回しない。既存の承認済み経路
だけで続行できなければ停止する。

開始条件成立後にだけ Issue から `codex:blocked` を外し、`codex:in-progress` を付ける。
公開コメントには baseline SHA、branch、開始日時、絶対上限 5,000 円を記録し、Azure の
実名や Local 情報は記録しない。

## 4. 費用 gate

### 4.1 provisioning 前の確定 envelope

本 benchmark の既報 worst-case 見積りは **4,100 円**であり、開始 gate **4,500 円以下**を
満たす。前提は次に固定する。固有 resource 名、課金 ID、単価明細は公開しない。

| 項目 | 見積り上限／構成 |
| --- | --- |
| region | Japan East |
| Container Apps Job | 2 vCPU／4 GiB、ephemeral 8 GiB |
| package execution | calibration、JPA、JPB、許可され得る full package 再実行を最大 4 回、各最大 120 分 |
| migration／observer | 必須 execution の compute／log／DB 利用を 4,100 円内へ織込み済み。別枠で加算しない |
| PostgreSQL | Burstable B2s、storage 32 GB、HA なし、storage autogrow なし |
| private Blob | 全 object 合計 10 GB 以下、保持 48 時間以下 |
| ACR | Basic、保持 3 日以下、image 合計 10 GB 以下 |
| log／metric | ingestion／保持対象 1 GB 以下 |
| external egress | 合計 20 GB 以下 |

4,100 円には provisioning から削除反映までの compute／storage／backup、Container Apps
Environment、Job、migration／observer、Blob transaction、registry、network、log、未確定
meter、税・為替・削除遅延の保守的余裕を含む。package execution の回数上限とは別に
migration／observer を実行してよいが、その実測と残存見込みは 4,100 円の envelope から
差し引き、無予算の追加 execution として扱わない。

provisioning 直前に Portal の現行価格表示または公式 calculator で同じ前提を再確認する。
region、shape、tier、容量、保持期間、HA、autogrow、実行回数、timeout、log、egress の
いずれかが表を超える場合は再計算し、worst-case が **4,500 円以下**と確認できるまで開始
しない。絶対上限は **5,000 円**で、4,500 円との差額 500 円は追加作業枠ではなく、meter
遅延等の安全余裕である。

### 4.2 実行前後

各 execution の直前と直後に次を更新する。

```text
確定済み利用料
+ 未確定利用の保守的見積り
+ 現在残っている resource を削除完了まで保持した場合の最大見込み
+ 次の execution の worst-case
```

この合計が 5,000 円へ達し得る場合、新しい execution を開始しない。active execution を
増やさず target-only cleanup へ移り、NO-GO とする。4,100 円の前提から外れた、価格情報を
取得できない、または見積り根拠を確定できない場合も同じである。

## 5. resource inventory と一意性

既存 subscription、既存正規認証 session、Issue #74 の read-only Production 監査経路以外は
共有 resource を利用しない。benchmark の data plane／control plane resource はすべて本
Issue 専用に新規作成し、専用 Resource Group の配下へ置く。

作成前に非公開 inventory を用意し、親子関係、作成時刻、Issue 識別用の非機密 tag、削除期限、
費用上限を記録する。最低限、次を追跡する。

- 専用 Resource Group
- 専用 Storage Account、private Blob container、calibration／JPA／JPB object
- 専用 Azure Container Registry と exact-SHA image tag／manifest
- 専用 Container Apps Environment と専用 log／metric resource
- 専用 PostgreSQL server、database、user、network rule
- manual-trigger Container Apps Job と migration／observer／package execution
- Job secret、object read-only SAS、DB credential
- 本 Issue 専用 role assignment

Production resource、既存 Storage Account／container、既存 ACR、既存 Container Apps
Environment／Log Analytics workspace、既存 PostgreSQL、既存 identity／role assignment を
参照・再利用・変更しない。専用 resource の所有関係や対象の一意性を確認できない場合は
provisioning／execution／削除を進めず、`codex:blocked` として人手確認へ渡す。

Portal では専用 Resource Group を最初に作り、その配下へ専用 log resource と Container Apps
Environment、Storage Account／private container、Basic ACR、PostgreSQL server／database、
manual Job の順に作る。Job 用 identity／image pull role、Job secret、object SAS は親 resource
作成後に追加する。各画面で Resource Group が専用親と一致することを確認してから保存し、
既存 resource を候補から選ばない。region は Japan East に固定する。作成のたびに inventory
へ親子関係と費用見込みを追記し、次の resource を作る前に 5,000 円 stop gate を再評価する。

## 6. clean context と exact SHA image

### 6.1 build context gate

latest `main` から作った専用 branch の実行対象 commit を固定し、build 前に次を確認する。
command output に Local path が含まれる場合は公開記録へ転載しない。

```powershell
git status --porcelain=v1 --untracked-files=all
git diff --exit-code
git diff --cached --exit-code
git rev-parse HEAD
git ls-files --others --ignored --exclude-standard
```

- tracked の unstaged／staged diff が 0 である。
- untracked file が 0 である。
- ignored file／directory を全件確認し、secret、`.env`、実 package、download、DB dump、
  credential、Local test output が build context に入らない。
- `.dockerignore` が少なくとも `.git`、`.github`、dependency／build／coverage、`data`、
  `.env`／`.env.*`、debug log、Local package artifact を除外することを確認する。
- `.agents`、`.codex`、`.claude`、`.tools` 等の Local agent／tooling directory は context に
  存在しないか `.dockerignore` で除外されている。
- `Dockerfile` の `COPY` 対象と `.dockerignore` を突き合わせ、git ignored だが Docker では
  含まれる file がない。

ignored item が存在しても自動的に安全とはみなさない。`.dockerignore` で除外されない Local
artifact が一つでもある場合は build しない。本 Issue の許可範囲外で `.dockerignore` を変更せず、
clean な exact-commit context を用意できなければ停止する。

working tree を直接 Docker context にせず、固定 SHA の tracked tree だけを repository 外の
新規 temporary directory へ export する。概念手順は次のとおりで、実際の temporary path は
公開しない。

```powershell
$exactSha = (git rev-parse HEAD).Trim()
$buildRoot = Join-Path ([IO.Path]::GetTempPath()) ("patentai-issue75-build-" + [guid]::NewGuid())
$contextRoot = Join-Path $buildRoot 'context'
$archivePath = Join-Path $buildRoot 'context.tar'
New-Item -ItemType Directory -Path $contextRoot | Out-Null
git archive --format=tar --output=$archivePath $exactSha
tar -xf $archivePath -C $contextRoot
Remove-Item -LiteralPath $archivePath
```

export 後に、context が repository 外であること、tracked exact SHA 由来の file だけであること、
untracked／ignored file が 0、`.dockerignore` が含まれ適用されることを再確認する。image build
完了後は resolved `$buildRoot` が OS temporary directory 内の当該新規 directory と exact 一致
することを確認してから、`Remove-Item -LiteralPath $buildRoot -Recurse -Force` で削除する。

### 6.2 image gate

1. clean と確認した exact commit だけから、専用 ACR へ image を build／pushする。
2. commit SHA 全体を含む一意な tag を付け、`latest` や mutable tag を付けない。
3. build input の commit SHA、registry tag、push 後の manifest digest の三者対応を Local
   inventory へ記録する。
4. Job 作成時と各 execution 直前に、tag が同じ digest を解決し、その digest が inventory と
   一致することを確認する。
5. image の合計容量が 10 GB 以下で、実 package、credential、Local artifact が layer に
   混入していないことを確認する。

専用 ACR は Basic とし、作成から削除まで 3 日以内、全 image／layer の合計 10 GB 以下を
維持する。tag、manifest、layer の残留を ACR 削除前後に確認する。

既存 build workflow が image push と Production Container App 更新を一体で行う場合、その
workflow を本 benchmark の image 作成に使用しない。Production を更新せず、本 Issue 専用の
新規 ACR へ exact-SHA image だけを作成できる承認済み build／push 手段がなければ、共有 Azure
resource、迂回経路、workflow 変更を追加せず停止する。

## 7. private Blob staging

### 7.1 Local source の確定

Local の既存 download／作業領域から `JPA_2026155.ZIP` と `JPB_2026155.ZIP` を、file 名、
拡張子、更新日時、過去成果物との整合で一意に特定する。元 file は移動、削除、改名、
上書きしない。複数候補が残り一意に決められない場合だけユーザーへ確認する。

元 file の size と SHA-256 は Local にだけ記録する。calibration には repository の完全架空
fixture から作った package だけを用い、実公報や顧客 data を混ぜない。

### 7.2 calibration fixture の生成

calibration は既存の `buildMinimalFictionalPackage("JPA")` から JPA package を 1 件だけ
生成し、expected document count を `1` とする。作業 branch exact SHA の
`pnpm-lock.yaml` と `pnpm install --frozen-lockfile` で解決された既存 `tsx` loader を使う。
対象 exact SHA では `tsx@4.21.0` が lock されていることと `node --import tsx` が解決できる
ことを先に確認する。lock にない loader の download、install、upgrade は行わない。

repository 外の OS temporary directory を新規作成し、次のように exclusive file へ生成する。
実行時の resolved path や hash は GitHub／Job log へ転載しない。

```powershell
$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ("patentai-issue75-calibration-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $fixtureRoot | Out-Null
$env:KOHO_CALIBRATION_OUTPUT = Join-Path $fixtureRoot 'calibration-jpa.zip'

$fixtureProgram = @'
import { writeFile } from "node:fs/promises";
const fixtureModule = await import(
  "./src/lib/koho-package/__fixtures__/fictional-package.ts"
);
const { buildMinimalFictionalPackage } =
  fixtureModule.default ?? fixtureModule;

const output = process.env.KOHO_CALIBRATION_OUTPUT;
if (!output) throw new Error("missing calibration output");
await writeFile(output, buildMinimalFictionalPackage("JPA"), {
  flag: "wx",
  mode: 0o600,
});
'@

node --import tsx --input-type=module --eval $fixtureProgram
$fixtureHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $env:KOHO_CALIBRATION_OUTPUT).Hash.ToLowerInvariant()
$fixtureBytes = (Get-Item -LiteralPath $env:KOHO_CALIBRATION_OUTPUT).Length
```

生成後に次を確認する。

- `$fixtureRoot` の resolved absolute path が repository root 外かつ OS temporary directory 内。
- file が新規 1 件だけで、type は JPA、fixture oracle は document `1`。
- `$fixtureHash` は lowercase ASCII hex 64 文字、`$fixtureBytes` は positive かつ runner 上限内。
- runner 対象 test が同じ fixture を parse し expected document count `1` を確認済み。

Local hash は `KOHO_JOB_EXPECTED_SOURCE_SHA256` の secret 値と upload／download 照合にだけ
使用する。calibration execution と照合が終わったら、Job secret、staged object、SAS を先に
失効・削除する。その後、削除対象の resolved path が上記の repository 外 temporary
directory と exact 一致することを再確認してから、次を実行する。

```powershell
Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
Remove-Item Env:KOHO_CALIBRATION_OUTPUT -ErrorAction SilentlyContinue
$fixtureHash = $null
$fixtureBytes = $null
```

元 JPA／JPB package や repository directory をこの cleanup の対象にしない。

### 7.3 Portal での staging

1. 専用 Storage Account 内に本 Issue 専用 container を作り、anonymous access が無効な
   private access であることを Portal の Overview／Configuration で確認する。
2. opaque かつ非機密な object 名で、calibration、JPA、JPB を一つずつ copy／upload する。
3. upload 後の object を別の一時 Local file として download し、元 source と size および
   SHA-256 が一致することを照合する。値は公開 log に出さない。
4. 照合用 Local copy は対象を再確認して削除し、元 file は残す。
5. 対象 object 一つだけを read できる HTTPS-only の期限付き SAS、または同等の
   least-privilege access を execution ごとに用意する。list、write、create、delete 権限を
   付けない。
6. expiry は当該 execution と確認・cleanup に必要な最短時間とし、runner の config validation
   時点から最大 24 時間以内にする。

Storage Account 作成から削除までを 48 時間以内に収め、staged object の合計を 10 GB 以下に
保つ。upload ごとに aggregate 使用量と削除期限を非公開 inventory で更新する。

source と staged object の size／SHA-256 が一致しない、container が public、権限を read-only
へ限定できない、または期限を 24 時間以内へ限定できない場合は execution を開始しない。

## 8. 専用 staging DB と migration

### 8.1 identity／empty gate

Portal で専用 PostgreSQL server を Japan East、Burstable B2s、storage 32 GB、HA なし、
storage autogrow なしとして新規作成し、その server 内に専用 database／user を作る。tier、
storage、HA、autogrow を保存後に再確認し、異なる場合は migration 前に停止して費用を再計算
する。

Portal と第8.3節の本 Issue 専用 read-only observer 経路で、次の項目を、値を公開せず確認する。

- server、database、subscription、resource group が本 Issue の inventory と一致する。
- Production host／database／resource ID のいずれとも一致しない。
- 新規の空 database であり、application user table と migration journal が存在しない。
- credential は staging 専用で、削除可能かつ必要最小権限・期限である。
- Job からだけ必要な network path があり、Production network／secret を流用しない。

一意性、空 DB、Production 分離のいずれかを証明できない場合、migration は実行しない。

### 8.2 migration 適用

固定した exact SHA image に含まれる既存 artifact を未変更のまま、次の順でだけ適用する。

1. `drizzle/0000_loud_forge.sql`
2. `drizzle/0001_regular_black_bolt.sql`
3. `drizzle/0002_calm_red_ghost.sql`

entrypoint は `pnpm db:migrate` または同じ installed migration entrypoint とする。
`db:push`、`db:generate`、migration SQL の編集・再生成、手動 DDL、`0002` より後の artifact、
Production／既存共有 DB への適用は禁止する。

Portal だけで migration を起動する場合は、同じ exact SHA image を使う本 Issue 専用の
manual one-shot Job configuration で command を一時的に migration entrypoint へ固定する。
その時点では Blob URL や package env を渡さない。retry 0、parallelism 1、completion 1、
有限 timeout のまま一度だけ実行し、成功後に runner command へ戻す。Production Container
App の console や command override は使用しない。

migration 後は journal が `0000 -> 0001 -> 0002` の順に一度ずつ完了し、必要 table／index／
constraint が存在することを確認する。未適用、部分適用、追加 artifact、順序不一致を PASS
にしない。失敗時は手動 DDL で補修せず、staging DB 全体を rollback／cleanup 対象とする。

### 8.3 staging DB observer

DB identity、empty state、migration、package 前後 delta は、exact SHA image の read-only
observer を専用 Job から次の command で実行して確認する。

```text
node scripts/koho-job/db-observer.mjs preflight
node scripts/koho-job/db-observer.mjs migrated
node scripts/koho-job/db-observer.mjs snapshot
node scripts/koho-job/db-observer.mjs package
```

全 mode の observer に渡す共通 environment は次の 4 件だけである。値を command line や log へ展開せず、
期待 host／database 名と URL は Job secret reference から渡す。

- `DATABASE_URL`
- `KOHO_JOB_DATABASE_SCOPE=issue-75-dedicated-staging`
- `KOHO_JOB_EXPECTED_DATABASE_HOST`
- `KOHO_JOB_EXPECTED_DATABASE_NAME`

`package` mode に限り、runner と同じ `KOHO_JOB_PACKAGE_TYPE`、
`KOHO_JOB_EXPECTED_SOURCE_SHA256`、`KOHO_JOB_EXPECTED_DOCUMENT_COUNT` を追加する。source hash は
Job secret reference とし、SQL bind 値としてだけ使う。他の observer mode にはこの3件を渡さない。
全 mode で Blob URL、manual token、Production env を渡さない。
connection timeout は 15 秒、statement／query timeout は 30 秒の固定上限とし、observer は
write SQL を実行しない。client cleanup も 5 秒で打ち切る。第9.2節と同じ strict
`DATABASE_URL` identity／query gate を再利用し、timeout、DB error、unexpected row は raw
detail を出さず non-zero で fail-closed にする。

stdout は safe JSON 1 行だけとし、共通 field は `component=koho_db_observer`、
`schemaVersion=1`、`mode`、`status`、`result`、`reason` である。失敗時は
`result=unknown` と固定 `reason` だけを使い、host、database、user、connection string、SQL、
table row、source hash、LSN text、raw error を出さない。

observer の exit code は `0=success`、`1=internal`、`2=config`、`3=connect`、`4=query`、
`5=state`、`6=cleanup` に固定する。failure reason は `invalid_config`、`internal_error`、
`connect_timed_out`、`connect_failed`、`query_timed_out`、`query_failed`、
`idle_client_error`、
`invalid_metric_state`、`unexpected_database_state`、`database_identity_mismatch`、
`database_not_empty`、`migration_state_mismatch`、`migration_manifest_mismatch`、
`migration_manifest_unavailable`、`schema_state_mismatch`、`schema_manifest_unavailable`、
`package_state_mismatch`、`cleanup_timed_out`、`cleanup_failed` だけを許可する。

各 mode の success oracle は次のとおりである。

| mode | 実行時点 | success field／oracle |
| --- | --- | --- |
| `preflight` | migration 前 | `applicationTableCount=0`、`migrationCount=0` |
| `migrated` | migration 直後 | `applicationTableCount=10`、`migrationCount=3` |
| `snapshot` | calibration／package の直前・直後 | 下記 aggregate。実行前に observer 自身が exact migration を再確認 |
| `package` | calibration／package の直後 | secret source hash ごとにexactly 1 run、type／status／declared・stored countを照合 |

`migrated`／`snapshot`／`package` は table 数だけでなく、exact image の migration journal にある
`0000`、`0001`、`0002` の順序、metadata、SQL artifact digest と DB journal を照合する。
さらにexact imageの`0002_snapshot.json`から導いたcolumns、non-PK indexes、PK／FK／CHECK
constraintsのcanonical fingerprintを`pg_catalog`の実状態と照合する。digest／fingerprint値そのものは
stdout や公開記録へ出さない。

`snapshot` の success JSON は次の numeric field を持つ。

- `applicationTableCount`
- `migrationCount`
- `databaseBytes`
- `userTableBytes`
- `indexBytes`
- `kohoImportRunsTableBytes`
- `kohoImportRunsIndexBytes`
- `kohoImportDocumentsTableBytes`
- `kohoImportDocumentsIndexBytes`
- `walPositionBytes`
- `tempBytes`
- `importRunCount`
- `importDocumentCount`
- `reportedDocumentCount`
- `amendmentCount`
- `nestedSt26Count`
- `otherSessionCount`
- `otherActiveSessionCount`
- `otherWaitingSessionCount`
- `otherLockCount`
- `otherWaitingLockCount`

`package` mode の success JSON は、schema gate の結果である `applicationTableCount=10`、
`migrationCount=3` に加え、`matchingRunCount=1`、`packageType`、`packageStatus`、
`expectedDocumentCount`、`declaredDocumentCount`、`storedDocumentCount`、`amendmentCount`、
`nestedSt26Count` を共通 field へ追加する。source hash、import ID、DB identity は出力しない。

session／lock count は observer 自身を除外した瞬間値である。`preflight` が既知の success に
なるまで migration を開始せず、migration 後は `migrated` が既知の success になるまで
calibration を開始しない。

各 package について、次の順に `snapshot` を採る。

1. package Job が active でないことを確認する。
2. `snapshot` を 1 回実行し、safe JSON を非公開の `before` 記録へ保存する。
3. observer execution が終了し、other session／lock が 0 と確認してから package Job を
   1 回だけ実行する。
4. package Job の終了と child／session／lock cleanup を確認する。
5. 同じtype／source hash／expected countで`package` modeを1回実行し、sourceごとexactly 1 run、
   `success`／`review_required`、declared・stored document countをsafe aggregateで確認する。
6. `snapshot` を 1 回実行し、safe JSON を非公開の `after` 記録へ保存する。
7. `after - before` で database、user table、index、2 import tableのtable／index、WAL position、temp、run、document、
   reported document、amendment、nested ST.26 の delta を算出する。

calibration、JPA、JPB の各組を混ぜず、同じ field 同士を差し引く。session／lock field は
delta ではなく各時点の絶対 count を確認し、package 前後とも waiting 0、package 後は全 other
session／lock 0 を要求する。counter 減少、negative delta、`importDocumentCount` と
`reportedDocumentCount` の不一致、WAL／temp の取得不能は UNKNOWN とし、blind rerun しない。

observer／migration execution の image digest、platform retry 0、parallelism 1、completion 1、
finite timeout、exit code、safe log scan も package Job と同様に記録する。これらの execution
による費用は第4節の 4,100 円 worst-case に含め、別枠で上限を増やさない。

## 9. Job configuration

### 9.1 platform 設定

Azure Portal で、本 Issue 専用 Job を次の設定にする。Portal 上の表記が異なる場合も意味を
変えない。

| 項目 | 必須値 |
| --- | --- |
| Trigger type | Manual |
| Ingress／public endpoint | なし |
| Parallelism | `1` |
| Completion count | `1` |
| Replica retry limit | `0` |
| 実行中 replica | 同時に最大 `1` |
| Replica／execution timeout | 有限、かつ 1 execution 最大 `120` 分 |
| Image | 固定した branch exact SHA の immutable image |
| Command | `node scripts/koho-job/runner.mjs` |
| CPU／memory | `2 vCPU`／`4 GiB` |
| Ephemeral storage budget | `8 GiB` |
| Environment／log | 本 Issue 専用 Container Apps Environment と専用 log resource |

runner の内部 timeout を platform timeout より短くし、abort、child 終了、temp cleanup の
ための猶予を残す。例として platform を 120 分にする場合は runner を 118 分以下にする。
runner と platform のどちらも 120 分を超えてはならない。必要見積りが 120 分を超える場合は
resource を増強せず NO-GO とする。

shape は費用見積り済みの 2 vCPU／4 GiB、ephemeral 8 GiB を超えない。変更が必要なら新しい
execution を開始せず費用を再計算し、Issue の範囲と 4,500 円 gate を満たせなければ NO-GO
とする。scheduler、event trigger、scale rule、Dapr、外部 ingress、常駐 replica は追加しない。

### 9.2 runner environment

設定名は runner 実装の契約と一致させる。secret 値を plain environment field や log へ
貼らず、Job secret reference を使う。

| name | Portal での扱い | 契約 |
| --- | --- | --- |
| `KOHO_JOB_BLOB_URL` | Job secret reference | 対象 1 object だけを read できる HTTPS の期限付き SAS URL。child へ継承しない |
| `KOHO_JOB_PACKAGE_TYPE` | plain | exact `JPA` または `JPB` |
| `KOHO_JOB_EXPECTED_DOCUMENT_COUNT` | plain | `1..10000000` の integer。JPA は `1048`、JPB は `580`。calibration は架空 fixture の oracle |
| `KOHO_JOB_EXPECTED_SOURCE_SHA256` | Job secret reference | Local で照合した source の lowercase ASCII hex 64 文字。response の hash と exact 比較し、log へ出さない |
| `KOHO_JOB_MAX_SOURCE_BYTES` | plain | positive safe integer、最大 64 GiB。実 package size 以上の必要最小値 |
| `KOHO_JOB_TIMEOUT_SECONDS` | plain | `11..7200` の integer。末尾 10 秒を child／temp cleanup 用に予約し、platform timeout より短くする |
| `DATABASE_URL` | Job secret reference | Production と分離した本 Issue 専用 staging DB の接続文字列。下記の URL gate を満たす |
| `KOHO_JOB_DATABASE_SCOPE` | plain | fail-closed marker。exact `issue-75-dedicated-staging` |
| `KOHO_JOB_EXPECTED_DATABASE_HOST` | Job secret reference | staging DB の期待 host。`DATABASE_URL` の host と exact 一致させ、公開しない |
| `KOHO_JOB_EXPECTED_DATABASE_NAME` | Job secret reference | staging DB の期待 database 名。`DATABASE_URL` の path と exact 一致させ、公開しない |
| `KOHO_JOB_LOOPBACK_PORT` | plain | 任意。既定 `3000`、指定時は `1024..65535` |

operator は `KOHO_IMPORT_ADMIN_TOKEN` と `KOHO_IMPORT_MAX_SOURCE_BYTES` を Job へ設定しない。
runner が process 内で random token を生成し、max source bytes とともに loopback child へだけ
渡す。既存の Production token／manual import env を参照・複製しない。

`DATABASE_URL` は `postgres:` または `postgresql:` URL とし、host endpoint が
`.postgres.database.azure.com` で終わり、port は省略または `5432`、username／password は
双方あり、fragment はなし、`sslmode` は exact 1 件の `require`、`verify-ca`、
`verify-full` のいずれかでなければならない。期待 host は URL の `.host` と exact 一致させる。
明示的な `:5432` がある場合は期待 host にも含め、database 名は URL path の decode 後の値と
exact 一致させる。query entry はこの `sslmode` 1 件だけを許可し、`host`、`port`、`user`、
`password`、`database`／`dbname`、`ssl`、`uselibpqcompat`、`application_name`、重複
`sslmode`、その他の未知 query をすべて拒否する。URL gate 不成立時は Blob、child、DB に
触れず config error とする。

`AZURE_STORAGE_CONNECTION_STRING` と `AZURE_BLOB_CONTAINER_NAME` も設定・継承しない。
runner は今回の object-only SAS だけを使用する。`AZURE_LOG_LEVEL` は設定せず、runner が
Azure SDK の import 前に除去して credential-bearing URL の診断出力を防ぐ。

runner は child を `127.0.0.1` のみに bind し、Blob credential を child へ渡さない。child
へ親 environment 全体を複製せず、OS 起動・locale・timezone・dynamic library・certificate
に必要な固定 allowlist だけを継承する。それに staging `DATABASE_URL`、
`NODE_ENV=production`、telemetry 無効化、loopback の `NO_PROXY`／host／port、専用
`TMPDIR`／`TMP`／`TEMP`、process 内生成の manual token／max bytes、child-only の
`KOHO_LOOPBACK_REQUEST_TIMEOUT_MS` だけを加える。これは runner の operation timeout と同じ
millisecond 値、すなわち total timeout から cleanup 用 10 秒を引いた値で、operator は直接
設定しない。`server.mjs` はこの値を 1..7,200,000 ms の finite integer として再検証し、Node
HTTP server の `requestTimeout` へ設定する。すべての Azure、AI provider、
`KOHO_JOB_*` credential／設定は child へ継承しない。success、failure、timeout、signal の
全経路で Blob stream、HTTP request、file handle、temp、child process を cleanup する。

child server の shutdown deadline は 4 秒で、超過時は non-zero hard exit する。runner 全体の
cleanup deadline は予約済み 10 秒で、こちらを超過した場合は `exit 8`／UNKNOWN とする。
いずれも成功へ丸めない。platform timeout は、この runner cleanup を先に完了できるよう
runner total timeout より長く設定する。

runner の readiness probe も `127.0.0.1` の `/api/health` だけに送り、staging DB の
`database.ok=true` を確認してから import を開始する。外部 health URL や Production health
endpoint を import execution の readiness に使用しない。

期待 host／database 名は credential ではないが、本 Issue では非公開 metadata として Job
secret reference または同等の非公開設定で渡す。runner は `DATABASE_URL` の scheme、host、
database path と期待値を起動前に exact 比較し、scope marker の不一致、Production database
名、identity 不一致を config error で fail-closed にする。この code 上の照合は Portal で行う
identity／empty gate の代わりにはならない。

Blob client の `maxTries=1`、stream の `maxRetryRequests=0` を確認する。これは初回を含む
合計 1 attempt であり、自動再送をしない。runner 自体も同一 object への retry loop を持たない。
SAS の expiry は runner の config validation 時点から、total timeout に cleanup margin 5 分を
加えた時刻より後でなければならない。同時に同じ validation 時点から 24 時間以内でなければ
ならない。`st` の有無や値をこの24時間判定の基準にしない。URL host は専用 account の
`.blob.core.windows.net` endpoint で、account label は lowercase 英数字 3..24 文字、port、
userinfo、fragment はなし、path は container と object を持ち、SAS は `sp=r`、`sr=b`、
`spr=https` を満たす。`sp`、`sr`、`spr`、`sig`、`se` はそれぞれ exact 1 件とし、`sig` は
8 文字以上でなければならない。この条件を満たしつつ、確認・cleanup に必要な最短の期限を選ぶ。

runner の最終 aggregate JSON は次の safe field だけとする。成功時と失敗時で不要な field は
省略される。

- 共通：`component`、`schemaVersion`、`status`、`result`、`durationMs`、
  `peakMemoryBytes`、`memorySource`、`peakTempBytes`、`networkBytes`、`retryCount`
- 設定検証後：`packageType`、`expectedDocumentCount`
- 成功時：`packageStatus`、`savedDocumentCount`、`amendmentCount`、`nestedSt26Count`
- 失敗時：stable な `reason`

`result` は `not_started`、`unknown`、`confirmed_mismatch`、`confirmed` のいずれかとする。
`memorySource` は `cgroup_peak`、`process_rss`、`not_sampled` のいずれかとし、
Azure execution では `cgroup_peak` または Portal の container 全体 metric が必須である。
`process_rss` 単独と `not_sampled` は Next.js child を含む container 全体の peak を証明しないため
memory PASS にしない。
`sourceSha256`、`importId`、URL、path、host、database 名、raw error は最終 aggregate に含めない。
`reason` は `invalid_config`、`source_failed`、`child_failed`、`timed_out`、
`import_failed`、`count_mismatch`、`interrupted`、`cleanup_failed`、`internal_error` だけを
許可する。

manual handler の success JSON は既存契約の次の 8 field を欠損なく exact に持つ場合だけ
受理する。

- `packageType`
- `packageStatus`
- `sourceSha256`
- `importId`
- `documentCount`
- `savedDocumentCount`
- `amendmentCount`
- `nestedSt26Count`

余分な field、欠落、型・enum・integer・hash 形式の不一致、package type 不一致、expected
document count 不一致は import/result failure とする。`sourceSha256` と `importId` は検証にだけ
使い、runner の最終 aggregate へ投影しない。

### 9.3 起動直前 gate

各 execution で Portal の Job configuration と非公開 inventory を二者照合し、次を全部
確認する。

- image tag と digest が実行対象 exact SHA に一致する。
- Job、ACR、Container Apps Environment／log、Storage、PostgreSQL、identity／role がすべて
  専用 Resource Group の inventory と一致し、既存 resource reference がない。
- Job に ingress、schedule、event trigger がない。
- parallelism 1、completion 1、retry 0、timeout が有限かつ 120 分以内である。
- shape は 2 vCPU／4 GiB、ephemeral 8 GiB を超えない。
- active execution が 0 で、別 package を同時実行しない。
- Blob URL は今回の 1 object だけに対する read-only access で、config validation 時点から
  runner total timeout＋5分より長く、同じ時点から24時間以内である。
- `KOHO_JOB_PACKAGE_TYPE` と object 種別が一致する。
- expected document count が今回の oracle と一致する。
- `KOHO_JOB_EXPECTED_SOURCE_SHA256` が Local source／staged object の照合済み hash と一致する。
- size 上限は positive、実 package 以上、64 GiB 以下の必要最小値である。
- `DATABASE_URL` は identity 確認済み staging DB だけを指す。
- database scope marker、期待 host／database 名、`DATABASE_URL` の照合が成立する。
- Production secret／env／resource reference が一つもない。
- Blob 10 GB／48時間、ACR Basic 3日／10 GB、log 1 GB、egress 20 GB の各上限内である。
- actual、未確定利用、残存 resource、今回実行の worst-case 合計が 5,000 円未満に収まる。

## 10. 実行順と package 間 gate

順序を入れ替えず、前段の結果を確定してから次へ進む。

### 10.1 calibration：最大 1 回

1. 第7.2節で生成した完全架空 JPA package の object を設定し、
   `KOHO_JOB_PACKAGE_TYPE=JPA`、expected document count `1`、Local hash と一致する
   `KOHO_JOB_EXPECTED_SOURCE_SHA256` を使う。
2. active execution 0 と起動直前 gate を確認し、Portal から一度だけ手動起動する。
3. platform status、runner exit code、最終 aggregate、restart count、resource peak、cleanup を
   照合する。
4. DB の calibration run／document aggregate が fixture oracle と一致することを確認する。
5. raw content、path、hash、manual handler response 全体が log にないことを確認する。

calibration は最大 1 回であり、自動・手動とも再実行しない。不成立なら JPA へ進まず、
cleanup して NO-GO とする。calibration の DB row は full package oracle の集計対象から除外し、
本 Issue の DB 全体を削除するまで保持してよい。手動 DELETE や schema 変更で消さない。
execution 確認後は第7.2節どおり、calibration の SAS、Job secret、staged object、repo 外 Local
temporary file／directory を削除する。

### 10.2 JPA：最大 1 回

1. calibration が既知の成功であることを確認する。
2. JPA object について起動直前 gate を再実施する。
3. `KOHO_JOB_PACKAGE_TYPE=JPA`、expected document count `1048`、Local 照合済み hash を
   `KOHO_JOB_EXPECTED_SOURCE_SHA256` として一度だけ起動する。
4. execution 結果、oracle、metrics、cleanup、費用を確定する。
5. JPA が既知の成功で、次の実行を含む費用 gate を通る場合だけ JPB へ進む。

### 10.3 JPB：最大 1 回

1. JPA execution が終了し、active execution 0、restart 0、結果確定済みであることを確認する。
2. JPB object について起動直前 gate を再実施する。
3. `KOHO_JOB_PACKAGE_TYPE=JPB`、expected document count `580`、Local 照合済み hash を
   `KOHO_JOB_EXPECTED_SOURCE_SHA256` として一度だけ起動する。
4. execution 結果、oracle、metrics、cleanup、費用を確定する。

JPA と JPB を並列に起動しない。Portal の start 操作は一回だけ行い、読み込み中の再clickや
画面 timeout を理由に再度 start しない。execution ID を確認できない場合は UNKNOWN とする。

### 10.4 full package の例外的再実行

JPA／JPB を合わせて追加の手動再実行は最大 1 回だけ許される。次をすべて満たすまで行わない。

- 前回失敗原因が明確である。
- 前回の DB transaction 結果が確定し、rollback または対象 cleanup が確認済みである。
- active execution、child、lock、session、temp が残っていない。
- 修正後 shape／設定でも 120 分および費用 gate 内である。
- 再実行対象以外の package を並列起動しない。

timeout、OOM、child death、接続断、cleanup failure、final aggregate 欠損などで保存結果が
UNKNOWN の場合は再実行条件を満たさない。DB で結果を確定できなければ blind rerun せず
NO-GO とする。

## 11. result 判定と stable exit code

runner の exit code は次を用いる。`0` は全検証済み success だけである。

| code | 分類 | 運用上の扱い |
| ---: | --- | --- |
| `0` | success | platform／aggregate／DB oracle／cleanup も一致した場合だけ既知の成功 |
| `1` | internal | failure。DB 結果を別途確定するまで UNKNOWN |
| `2` | config | fail-closed。設定を修正しても再実行上限と費用 gate を再確認 |
| `3` | source | Blob／stream failure。DB 結果を確認し blind rerun しない |
| `4` | child | child start／exit failure。DB 結果を確認し blind rerun しない |
| `5` | timeout | UNKNOWN。自動再実行しない |
| `6` | import／result | response または oracle 不成立。DB 結果を確認する |
| `7` | signal | UNKNOWN。自動再実行しない |
| `8` | cleanup | 保存済みの可能性があるため UNKNOWN。自動再実行しない |

Azure platform の `Succeeded` だけ、HTTP 2xx だけ、exit `0` だけでは package の PASS に
しない。次をすべて満たして初めて既知の成功とする。

- completion 1、restart 0、追加 replica 0、exit 0
- 最終 aggregate が schema、package type、expected count と一致
- manual handler の package status が `success` または `review_required`
- handler aggregate と DB run／document aggregate が一致
- timeout、OOM、signal、partial commit、unknown result がない
- Blob stream、request、child、temp の cleanup 完了が確認できる

最終 aggregate が欠損、重複、malformed、または unsafe field を含む場合は success に丸めない。

## 12. 必須 oracle

calibrationとfull packageごとにobserverの`package` modeを使い、Local で保持する source SHA-256を
DB query の bind 値として使用する。値や query text を log に表示せず、sourceごとexactly 1 run、
package type／status、declared document count、保存document row count、amendment／nested ST.26の
read-only aggregateを確認する。

| 対象 | import run | `documentCount` | `savedDocumentCount` | DB document row |
| --- | ---: | ---: | ---: | ---: |
| JPA | source key あたり exactly `1` | `1048` | `1048` | `1048` |
| JPB | source key あたり exactly `1` | `580` | `580` | `580` |
| full package 合計 | exactly `2` | `1628` | `1628` | `1628` |

calibration run は上表から除外する。さらに次を確認する。

- response、`koho_import_runs`、`koho_import_documents` の package type／status／count が一致する。
- package status は既存契約の `success` または `review_required` である。
- source key ごとの run が重複せず、document identity が repository constraint と一致する。
- raw ZIP／XML／CSV、claims、entry path、source hash が永続公開出力へ出ていない。
- failed package は plan／run／document を保存していない。
- repository failure は単一 transaction で rollback され、run 更新、document replace、insert の
  部分 commit がない。
- save 後 cleanup failure 等は、DB aggregate から既存 run の有無と整合を確定する。確定不能は
  UNKNOWN のままとする。

oracle 不一致は件数の近似、欠損の無視、手動 row 修正で解消しない。NO-GO として停止する。

## 13. metrics の採取

各 execution について開始直前 baseline、実行中 peak、完了直後 delta を同じ観測窓で採る。
metric 名が Portal／provider version で異なる場合は、同じ意味を持つ source を選び、その
source と集計方法を Local に記録する。取得できない必須 metric を PASS 扱いしない。

| 項目 | 採取内容 |
| --- | --- |
| duration | Portal execution start／finish と runner wall-clock。差異も確認 |
| process result | exit code、Job status、completion、replica／restart count |
| memory | runner と Next.js child を含む container 全体の peak RSS または同等 working-set peak |
| temporary storage | manual handler 専用 temp root を含む ephemeral storage peak と終了後残留 |
| DB body | execution 前後の専用 DB size delta |
| DB table／index | observerの対象2表別fieldによる`koho_import_runs`／`koho_import_documents` の table／index delta |
| WAL | 同じ観測窓の WAL 増加量 |
| DB temporary usage | 専用 DB の temp usage delta |
| rows | run／document の aggregate と oracle 差分 |
| network | Blob download と Job／DB 通信の aggregate transfer |
| cost | 実行後見込み、未確定 meter、cleanup 完了までの worst-case |

Azure Monitor だけで temp peak や process tree memory を確定できない場合は runner 内の
safe aggregate または本 Issue 専用 metric で補完する。ただし raw path、Blob 名、hash、
query、DB 文、個別公報値を出力しない。共有 Production resource の diagnostic setting を
変更して補完してはならない。

専用 log の ingestion／保持対象が 1 GB、external egress が 20 GB に近づく場合は新しい
execution を開始しない。上限超過分を無制限 retention や別 log sink へ逃がさず、必要な
aggregate を取得できなければ NO-GO とする。

全 package 終了後に staging DB aggregate とともに次を確認する。

- Job execution が active でない。
- Job 由来の DB session が 0 である。
- Job 由来の transaction／lock が残っていない。
- JPA／JPB の run と document count が oracle と一致する。
- calibration を除く JPA／JPB 合計が 1,628 である。

DB query text や connection identity を表示せず、session／lock は aggregate count だけを
記録する。

### 13.1 Production 非変更の再確認

開始時と cleanup 後に、Issue #74 で使用した既存の read-only Portal 監査経路だけで次を
比較し、結果を PASS／FAIL で Local 記録する。値や画面 capture は GitHub へ出さない。

- Production Container App の revision、image、ingress、command、secret／env が本 Issue の
  Azure 操作で変更されていない。
- Production DB へ `0001`／`0002` が適用されず、公報／watch table や data が作られていない。
- Production manual import が disabled-by-default のままである。
- Production Blob、顧客 data、案件に本 Issue 由来の read／write／delete がない。

この確認でも Production Container App の console、shell、exec は使用しない。本 Issue に
起因する変更を検知した場合は以降の操作を target-only cleanup と escalation に限定し、
Production の修復を独断で行わない。

## 14. GO／NO-GO

### 14.1 GO

次をすべて満たす場合だけ Production activation への技術的 GO 候補とする。GO は本 Issue
内で Production を変更する許可ではない。

- JPA／JPB がそれぞれ 1 回で oracle どおり完了した。
- subscription／auth／read-only audit 以外は全resourceが専用新規で、既存／Production
  resource reference がない。
- DB observer の preflight、migrated、各 package 前後 snapshot／delta がすべて確定した。
- duration、memory、temp、DB／index／WAL、network が選択 resource 上限内である。
- result が確定し、partial mutation、restart、UNKNOWN がない。
- failure、timeout、signal を含む cleanup 契約を test と calibration で確認できた。
- Production 予測追加費用が承認上限内である。
- manual HTTP endpoint を外部または Production で有効化せず運用できる。
- 必須 test／scan と Azure 残留 0 の確認がすべて PASS である。

### 14.2 NO-GO

次の一つでも該当すれば NO-GO とし、次の package／再実行を開始せず cleanup する。

- 120 分以内に完了しない、または必要見積りが 120 分を超える。
- OOM、restart、ephemeral storage 不足、UNKNOWN result がある。
- oracle 不一致、partial commit、cleanup failure がある。
- 結果確定や cleanup に queue、checkpoint 等の追加 framework が必要である。
- Production 相当 resource の費用が上限を超える。
- Production DB／data／revision／secret へ影響しないことを証明できない。
- 必須 metric、test、情報安全 scan、resource 残留 0 を確認できない。
- 専用 Resource Group 配下へ隔離できない、または既存 resource の再利用が必要になる。

NO-GO 後に resource 増強、queue、checkpoint、Production activation を先取りしない。

## 15. target-only cleanup

success、failure、timeout、signal、NO-GO のいずれでも実施する。削除前に inventory の ID、
tag、作成時刻、親 resource を Local で再照合し、対象が本 Issue 専用であることを確認する。

1. 新しい manual start を禁止し、active Job execution が 0 になるまで状態を確定する。
2. runner／child／request／Blob stream が終了し、DB session／lock が 0 であることを確認する。
3. object SAS／temporary credential を失効または削除し、Job の secret reference を外す。
   SAS を能動的に失効できない場合も account key を rotate せず、専用 Storage Account
   の削除完了または短い expiry 後の無効化まで credential 残留 0 と判定しない。
4. manual Job、Job secret、migration／observer／package execution 履歴を削除する。
5. Container Apps Environment と、それに専用の log／metric resource を削除する。
6. calibration、JPA、JPB の staged object と private container を削除し、専用 Storage
   Account を削除する。
7. staging database／user／network rule を含む専用 PostgreSQL server を削除する。
8. exact-SHA image tag／manifest を含む専用 ACR を削除する。
9. 本 Issue 専用 role assignment と temporary identity／credential を削除する。
10. repository 外の calibration／build context／download 照合用 temporary file／directory が
    0 であることを、元 package と区別して確認する。
11. inventory と Portal の deployment／resource 一覧を照合し、全 child が削除済みと確認して
    から専用 Resource Group を削除する。
12. Portal の Resource Group、Storage、Container Apps Jobs／Environment、Log Analytics、
    PostgreSQL、ACR、role assignment、cost 画面を再読込し、親子 resource の削除反映と残存
    課金見込みを確認する。

cleanup 完了条件はすべて `0` である。

| 対象 | expected |
| --- | ---: |
| active Job execution | `0` |
| 本 Issue 専用 Job | `0` |
| migration／observer／package execution 履歴 | `0` |
| staged package object | `0` |
| 本 Issue 専用 Blob container | `0` |
| 本 Issue 専用 Storage Account | `0` |
| Container Apps Environment | `0` |
| 専用 log／metric resource | `0` |
| temporary PostgreSQL server／DB／user／network rule | `0` |
| temporary SAS／credential／secret | `0` |
| 本 Issue 専用 role assignment | `0` |
| exact-SHA image tag／manifest | `0` |
| 本 Issue 専用 ACR | `0` |
| repo 外 calibration／build／download temporary artifact | `0` |
| 本 Issue 専用 Resource Group | `0` |

削除対象の一意性を確認できない場合は無関係 resource を削除しない。一般化した残留分類と
費用上限への影響だけを報告し、`codex:blocked` で停止する。import の blind rerun はせず、
確認済み対象に対する cleanup だけを続ける。

## 16. rollback

- staging data：専用 DB 全体を target-only で削除する。row 単位の手動補修や Production への
  copy は行わない。
- Blob：staged copy、期限付き access、private container、専用 Storage Account を削除する。
  Local の元 package は変更しない。
- compute：active 0 を確認して Job、execution、Container Apps Environment、専用 log を削除する。
- database：専用 PostgreSQL server／DB／user／network rule を削除する。
- image：exact-SHA image／manifest と専用 ACR を削除する。
- parent：専用 role assignment／credential と全 child の削除を確認後、専用 Resource Group を
  削除する。
- code：merge 後に問題が判明した場合は Issue #75 の Squash commit を revert する。
- Production：本手順では変更しないため Production data rollback はない。変更を検知した
  場合は追加操作を止め、内容を公開せず escalation する。

## 17. 必須 test と情報安全確認

code の exact head に対して、未実行・pending・skipped を PASS にせず次を完了する。

- `pnpm install --frozen-lockfile`
- runner unit test：input validation、missing config、stream success、size limit、abort、
  expected source hash、SAS 24時間上限、DB URL exact query、custom loopback server、finite HTTP
  request timeout、child failure、cleanup failure、safe log
- 完全架空 package による Local integration
- runner 対象 test
- DB observer の `preflight`／`migrated`／`snapshot`／`package`、schema fingerprint、timeout、safe log test
- `pnpm test`
- `pnpm lint`
- `pnpm type-check`
- `pnpm build`
- 専用の空 staging DB だけへの `pnpm db:migrate`
- `git diff --check`
- secret、認証付き URL、Local path、顧客情報、個別公報値、実 package の repository 混入 scan
- exact head と image tag／digest、Local 検証記録の対応確認
- 専用 Resource Group、Storage Account／object、ACR／image、Container Apps
  Environment／log／Job、PostgreSQL server／DB／user、credential／role、execution の残留 0

test fixture は完全架空とし、実 JPA／JPB package を repository、test artifact、CI へ含めない。

## 18. 公開可能な結果記録 template

次の template には公開可能な aggregate だけを記入する。角括弧を secret、Azure 実名、
Local path、package size／hash、個別公報値で置換してはならない。

```text
baseline SHA: <public commit SHA>
head SHA: <public commit SHA>
image exact-SHA一致: PASS / FAIL
既報worst-case: 4,100円
開始時費用gate: 4,500円以下 PASS / FAIL
絶対上限5,000円: PASS / FAIL
全benchmark resource専用新規: PASS / FAIL
DB observer preflight(0 tables/0 migrations): PASS / FAIL
DB observer migrated(10 tables/3 migrations): PASS / FAIL
package前後snapshot/delta: PASS / FAIL / UNKNOWN
source単位package oracle: PASS / FAIL / UNKNOWN

calibration: PASS / FAIL / UNKNOWN
JPA: status=<safe aggregate>, documents=1048, duration=<safe aggregate>, result=PASS / FAIL / UNKNOWN
JPB: status=<safe aggregate>, documents=580, duration=<safe aggregate>, result=PASS / FAIL / UNKNOWN
JPA+JPB: documents=1628, result=PASS / FAIL

parallelism=1: PASS / FAIL
completion=1: PASS / FAIL
retry=0: PASS / FAIL
restart=0: PASS / FAIL
timeout<=120分: PASS / FAIL
memory上限内: PASS / FAIL
temporary storage上限内: PASS / FAIL
DB/index/WAL上限内: PASS / FAIL
network上限内: PASS / FAIL
partial commitなし: PASS / FAIL
unknown resultなし: PASS / FAIL
safe log scan: PASS / FAIL

active execution残留: 0 / non-zero
Job残留: 0 / non-zero
staged object/container残留: 0 / non-zero
Storage Account残留: 0 / non-zero
Container Apps Environment/log残留: 0 / non-zero
PostgreSQL server/DB/user残留: 0 / non-zero
ACR/image残留: 0 / non-zero
credential/secret/role assignment残留: 0 / non-zero
repo外temporary artifact残留: 0 / non-zero
Resource Group残留: 0 / non-zero
Production変更: なし / 検知

Production activation判定: GO候補 / NO-GO
未確認事項: <一般化した項目のみ>
```

## 19. GitHub handoff

code 変更がある場合は、Ready PR に `Closes #75`、Issue #74、exact head、公開可能な検証、
費用判定、Production 影響、rollback、未確認事項を記録する。PR へ
`codex:local-verified` と `codex:needs-review` の両方を付け、Issue から
`codex:in-progress` を外す。Local worker は merge しない。

Verifier は `LOCAL_METADATA_ONLY` として、現在 head に一致する公開可能な Local 検証記録と
metadata だけを確認する。diff、patch、file 本文、commit 本文、Actions log 本文、artifact、
非公開 benchmark 値を取得させない。

preflight または検証不成立時は target-only cleanup 後、`codex:in-progress` と
`codex:local-verified` を外し、原因に応じて `codex:blocked` または
`codex:fix-required` とする。全条件成立後の Squash Merge と Issue Close は verifier の
expected head 確認後に行う。
