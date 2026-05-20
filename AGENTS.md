# AGENTS.md

This file defines project-specific rules for AI agents working on
`hirokiriko/patentai-mini`. Follow these rules before making changes.

## 1. Project Overview

`patentai-mini` is a patent prior-art check PoC. It helps compare a user's
draft patent against prior-art documents, generate J-PlatPat search queries,
import search results, and surface overlap/risk candidates. It is not a legal
judgment system; report findings as investigation support, comparison support,
and issue extraction.

Current stack:

- Next.js 16 / React 19 with App Router
- TypeScript
- AI SDK (`ai`) with `@ai-sdk/google` and `@ai-sdk/openai`
- Drizzle ORM
- Turso/libSQL via `@libsql/client` and `drizzle-orm/libsql`
- pnpm
- PDF/DOCX/TXT parsing via `pdfjs-dist`, `@napi-rs/canvas`, and `mammoth`

Azure Hackathon migration target:

- Azure OpenAI provider
- Postgres
- Azure Container Apps
- Azure Blob Storage if original-file persistence or larger uploads are needed

## 2. Repository Structure

- `src/app`: Next.js App Router pages, layouts, and client components.
- `src/app/api`: Route Handlers for cases, drafts, prior-art import, query
  generation, overlap analysis, integration, and health checks.
- `src/components`: Shared UI components such as copy buttons, progress bars,
  guide components, and toast UI.
- `src/lib`: Domain logic and integrations:
  - `ai-model.ts`: AI provider/model selection.
  - `parse-file.ts`: PDF/DOCX/TXT parsing.
  - `extract-claims.ts`: claim extraction.
  - `generate-queries.ts`: J-PlatPat query generation.
  - `analyze-overlap.ts`: prior-art screening and overlap analysis.
  - `integrate-claims.ts`: base-application/addition integration.
  - `parse-jplatpat-csv.ts`: J-PlatPat CSV parsing.
- `src/db`: Drizzle database connection and schema.
- `src/repositories`: Repository interfaces and Drizzle implementation.
- `scripts`: Utility scripts, including `copy-pdfjs-assets.mjs` and
  `migrate-fr07.mjs`.
- `.github/workflows`: GitHub Actions CI.
- `docs` and `ops`: Product/spec/decision/handoff documentation.

## 3. Commands

Use pnpm for this repository. Do not switch to npm or yarn unless the user asks.

- Install dependencies: `pnpm install`
- Development server: `pnpm dev`
- Production build: `pnpm build`
- Production start: `pnpm start`
- Lint: `pnpm lint`
- Type check: `pnpm type-check`
- Generate Drizzle migrations: `pnpm db:generate`
- Run Drizzle migrations: `pnpm db:migrate`
- Push Drizzle schema: `pnpm db:push`
- Open Drizzle Studio: `pnpm db:studio`

`postinstall` runs `node scripts/copy-pdfjs-assets.mjs`. This is important for
PDF parsing because it generates `vendor/pdfjs-dist`.

Do not run package installation or migration commands unless the user has
approved that phase.

## 4. Coding Rules

- Preserve TypeScript correctness and existing type contracts.
- Respect existing function names and responsibilities.
- Keep each task narrowly scoped.
- Do not perform broad refactors without user approval.
- Do not change DB, AI provider, PDF parsing, and deployment configuration in
  one large mixed change.
- Prefer the existing repository abstraction in `src/repositories`.
- After code changes, run the relevant checks when possible:
  - `pnpm lint`
  - `pnpm type-check`
  - `pnpm build`
- If a check cannot be run, report the exact reason.
- For domain output, avoid legal conclusions. Use wording such as "overlap
  candidate", "match candidate", "risk signal", or "requires human review".
- If implementation work changes behavior or project state, update `ops` docs
  when that is in scope. If the user explicitly limits the task to one file,
  respect that scope.

## 5. AI Provider Rules

Rules for `src/lib/ai-model.ts` and AI SDK usage:

- Do not break the existing `google` and `openai` providers.
- Add Azure OpenAI as a new `AI_PROVIDER=azure` branch.
- Azure OpenAI uses deployment names, not generic model names.
- Keep normal and fast model selection separate. Existing functions are
  `getModel()` and `getFastModel()`.
- Do not pass Google-specific `providerOptions.google.thinkingConfig` to Azure
  or OpenAI calls.
- Provider-specific options must be conditionally applied at call sites.
- `analyze-overlap.ts` currently uses Google `thinkingConfig`; update it
  carefully when adding Azure.
- Keep structured output compatibility with `generateObject` and `zod` schemas.

## 6. Database Rules

Current database stack:

- Drizzle ORM
- Turso/libSQL
- `drizzle.config.ts` uses `dialect: "turso"`
- `src/db/index.ts` uses `drizzle-orm/libsql`
- `src/db/schema.ts` uses `sqliteTable`

Postgres migration rules:

- Treat the Postgres migration as a dedicated, potentially breaking phase.
- Move from `sqliteTable` to `pgTable` only in that phase.
- Replace SQLite-specific SQL such as `datetime('now')` with Postgres-friendly
  `now()` / `defaultNow()` style defaults.
- Review `src/repositories/drizzle.ts` for SQLite-specific update expressions.
- `TURSO_AUTH_TOKEN` removal and the changed meaning of `DATABASE_URL` must not
  be mixed with unrelated work.
- Do not generate or apply migrations without user approval.
- Do not change production data assumptions without documenting the migration
  path and rollback risk.

## 7. PDF / File Parsing Rules

PDF parsing is fragile. Be conservative.

- `src/lib/parse-file.ts` and `scripts/copy-pdfjs-assets.mjs` are high-risk
  files.
- `vendor/pdfjs-dist` is ignored by git, but it must be generated during
  `postinstall` / Docker build.
- `@napi-rs/canvas` is required for the pdfjs Node runtime polyfills.
- `next.config.ts` contains `serverExternalPackages: ["@napi-rs/canvas"]`.
- `next.config.ts` contains `outputFileTracingIncludes` for
  `vendor/pdfjs-dist`.
- During the first Azure Container Apps migration phase, do not remove the
  pdfjs vendor strategy.
- If enabling Next.js standalone output, verify PDF parsing in the built
  container before considering the task complete.

## 8. Azure Migration Policy

Proceed in phases. Do not combine phases without explicit user approval.

### Phase 1

- Add Azure OpenAI provider support.
- Conditionally branch Google-specific provider options.
- Update `.env.example`.
- Add Dockerfile and `.dockerignore`.
- Verify or extend `/api/health` for Azure deployment checks.
- Run build / lint / type-check when possible.

### Phase 2

- Migrate from Turso/libSQL to Postgres.
- Change Drizzle schema from SQLite to Postgres.
- Update repository-layer SQL where needed.
- Create migrations after user approval.

### Phase 3

- Add Azure Blob Storage.
- Store original uploaded files.
- Add DB metadata for stored files.
- Adjust upload APIs.

### Phase 4

- Deploy to Azure Container Apps.
- Add GitHub Actions deployment workflow.
- Configure environment variables and secrets.
- Run end-to-end verification.

### Phase 5

- Revisit Vercel 60-second workarounds.
- Improve output quality where Azure runtime allows it.
- Adjust UI wording away from Vercel-specific limits where appropriate.

## 9. What Not To Do Without Approval

- Do not start DB migration.
- Do not generate migrations.
- Do not apply migrations.
- Do not add Blob Storage integration.
- Do not remove the pdfjs vendor strategy.
- Do not enable Next.js standalone output.
- Do not make major UI changes.
- Do not break existing Google/OpenAI provider behavior.
- Do not create, print, or commit `.env` files or secrets.
- Do not hard-code API keys, tokens, connection strings, or deployment secrets.
- Do not change `package.json` or lockfiles unless the approved phase requires
  dependency changes.

## 10. Environment Variable Rules

Currently referenced directly in code:

- `DATABASE_URL`
- `TURSO_AUTH_TOKEN`
- `AI_PROVIDER`
- `AI_MODEL`

Currently listed for provider SDKs in `.env.example`:

- `GOOGLE_GENERATIVE_AI_API_KEY`
- `OPENAI_API_KEY`

Azure migration candidates:

- `AI_PROVIDER=azure`
- `AZURE_RESOURCE_NAME`
- `AZURE_OPENAI_BASE_URL`
- `AZURE_API_KEY`
- `AZURE_OPENAI_DEPLOYMENT_NAME`
- `AZURE_OPENAI_FAST_DEPLOYMENT_NAME`
- `AZURE_OPENAI_API_VERSION`
- `AZURE_STORAGE_CONNECTION_STRING`
- `AZURE_BLOB_CONTAINER_NAME`
- `PORT`

Rules:

- Keep secrets out of git.
- Prefer `.env.example` for names only, never real values.
- Document any env var rename or semantic change in the final report.
- When `DATABASE_URL` changes from Turso/libSQL to Postgres, call that out as a
  breaking deployment change.

## 11. Reporting Rules

Every work report to the user must be in Japanese and include:

- 変更概要
- 変更ファイル一覧
- 実行したコマンド
- 成功した確認
- 失敗した確認
- 未解決の課題
- 次にやるべきこと
- Git diff 要約

If no commands were run, state that explicitly. If checks were skipped, explain
why.

## 12. Language

- Report to the user in Japanese.
- Keep code identifiers, command names, env var names, and technical API names
  in their existing style.
- Match existing code-comment style when editing source files.
