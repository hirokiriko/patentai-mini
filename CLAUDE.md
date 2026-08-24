# CLAUDE.md

This file provides repository-specific guidance for Claude Code and other local
assistants. `AGENTS.md` is the primary agent policy; do not add rules here that
conflict with it.

## Project overview

`patentai-mini` is a patent prior-art check PoC. It supports draft parsing,
claim extraction, J-PlatPat query generation, prior-art import, and overlap or
risk-signal review.

It is not a legal judgment system. Describe results as investigation support,
comparison support, issue extraction, overlap candidates, match candidates, or
risk signals that require human review. Do not state legal conclusions about
patentability, validity, infringement, or rejection outcomes.

## Canonical workflow

- Read the latest `AGENTS.md` before making changes.
- GitHub Issues are the source of truth for tasks, scope, acceptance criteria,
  progress, validation, and handoff.
- Each Issue should be self-contained so an agent can complete it without
  relying on chat history or an unpublished prompt.
- Record agent handoffs, correction requests, and public-safe validation on the
  relevant Issue or pull request.
- `ops/tasks.md`, `ops/session-log.md`, and `ops/handoff.md` are historical
  records from before the Issue Driven workflow. Do not update them as current
  task trackers.
- `ops/decisions.md` remains the canonical record for durable design decisions.
- Confirm current state from the default branch, CI, and—when authorized—the
  relevant runtime environment rather than relying on historical notes.

A Local Codex start message may include a short Local-only execution hint that
must not be written to public GitHub, such as how to identify or copy an
already-saved local file. Such a hint is not a specification: it must not alter
or fill gaps in the purpose, scope, acceptance criteria, design decisions,
priority, or required tests. If the Issue is incomplete, update the Issue or
stop with the appropriate label instead. Never copy Local-only details into
GitHub, and Cloud Codex must work from GitHub alone.

Never copy secrets, credentials, customer or case material, unpublished patent
content, production data, authenticated URLs, personal paths, device details,
or individual account information into Issues, pull requests, commits, logs, or
agent documents. Use classifications and PASS/FAIL results without reproducing
the detected value.

## Current stack

- Next.js 16 / React 19 with App Router
- TypeScript
- AI SDK with Google, OpenAI, and Azure OpenAI provider support
- Drizzle ORM with Postgres (`pg` and `drizzle-orm/node-postgres`)
- pnpm
- PDF/DOCX/TXT parsing with `pdfjs-dist`, `@napi-rs/canvas`, and `mammoth`
- Optional Azure AI Document Intelligence fallback when configured
- Azure Container Apps deployment

## Commands

Use pnpm. Do not switch package managers or install dependencies unless the
approved Issue requires it.

```bash
pnpm dev
pnpm build
pnpm start
pnpm lint
pnpm type-check
pnpm db:generate
pnpm db:migrate
pnpm db:push
pnpm db:studio
```

`postinstall` runs `node scripts/copy-pdfjs-assets.mjs` to prepare PDF.js assets
under `vendor/pdfjs-dist`.

Do not generate or apply migrations without explicit approval. Run the checks
required by the active Issue and report any skipped check with its reason.

## Repository structure

- `src/app`: App Router pages, layouts, and client components
- `src/app/api`: case, draft, prior-art, query, analysis, integration, and
  health-check Route Handlers
- `src/components`: shared UI components
- `src/lib`: AI provider selection, parsing, extraction, query generation,
  overlap analysis, and claim integration
- `src/db`: Drizzle Postgres connection and schema
- `src/repositories`: repository interfaces and Drizzle implementation
- `scripts`: utility and migration scripts
- `.github/workflows`: CI and deployment workflows
- `docs` and `ops`: product, architecture, operational, and decision records

## Database rules

- The current database is Postgres through Drizzle ORM.
- `drizzle.config.ts` uses the `postgresql` dialect.
- `src/db/index.ts` uses `drizzle-orm/node-postgres`.
- `src/db/schema.ts` uses Postgres table definitions.
- `DATABASE_URL` is the Postgres connection string.
- The former Turso/libSQL implementation is superseded. Do not reintroduce it
  without explicit approval.
- Treat schema, migration, and production-data work as dedicated high-risk
  changes with a documented migration path and rollback.

## AI provider rules

- `AI_PROVIDER` supports `google`, `openai`, and `azure`.
- Keep `getModel()` and `getFastModel()` responsibilities separate.
- Azure OpenAI uses deployment names rather than generic model names.
- Apply Google-specific provider options only when the Google provider is in
  use.
- Preserve structured-output compatibility at `generateObject` call sites.
- Do not break an existing provider while changing another provider.

Configuration names may be documented, but values must never be committed or
printed. Refer to `.env.example` for the supported names.

## Azure Container Apps deployment

The current deployment path is `.github/workflows/azure-container-apps.yml`.
It can run manually or for the configured changes on `main`, authenticates to
Azure with OIDC, builds and pushes commit-SHA and `latest` image tags to Azure
Container Registry, and updates the existing Container App image.

The workflow does not create Azure resources, apply database migrations, or set
runtime environment variables. Resource provisioning, secrets, and runtime
configuration remain separately controlled. Do not deploy or change Azure
resources unless the active Issue explicitly authorizes it.

## PDF and file parsing

- Treat `src/lib/parse-file.ts` and `scripts/copy-pdfjs-assets.mjs` as
  high-risk files.
- Preserve the checked-in build strategy that generates `vendor/pdfjs-dist`
  during installation or container build.
- Keep `@napi-rs/canvas` and the related Next.js tracing/external-package
  configuration unless a dedicated Issue authorizes and verifies a change.
- Verify PDF parsing in the built container before changing packaging behavior.

## Domain rules

- Keep independent and dependent claims distinct.
- Decompose claims into elements, relationships, constraints, and effects.
- Generate broad, balanced, and narrow query variants.
- Do not infer undocumented J-PlatPat CSV or PDF behavior as fact.
- Preserve existing API and type contracts unless the active Issue calls for a
  change.

## Reporting

Report work in Japanese. Include the change summary, changed files, commands,
successful and failed checks, unresolved items, recommended next action, and a
Git diff summary. Keep all reporting public-safe.

Every progress or completion report must also include these two independent
headings:

- `## 🚨 Codexへの指示`: show the exact next instruction in a code block. For a
  self-contained GitHub handoff, prefer only `Issue #Nを進めて` or
  `PR #Nを進めて`. If no instruction is needed, state
  `現在、Codexへの指示はありません`. Do not restate long prompts except for a
  short Local-only execution hint that cannot be stored on public GitHub.
- `## 作業の区切り`: choose exactly one of `地続きで続行`,
  `ここで一時休憩OK`, `ここでセッション切替OK`, or `作業完了`.

When Local priority work has reached a clean stopping point, or the user has
explicitly deferred it, at most one other Open Issue may be suggested as
`別タスク（任意）`. Keep that separate from mandatory continuation work and do
not imply it is required to finish the current Issue.
