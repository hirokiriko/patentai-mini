# Azure Container Apps Deploy Notes

This repository is prepared to build the Next.js container image and deploy it
to Azure Container Apps through GitHub Actions.

## Azure Resources

- Resource group: `rg-codex-lab-jpe`
- Azure Container Registry: `patentaimini6ilyrw`
- Azure Storage account: `stpatentaimini6ilyrw`
- Blob container for original uploads: `patentai-original-files`
- Container Apps environment: `cae-patentai-mini-6ilyrw`
- Planned Container App: `ca-patentai-mini`
- Image: `patentaimini6ilyrw.azurecr.io/patentai-mini:latest`
- PostgreSQL Flexible Server: `pg-patentai-mini-roznup.postgres.database.azure.com`
- PostgreSQL database: `patentai`
- Azure OpenAI account for production chat: `oai-patentai-mini-eus2`
- Azure OpenAI normal deployment: `patentai-gpt54`
- Azure OpenAI fast deployment: `patentai-gpt54-mini`
- Azure OpenAI normal model: `gpt-5.4` version `2026-03-05`
- Azure OpenAI fast model: `gpt-5.4-mini` version `2026-03-17`
- Azure OpenAI account in Japan East: `oai-patentai-mini-s5rb1e`
- Azure AI Document Intelligence account: `di-patentai-mini-jpe`

## Current State

### Issue #86 execution checkpoint (2026-09-12 JST)

The latest Issue #86 `LOCAL_AUTONOMOUS_EXECUTION_V2` body authorizes this
one-time Local run: OpenAI, Document Intelligence, Storage and PostgreSQL
recovery; UAMI image pull and ACR admin disablement; Incident #79 completion;
PR #85 Squash Merge with the expected head and normal deploy; then real DB,
AI and browser verification using the public fictional TXT samples and scoped
cleanup. The initial estimate must be at most JPY 800; total additional cost,
including tax and previously incurred usage, must stay within JPY 1,000.

The OWNER has also approved `DB_RUNTIME_CREDENTIAL_BOUNDARY_V1`: separate a
least-privilege application login, retain the management login while rotating
its password, and verify retrieval from separate approved secure storage. Do
not pass management membership, ownership or broad privileges to the app. This
is an execution contract, not a statement of the environment's current roles
or a completed rotation. Formal Issue integration and unchanged preflight gates
still precede production writes; detailed results remain in the Local boundary.
The approved narrow exception permits existing PUBLIC-derived TEMPORARY access
without a direct grant. Permanent DDL, escalation through temporary schemas and
changes to shared ACLs remain prohibited.

At this checkpoint, common preflight has not passed and Phase 1 has not started.
Detailed environment findings remain Local; public records contain only the
unmet acceptance classification. Production changes, paid smoke calls and new
test cases in this run are zero. Recovery, merge, deployment and real-runtime
verification remain incomplete. Do not broaden the existing procedure to resolve
an unmet prerequisite without the decision required by Issue #86. Record
further measured results in Issue #86; neither this documentation nor earlier
successful observations establish the current production state.

Keep the Local secret process boundary and one-writer rule in `AGENTS.md`.
The Issue #86 pause remains until its acceptance conditions are met. Before
removing it, confirm there is no other incident stop; retain other Issues'
stop labels. Do not
use documentation work as a new prerequisite for recovery, or substitute
GitHub Actions OIDC for the authorized Local/DB management path.

### Earlier recorded state

The observations below predate this checkpoint and are not evidence that
Issue #86's recovery or current acceptance checks have passed.

- The Postgres schema from `drizzle/0000_loud_forge.sql` has been applied to
  the Azure PostgreSQL database.
- The Japan East Azure OpenAI account exists, but chat model deployment is
  blocked there by subscription quota/model availability.
- The production app uses the East US 2 Azure OpenAI account
  `oai-patentai-mini-eus2`.
- The production app uses `patentai-gpt54` for normal model calls and
  `patentai-gpt54-mini` for fast model calls.
- `gpt-5.5` is listed in East US 2, but current `gpt-5.5` GlobalStandard and
  DataZoneStandard quota is `0`, so it is not deployable in this subscription
  yet.
- `AI_PROVIDER=azure` is configured on `ca-patentai-mini`.
- `AZURE_API_KEY` and `DATABASE_URL` are stored as Azure Container Apps secrets.
- `AZURE_STORAGE_CONNECTION_STRING` is stored as an Azure Container Apps secret.
- `AZURE_BLOB_CONTAINER_NAME=patentai-original-files` is configured on the app.
- `AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT` and
  `AZURE_DOCUMENT_INTELLIGENCE_KEY` are required for scanned PDF and OCR/layout
  fallback.
- The earlier `/api/health` verification with `database.ok=true` predates the
  Issue #84 contract below; it does not verify that change in Production.
- Minimal AI SDK calls to deployments `patentai-gpt54` and
  `patentai-gpt54-mini` returned `OK`.
- Local Docker is not available in the Codex workspace.
- ACR Tasks are blocked for this subscription, so the image is built by GitHub
  Actions on a GitHub-hosted runner.
- GitHub Actions uses OIDC, not `AZURE_CREDENTIALS`. The Azure AD app is
  `patentai-mini-github-actions` with client id
  `4f80a510-aa15-46b2-b4fb-5dd69ce891e4`.
- The OIDC trust is limited to
  `repo:hirokiriko/patentai-mini:ref:refs/heads/main`.
- The service principal has `AcrPush` on `patentaimini6ilyrw`.
- The service principal also needs permission to update `ca-patentai-mini`,
  such as `Azure Container Apps Contributor` on the app/resource group or an
  equivalent least-privilege custom role. Without this, image build/push can
  succeed while the deploy step fails at `az containerapp update`.

## Health readiness contract (Issue #84)

The implemented `GET /api/health` contract keeps the Node.js runtime and returns
only the following JSON, with `Cache-Control: no-store` in both cases:

- HTTP 200: `{"ok":true,"status":"ok","database":{"ok":true,"type":"postgres"}}`
- HTTP 503: `{"ok":false,"status":"unavailable","database":{"ok":false,"type":"postgres"}}`

The readiness check uses a dedicated `pg.Client` per request and only the fixed
SQL `SELECT 1 AS ok`. It reads `DATABASE_URL` at request time, connects once,
executes at most one query without retries, and ends the client after success or
failure. A missing configuration creates no client. The connection settings are
`connectionTimeoutMillis: 3000`, `statement_timeout: 3000`, and
`query_timeout: 3000`; `statement_timeout` applies only to that client session.
Success requires exactly one result row with `ok === 1` and successful cleanup.
Missing configuration, connection/query errors, timeouts, invalid results,
driver error events, and cleanup failures produce the same HTTP 503 response.

The check does not read business tables, case counts, or migration state, cache
DB results, or connect to the DB during build. It does not expose connection
details, environment values, case data, or exceptions in responses or logs.
Shared Drizzle connections and pool settings are unchanged.

This code change is not deployed to Production. Issue #84 verification uses
fake clients; real DB, real AI, UI flow, and Production behavior remain
unverified for this change. Keep the Issue #79 automation pause in effect: a
branch push or Draft PR does not authorize Draft removal, merge, a Production
workflow dispatch, or resuming automated workers/verifiers. A future merge to
`main` may trigger the existing Azure deployment workflow and requires the
separate incident/deployment gate to be resolved first.

At an approved future deployment, confirm the intended use of the Production
probe and its handling of HTTP 503. This DB-dependent readiness response is not
approval to adopt it as a liveness probe; no probe is added by this change.
Verify the minimal JSON, HTTP status, and no-store behavior in that separately
authorized environment. Before merge, rollback uses an ordinary correction
commit on the branch; after a future merge, use a revert PR for the squash
commit. No DB schema/data or Azure configuration rollback is required by this
code change.

## GitHub Actions

No GitHub secrets are required for image build/push/deploy. The workflow uses:

- `AZURE_CLIENT_ID`
- `AZURE_TENANT_ID`
- `AZURE_SUBSCRIPTION_ID`
- `AZURE_ACR_NAME`
- `AZURE_RESOURCE_GROUP`
- `AZURE_CONTAINER_APP_NAME`
- `IMAGE_NAME`

These values are not secrets and are stored in
`.github/workflows/azure-container-apps.yml`.

Runtime secrets must be configured on Azure Container Apps, not in the
repository:

- `DATABASE_URL`: PostgreSQL connection string for the Azure database.
- `AI_PROVIDER`: `azure`, `google`, or `openai`. The current production setting
  is `azure`.
- `AZURE_STORAGE_CONNECTION_STRING`: Azure Storage connection string for
  original uploaded files.
- `AZURE_BLOB_CONTAINER_NAME`: Blob container name for original uploaded files.

For `AI_PROVIDER=azure`, also add:

- `AZURE_API_KEY`
- `AZURE_RESOURCE_NAME` or `AZURE_OPENAI_BASE_URL`
- `AZURE_OPENAI_API_VERSION`
- `AZURE_OPENAI_DEPLOYMENT_NAME`
- `AZURE_OPENAI_FAST_DEPLOYMENT_NAME` when a separate fast deployment exists

For scanned PDF, garbled PDF, and layout-heavy DOCX fallback, also add:

- `AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT`
- `AZURE_DOCUMENT_INTELLIGENCE_KEY`

Current production Azure OpenAI values:

- `AI_PROVIDER=azure`
- `AZURE_RESOURCE_NAME=oai-patentai-mini-eus2`
- `AZURE_OPENAI_API_VERSION=v1`
- `AZURE_OPENAI_DEPLOYMENT_NAME=patentai-gpt54`
- `AZURE_OPENAI_FAST_DEPLOYMENT_NAME=patentai-gpt54-mini`

For `AI_PROVIDER=google`, add:

- `GOOGLE_GENERATIVE_AI_API_KEY`
- `AI_MODEL` when overriding the default model
- `FAST_AI_MODEL` when overriding the default fast model

For `AI_PROVIDER=openai`, add:

- `OPENAI_API_KEY`
- `AI_MODEL` when overriding the default model
- `FAST_AI_MODEL` when overriding the default fast model

## Manual koho import activation gate

`POST /api/admin/koho-imports` is disabled by application configuration unless
both `KOHO_IMPORT_ADMIN_TOKEN` and `KOHO_IMPORT_MAX_SOURCE_BYTES` are valid.
Merging the route does not authorize changing Azure runtime configuration.

Before enabling the endpoint in Production:

1. Apply the already-approved koho import schema migration through the separate
   Production migration procedure.
2. Configure both manual-import runtime variables through the separately
   controlled Azure Container Apps configuration path; never place their values
   in this repository or workflow logs.
3. Complete the dedicated Local verification with real JPA／JPB packages and a
   disposable Postgres instance.

Until all three are complete, leave the two manual-import variables unset so the
endpoint remains fail-closed with `koho_import_disabled`.

## Deployment Flow

1. Push to `main` or run the workflow manually.
2. The workflow logs into Azure through GitHub OIDC.
3. The workflow builds the repository Dockerfile on a GitHub-hosted runner.
4. The workflow pushes both `${GITHUB_SHA}` and `latest` tags to
   `patentaimini6ilyrw.azurecr.io`.
5. The workflow updates `ca-patentai-mini` to the immutable `${GITHUB_SHA}`
   image tag with `az containerapp update`.
6. Verify `/api/health` after deployment.

## Notes

- The Dockerfile intentionally keeps `next start` and does not enable Next.js
  standalone output yet.
- The `vendor/pdfjs-dist` strategy must remain in place. It is created by the
  existing `postinstall` script during `pnpm install --frozen-lockfile`.
- Do not store Azure keys, database credentials, or connection strings in the
  repository.
- Prefer deploying the commit SHA image tag instead of `latest` so the running
  revision maps directly back to a Git commit.
- If GitHub Actions deploy fails after pushing the image, check the federated
  credential subject and the service principal role assignment before changing
  application code.
- Blob Storage is optional in local development. If both Blob env vars are
  omitted, uploads keep the previous DB-only behavior. If one is present and the
  other is missing, uploads fail with a configuration error.
- Blob-backed draft and uploaded prior-art rows show an `Azure Blob saved` badge
  in the case detail UI.
- The prior-art multi-file upload UI no longer uses the old Vercel 4.5 MB
  payload guard. It warns above 16 MB and blocks above 20 MB as an application
  processing guard for the current synchronous parsing flow.
- Case deletion performs best-effort cleanup for original-file blobs referenced
  by the case's draft and uploaded prior-art metadata. The database delete still
  takes precedence; any Blob cleanup failure is logged and returned in the API
  response as `blobCleanup.failed`.
