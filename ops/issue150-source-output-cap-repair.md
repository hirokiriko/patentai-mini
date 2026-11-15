# Issue150: partitioned source output capacity

The retained public-sample trial stopped during source claim 1, part 2 of 3. The second physical request consumed its entire 32,400-token output allowance while retaining only an incomplete 35-character JSON prefix. Reasoning and visible output share this allowance; the retained source audit does not include a provider reasoning-token breakdown. Review was not reached.

For explicitly partitioned source requests, use medium reasoning instead of high. Whole-claim medium, unspecified-call high, later-phase low, the output/time ceilings, default service tier, no-retry behavior, original inputs, schema, coverage checks and raw audit remain unchanged. This is a bounded capacity adjustment, not evidence of semantic accuracy or a successful real-AI comparison. No additional AI execution or deployment is authorized by this change.

The unchanged failure must remain failed; partial JSON must never be adopted or saved as success. Validate the normal serialized Azure request and existing truncated-output failure regressions offline. Subsequent live acceptance remains subject to the existing finite execution authorization and full save/reload/PDF/CSV/source review; this offline change does not establish real-AI success.

## Offline verification

The scoped 10-file regression run passed all 346 tests, covering provider options, the installed SDK's serialized request, incomplete source output with no retry or adopted answer, source plans, usage/budget guards, route persistence behavior, context and branch continuity, conditional properties and identified source wire contracts. The SDK fixture consumes the unchanged 32,400 output limit and fails with `source_reading/output_incomplete`, retaining raw failure text and no source answers.

The initial `pnpm exec` dependency precheck attempted an implicit install and stopped at a sandbox store-link EPERM before installation; no dependency files changed. Disabling the precheck and using the system Node 22 runner each exited without output. Verification used the already-installed tools through the bundled Node 24 executable, with no package installation or network execution.

Type checking passed. Repository lint passed with six existing unused-variable warnings in unchanged scripts. The standard Next.js build stopped because Turbopack rejects the pre-existing `node_modules` junction pointing outside this worktree's filesystem root. Dependency layout and build configuration were left unchanged. `git diff --check` passed. Real-AI success remains unverified.
