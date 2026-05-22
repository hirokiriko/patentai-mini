# Azure Container Apps Deploy Notes

This repository is prepared to build the Next.js container image and deploy it
to Azure Container Apps through GitHub Actions.

## Azure Resources

- Resource group: `rg-codex-lab-jpe`
- Azure Container Registry: `patentaimini6ilyrw`
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

## Current State

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
- `/api/health` has been verified with `database.ok=true`.
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

For `AI_PROVIDER=azure`, also add:

- `AZURE_API_KEY`
- `AZURE_RESOURCE_NAME` or `AZURE_OPENAI_BASE_URL`
- `AZURE_OPENAI_API_VERSION`
- `AZURE_OPENAI_DEPLOYMENT_NAME`
- `AZURE_OPENAI_FAST_DEPLOYMENT_NAME` when a separate fast deployment exists

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
