# Azure Container Apps Deploy Notes

This repository is prepared to deploy the Next.js app to Azure Container Apps
through GitHub Actions.

## Azure Resources

- Resource group: `rg-codex-lab-jpe`
- Azure Container Registry: `patentaimini6ilyrw`
- Container Apps environment: `cae-patentai-mini-6ilyrw`
- Planned Container App: `ca-patentai-mini`
- PostgreSQL Flexible Server: `pg-patentai-mini-roznup.postgres.database.azure.com`
- PostgreSQL database: `patentai`
- Azure OpenAI account: `oai-patentai-mini-s5rb1e`

## Current State

- The Postgres schema from `drizzle/0000_loud_forge.sql` has been applied to
  the Azure PostgreSQL database.
- The Azure OpenAI account exists, but chat model deployment is blocked by
  subscription quota/model availability. Do not run production AI traffic with
  `AI_PROVIDER=azure` until a chat deployment has been created.
- Local Docker is not available in the Codex workspace.
- ACR Tasks are blocked for this subscription, so the image should be built by
  GitHub Actions on a GitHub-hosted runner.

## Required GitHub Environment

Create a GitHub environment named `azure` and add these secrets:

- `AZURE_CREDENTIALS`: JSON credentials for an Azure service principal that can
  push to ACR and manage Container Apps in `rg-codex-lab-jpe`.
- `DATABASE_URL`: PostgreSQL connection string for the Azure database.
- `AI_PROVIDER`: `azure`, `google`, or `openai`. Use `azure` only after an
  Azure OpenAI chat deployment exists.

For `AI_PROVIDER=azure`, also add:

- `AZURE_API_KEY`
- `AZURE_RESOURCE_NAME` or `AZURE_OPENAI_BASE_URL`
- `AZURE_OPENAI_API_VERSION`
- `AZURE_OPENAI_DEPLOYMENT_NAME`
- `AZURE_OPENAI_FAST_DEPLOYMENT_NAME` when a separate fast deployment exists

For `AI_PROVIDER=google`, add:

- `GOOGLE_GENERATIVE_AI_API_KEY`
- `AI_MODEL` when overriding the default model
- `FAST_AI_MODEL` when overriding the default fast model

For `AI_PROVIDER=openai`, add:

- `OPENAI_API_KEY`
- `AI_MODEL` when overriding the default model
- `FAST_AI_MODEL` when overriding the default fast model

## Deployment Flow

1. Run the workflow manually from GitHub Actions after the `azure` environment
   secrets are configured.
2. The workflow logs into Azure using `AZURE_CREDENTIALS`.
3. The workflow builds the repository Dockerfile on a GitHub-hosted runner.
4. The workflow pushes the image to `patentaimini6ilyrw.azurecr.io`.
5. The workflow creates or updates `ca-patentai-mini`.
6. The workflow prints the Container App URL.

## Notes

- The Dockerfile intentionally keeps `next start` and does not enable Next.js
  standalone output yet.
- The `vendor/pdfjs-dist` strategy must remain in place. It is created by the
  existing `postinstall` script during `pnpm install --frozen-lockfile`.
- Do not store Azure keys, database credentials, or connection strings in the
  repository.
