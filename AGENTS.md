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
- Postgres via `pg` and `drizzle-orm/node-postgres`
- pnpm
- PDF/DOCX/TXT parsing via `pdfjs-dist`, `@napi-rs/canvas`, and `mammoth`
- OCR/layout fallback via Azure AI Document Intelligence when configured

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

Current database stack after Phase 2:

- Drizzle ORM
- Postgres
- `drizzle.config.ts` uses `dialect: "postgresql"`
- `src/db/index.ts` uses `drizzle-orm/node-postgres`
- `src/db/schema.ts` uses `pgTable`

Postgres migration rules:

- Treat DB changes as dedicated, potentially breaking phases.
- Keep `DATABASE_URL` as the Postgres connection string.
- Use Postgres-friendly `now()` / `defaultNow()` style defaults.
- Review `src/repositories/drizzle.ts` for SQL expressions when changing
  database behavior.
- The Turso/libSQL stack has been removed from code during Phase 2. Do not
  reintroduce `TURSO_AUTH_TOKEN`, `@libsql/client`, or `drizzle-orm/libsql`
  without user approval.
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
- `AI_PROVIDER`
- `AI_MODEL`
- `AZURE_RESOURCE_NAME`
- `AZURE_OPENAI_BASE_URL`
- `AZURE_API_KEY`
- `AZURE_OPENAI_DEPLOYMENT_NAME`
- `AZURE_OPENAI_FAST_DEPLOYMENT_NAME`
- `AZURE_OPENAI_API_VERSION`
- `AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT`
- `AZURE_DOCUMENT_INTELLIGENCE_KEY`

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
- `AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT`
- `AZURE_DOCUMENT_INTELLIGENCE_KEY`
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

Every progress or completion report must also include two independent headings:

- `## 🚨 Codexへの指示`: if another instruction is needed, show the exact text
  in a code block. Prefer only `Issue #Nを進めて` or `PR #Nを進めて` when the
  GitHub handoff is self-contained. If nothing is needed, state
  `現在、Codexへの指示はありません`. Do not restate a long prompt unless a
  short Local-only execution hint cannot be stored on public GitHub.
- `## 作業の区切り`: choose exactly one of `地続きで続行`,
  `ここで一時休憩OK`, `ここでセッション切替OK`, or `作業完了`.

If Local priority work has reached a clean stopping point, or the user has
explicitly deferred it, at most one other Open Issue may be suggested as
`別タスク（任意）`. Keep it separate from mandatory continuation work.

If no commands were run, state that explicitly. If checks were skipped, explain
why.

## 12. Language

- Report to the user in Japanese.
- Keep code identifiers, command names, env var names, and technical API names
  in their existing style.
- Match existing code-comment style when editing source files.

## 13. GitHub Issue Driven / Codex Operations

Each implementation Issue body is the sole source of truth for its task,
required behavior, and acceptance criteria. GitHub Issues and pull requests
are the source of truth for progress, verification, re-verification, and
handoff. The Issue body must be a self-contained instruction that lets the
assigned Codex proceed from start through PR creation using that body alone.
Every mandatory instruction must appear there; links to public GitHub
information may provide context or evidence but must not replace required
instructions. Confirm current state from the Issue, related PRs, CI, and the
default branch.

### Self-contained Issues and GitHub Handoff

Each implementation Issue must state the purpose, editable scope, prohibited
scope, required work, acceptance criteria, out-of-scope items, required tests,
Production/deploy impact, rollback, execution route, start and completion state
transitions, and dependencies. Chat messages and past conversations are not
required specifications. The normal start instruction should be only
`Issue #Nを進めて`; never ask the user to relay a long prompt between ChatGPT,
Cloud Codex, Local Codex, or a verifier.

A Local Codex start message may include a short Local-only execution hint that
must not be written to public GitHub. It may describe how to identify or copy an
already-saved local file, but it is not part of the formal specification and
must not alter or fill gaps in purpose, scope, acceptance criteria, priority,
design decisions, or required tests. Never transfer personal paths, customer or
case details, secrets, or real-case content from that hint into GitHub. Cloud
Codex must ignore Local-only execution hints and use GitHub alone as its source
of truth.

Before adding an execution-route label or creating a branch, confirm that the
Issue is self-contained and internally consistent. ChatGPT must not add an
execution-route label to an incomplete Issue. If information is missing,
contradictory, or awaiting a decision, record the missing items on the Issue,
add the appropriate stop label such as `codex:blocked`, and stop before branch
creation. Do not expand scope by consulting chat history or restricted files.

Record start information, correction requests, test evidence for the exact
head SHA, re-verification, unresolved items, and handoff in the Issue or PR.
Cloud and Local workers and verifiers must complete their handoffs on GitHub;
the user is not a message relay between Codex environments.

The repository is public. Cloud work may use only public code, public
information, published documents, fictional data, or irreversibly anonymized
data. Do not retrieve, inspect, quote, summarize, generate, or write the
following into Issues, pull requests, comments, commits, or Actions logs:

- unpublished inventions, claims, specifications, or drawings;
- customer names, case names, contracts, or personal information;
- real-case J-PlatPat search results or investigation materials;
- customer-provided PDF, DOCX, CSV, or image files;
- Production DB contents or secret logs;
- API keys, tokens, passwords, connection strings, or authenticated URLs;
- personal local filesystem paths or account-specific information.

If a task requires any of the above or requires a Local-only environment, stop
Cloud work, remove `codex:in-progress`, add `codex:blocked`, and record only a
generalized reason. Do not expand scope to inspect restricted material.

### Labels

- `codex:cloud-ready`: Cloud Codex implementation and conditional automatic
  merge are approved. Workers must not add this label themselves.
- `codex:local-only`: Local Codex only.
- `data:confidential`: contains confidential or real data; do not put its
  contents on public GitHub.
- `codex:in-progress`: Codex work is active.
- `codex:needs-review`: waiting for PR verification.
- `codex:fix-required`: changes are required before verification can pass.
- `codex:local-verified`: required Local verification is complete.
- `codex:blocked`: blocked by an external decision, information, or environment.
- `codex:automation-pause`: if present on any Open Issue, all automation stops.
- `codex:no-auto-merge`: verify the PR but do not merge automatically.
- `priority:P0`: highest priority.
- `priority:P1`: high priority.
- `priority:P2`: normal priority.
- `priority:P3`: low priority.

### State Flow

Use this flow unless an Issue explicitly requires a stricter one:

1. Select one eligible, self-contained Open Issue. If it is incomplete, record
   the missing information and stop before creating a branch.
2. Add `codex:in-progress` and create a dedicated branch from the latest default
   branch. Prefer `codex/issue-<number>-<slug>`.
3. Implement only the Issue scope and run the required checks.
4. Open a PR to the default branch, add `codex:needs-review`, and remove
   `codex:in-progress` from the Issue.
5. The verifier checks the Issue, exact PR head, diff, CI, acceptance criteria,
   information safety, conflicts, and unresolved reviews.
6. If all merge conditions are satisfied, use Squash Merge and close the linked
   Issue via `Closes #...`.

Do not work on the same Issue in Cloud and Local at the same time. Direct pushes
to `main` are prohibited by default. Do not add features, future expansion, or
preemptive optimization that the Issue does not require.

When reporting verification, explicitly state any test that was not run, any UI
that was not visually confirmed, and any Production behavior that was not
confirmed. Never report an unexecuted check as successful.
