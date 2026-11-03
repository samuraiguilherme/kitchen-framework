# Claude as the primary workflow author

Status: implementation available; full live qualification awaits human
checkpoints. Prepared and implemented 2026-11-03.

## Implementation results

Initialization now accepts `--author claude --review codex`, reports effective
roles and validates local overrides before writing. Doctor probes active author,
review and enabled discovery response contracts separately while sharing CLI and
authentication checks. The package includes the Claude configuration example;
the live smoke harness uses a disposable project, real assertions and normal
human answers and approval commands.

The live canary passed Claude author/discovery probes, a Codex reviewer probe
and a repository read proof. Claude Code was version 2.1.294 and the selected
desktop-bundled Codex CLI was 0.166.0-alpha.5.1, with inherited model defaults.
The older global Codex CLI rejected its configured model; only the canary's
ignored local reviewer configuration was changed to select the bundled CLI.
Both attempts remain in `.kitchen/validation/claude-primary/live-canary/`.

The canary is paused at its intent audience question. Resuming without an answer
returns the pending state without another provider call. Later live document,
RED/GREEN, review and publication-preview checkpoints remain unqualified until
the human supplies answers and approvals. The retained `report.json` records
this as `awaiting-input` rather than a completed qualification.

Validation passed: 348 tests across 24 files on Node 26.13.0, TypeScript checking,
lint with zero warnings, and `npm pack --dry-run` confirming the Claude example
is included. The regression process suppressed only the existing Node 26/tsx
`DEP0205` warning, which otherwise breaks CLI assertions requiring empty stderr.
The three focused smoke tests also passed after the final reporting correction.
Reports are `.kitchen/validation/claude-primary/tests-final.json` and
`.kitchen/validation/claude-primary/smoke-final.json`.

## Description

Make Claude a documented, selectable and verified primary actor throughout
Kitchen. Use the existing `author` role for intent, spec, plan, test-plan,
unit-tests, implementation and verify. Claude returns structured documents,
questions and file proposals; Kitchen applies changes, executes checks, records
human approvals and performs Git/GitHub operations.

The configuration and adapter already accept Claude authors. The work is to
expose that choice during initialization, verify author and discovery behavior,
and qualify the complete flow. Keep the current Codex author default for projects
that do not select another provider. Reuse config version 1 and existing feature
state; an additional `primaryActor` field or orchestration engine is unnecessary.

## Starting behavior

| Area | Existing support or gap |
| --- | --- |
| Roles and configuration | `src/types.ts` and `src/config.ts` allow `claude` in global and station author roles. Switching providers replaces the previous role settings, avoiding inherited Codex sandbox/model/executable options. |
| Adapter | `src/providers.ts` chooses `authorSchema` by request role, parses Claude's `structured_output`, and exposes only `Read,Glob,Grep` for station calls. |
| Workflow | `src/kitchen.ts` selects the effective author for each execution station. `src/discovery.ts` uses the effective plan author for optional repository discovery. Publish has a runner-generated preview and an optional reviewer, with no author call. |
| Initialization | `src/project.ts` hardcodes Codex author and Claude reviewer; `src/cli.ts` provides no provider selection at initialization. |
| Readiness | Doctor enumerates active author and reviewer settings, but `probeProvider` always requests `ReviewOutput`. A passing probe does not establish author-schema or repository-tool readiness. |
| Coverage and guidance | The README shows Claude as a spec author, and parser tests accept a Claude author envelope. Hosted executable fixtures exercise reviewer responses; they do not establish a complete Claude author flow. |

## Target behavior

For an existing project, the role selection already has this shape in shared
configuration or a machine-local override:

```json
{
  "providers": {
    "author": { "provider": "claude" },
    "review": { "provider": "codex" }
  }
}
```

Omitted models inherit each CLI's default. Existing station author overrides
still take precedence, so adopting Claude throughout a project includes checking
those overrides. Selecting a reviewer does not enable review: each station keeps
its explicit `reviewEnabled` policy. Recommend Codex for cross-provider review
when Claude authors; preserve support for separately configured roles and fresh
review sessions.

Add this initialization path for new projects:

```powershell
kitchen init --author claude --review codex
kitchen doctor
```

The proposed `--author` and `--review` flags select `codex` or `claude`; DeepSeek
continues to use its existing configuration with required model/runtime settings.
Each omitted flag retains its current initialization default. Supplying only
`--author claude` therefore retains Claude as the configured reviewer; the
explicit pair above selects cross-provider review. Review stays opt-in.

On an existing configuration, matching selections are idempotent. Conflicting
selections fail before any initialization writes and point to the configuration
fields to edit, following the existing `--base` behavior. These flags apply only
to `init`; configuration remains the persistent source of provider selection.

## Acceptance criteria

| ID | Required behavior |
| --- | --- |
| AC-1 | Global Claude author configuration routes all seven execution stations to Claude unless a station explicitly overrides it. Optional discovery uses the effective plan author. |
| AC-2 | New projects can select Claude author and Codex reviewer during initialization. Existing defaults, repeated initialization and existing user files retain their current behavior. Invalid or conflicting selections produce actionable errors before writes. |
| AC-3 | Claude author calls return validated `AuthorOutput`, including complete file contents and human questions. Discovery and reviewer calls use their own schemas. Malformed JSON, permission denials, provider errors, timeout and cancellation retain evidence and fail the run. |
| AC-4 | Claude authors have the same read-only tool policy and fresh sessions as current Claude reviewers. Kitchen alone applies proposals and executes checks. Scope enforcement, approved-test protection, baseline RED, final GREEN and human approval continue to gate progress. |
| AC-5 | Doctor verifies the response contracts needed by each active provider configuration and labels the role, model, executable and evidence. An unused Codex reviewer does not become required when review is disabled. |
| AC-6 | Switching the effective author/model/configuration makes affected approvals stale and invalidates applicable discovery caches. Disabled reviewer changes and an unused publish author retain their existing fingerprint semantics. |
| AC-7 | The complete Claude author fixture reaches publish preview with the selected reviewer when enabled. Preview requires human approval before publication; publication uses the runner's GitHub gateway and makes no author call. |
| AC-8 | Packaged examples and setup guidance explain Claude throughout the flow, station overrides, optional review, qualification and rollback. Live qualification records the selected CLI/model and evidence separately from deterministic fixture results. |

## Files to change

| Path | Planned change |
| --- | --- |
| `src/cli.ts`, `src/project.ts` | Add and validate initialization role options; report effective roles in initialization output and additive JSON fields. Preserve existing config and local overrides. |
| `src/providers.ts`, `src/doctor.ts` | Make readiness probes select author, review or discovery contracts; deduplicate by effective configuration and response contract, and retain contract-specific evidence. |
| `test/project.test.ts`, `test/cli.test.ts`, `test/config.test.ts` | Cover initialization selections, defaults, invalid/conflicting inputs, local overlays and station precedence, including switching from a Codex role with provider-specific settings. |
| `test/providers.test.ts`, `test/hosted-adapters.test.ts`, `test/doctor.test.ts` | Exercise Claude author/discovery schemas through fake executables, read-only invocation, role-aware probes and failure evidence. |
| `test/workflow.test.ts`, `test/discovery.test.ts` | Cover Claude author routing, the complete station sequence, optional review/discovery, existing gates and provider-change invalidation. |
| `scripts/smoke-claude.ts` new | Provide an explicit live qualification harness using a disposable Git project and configured finite checks. Retain results under `.kitchen/validation/claude-primary/`. |
| `kitchen.config.claude.example.json` new, `README.md`, `package.json` | Ship a complete Claude author/Codex reviewer example, document initialization and existing-project adoption, and include the example in the package archive. |

Routing, prompts, schemas and fingerprints already support provider-independent
authors. Change `src/kitchen.ts`, `src/discovery.ts`, `src/prompts.ts`,
`src/config.ts` or `src/types.ts` only if a behavioral test exposes a missing
contract; preserve unrelated DeepSeek work in those files.

## Steps to implement

1. **Establish Claude author behavior.** Extend the hosted executable fixture to
   emit valid author, review and discovery envelopes according to the requested
   schema. Cover a document, questions, multiple complete file proposals and
   discovery citations. Assert literal stdin/model arguments and the existing
   read-only tool, hook, MCP and session settings for authors. Verify that a
   review-shaped response cannot pass an author call and that failed responses
   preserve process evidence. Keep the installed CLI help/version as the
   compatibility reference before changing invocation flags.

2. **Expose initialization choices.** Add `--author` and `--review`, validate
   values and command scope before writes, and pass selections to
   `initializeProject`. Preserve default roles when flags are absent. Check
   conflicting selections against the loaded effective configuration, including
   local overrides, before creating templates or ignore entries. Add role fields
   to initialization results so both text and JSON show the effective choice.
   Verify new, repeated and conflicting initialization in disposable repositories.

3. **Probe the contracts actually used.** Extend the probe interface with an
   explicit response contract while retaining a review default for existing
   callers. Author probes request the full `AuthorOutput` shape with empty
   proposals; discovery probes request `DiscoveryResult`. Doctor runs one probe
   per distinct active configuration/contract, ignoring disabled review and
   publish authors. Add discovery probes only when discovery is enabled, using
   the effective plan author. Keep version/auth checks deduplicated by executable,
   probes tool-free in scratch directories, and current timeout/cancellation
   limits. Update evidence paths and probe fixtures for all existing providers.
   Verify that review success cannot mask an author-contract failure.

4. **Verify the complete flow.** Configure the workflow fixture with Claude
   author and Codex reviewer, record provider/model/role on every request, and
   run intent through verification and publish preview. Exercise review enabled
   and disabled, a station author override, question resumption and discovery.
   Reuse existing tests for atomic proposal application, scope violations,
   approved-test protection and RED/GREEN gates. Add targeted cases for author
   switching, stale approvals and discovery reuse. Use the fake GitHub gateway
   for publication so the fixture proves runner ownership without a remote push.

5. **Package guidance and qualify live behavior.** Add the Claude example and
   README instructions, including how to inspect station/local overrides and
   rerun affected stages after changing roles. Build the live smoke harness
   around a small existing module with one observable behavior change, accepted
   document checkpoints, a unit test failing at baseline, implementation GREEN
   and verification. Use normal human approval commands at every checkpoint;
   the harness reports the next command and resumes from persisted state.
   End live qualification at an approved publish preview. Record actual model
   identity when emitted, configured model/default, CLI version, outcomes and
   raw evidence; label unavailable usage as unknown. Qualify a real repository
   read separately from the tool-free doctor probe.

## Order of the work

Start with adapter and routing characterization. Add failing behavioral tests
before each new initialization/readiness behavior, then implement that slice.
Complete the workflow fixture before live qualification. Keep this a single
provider-selection feature; existing branch names such as `codex/kitchen/...`
remain compatible and do not determine which provider authors a station.

## Test plan

Run focused suites while implementing each slice. The final automated gate is
`pnpm test`, `pnpm check:types` and `pnpm lint`, followed by an archive inspection
using `npm pack --dry-run` to confirm the new configuration example ships.
Deterministic tests use fake providers/executables and a fake GitHub gateway;
they require no hosted credentials or model calls.

Live qualification is a separate explicit run against a disposable project.
Require successful document and file authoring, an actual repository read,
baseline behavioral RED, final GREEN, question/resume behavior, enabled Codex
review and approved publication preview. Include a discovery run when enabled.
Preserve every failed attempt; a doctor pass or parser fixture alone cannot
qualify Claude as the primary workflow author.

## Risks and rollout

| Risk | Mitigation |
| --- | --- |
| Old station/local overrides keep some author calls on Codex. | Show effective initialization/doctor roles and document override precedence; assert every request in the workflow fixture. |
| Installed Claude CLI behavior differs from fake envelopes or flags. | Check installed help/version and require the live structured-output and repository-read qualification. |
| Author outputs exceed practical generation limits or omit file content. | Qualify a multi-file proposal and retain failures; require complete schema-valid output before application. |
| Broader doctor coverage consumes more hosted quota. | Deduplicate by configuration/contract, probe active roles only, and keep requests small and tool-free. |
| Shared adapter changes affect Codex or DeepSeek. | Keep their deterministic probe/adapter regressions in the final gate and avoid unrelated adapter changes. |

Roll out as an explicit project choice using the example or machine-local role
override. Preserve the existing default configuration and feature history.
Changing the author for an active feature requires rerunning affected stations
and renewing their approvals. Roll back by restoring the previous complete role
objects, rerunning doctor and affected stations, and retaining the original run
evidence. No feature-state migration or credential transfer is required.
