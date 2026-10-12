# Local Development Kitchen

A local Node 22 / TypeScript runner for a human-approved feature workflow. Codex authors by default; independent model review is opt-in at each station, with Claude as the default reviewer when enabled. Providers read the candidate and return structured proposals; the runner writes files and owns executable checks, approvals, Git commits and draft PR publication.

## Start locally

Use the repository's pinned pnpm 9.15.9. No database, queue, Docker service or daemon is required for the runner.

```powershell
pnpm install --filter @hirebus/kitchen --ignore-scripts
pnpm kitchen doctor
pnpm kitchen start completion-notifications --request-file C:/work/request.txt
pnpm kitchen run completion-notifications intent
pnpm kitchen approve completion-notifications intent --actor your-name --minutes 5
```

Authenticate the CLIs separately when doctor reports missing login: `codex login` and `claude auth login`. Doctor does not change accounts or log you in. GitHub is optional until publication. An explicit intended `github.account` in root `kitchen.config.json` is mandatory before pushing; the runner never selects an account for you.

Doctor checks the CLI executables and logins used by station authors and enabled reviewers, then makes a small structured hosted request for every distinct provider/model/executable/Windows-sandbox combination, including station overrides. Disabled reviewer settings and the unused publish author are ignored. These requests consume model quota. Each has a maximum 60-second timeout (or the smaller configured provider timeout); Ctrl+C cancels them. A login alone does not establish model access. Rejected models, quota/network errors, timeouts, and invalid responses fail readiness; skipped requests remain unverified and also cause a nonzero exit.

Model checks identify the configured model and roles. When `model` is omitted, they say `CLI default (inherited)` and test that choice without adding an override. Probes run in separate scratch directories without the feature request or repository instructions. Raw evidence is retained under `.kitchen/doctor/<run-id>/`. Doctor does not rerun a feature station.

Run from the monorepo or a kitchen worktree: the CLI resolves the common repository root. `origin/develop` must exist locally. Start pins that ref without fetching or changing your working checkout. Publication compares it with the remote develop branch again.

## Work through each station

Run and accept each row before advancing. Each execution station makes one authoring/revision pass and validates its output, then pauses for human approval. Independent model review runs only when that station's `reviewEnabled` is `true`. This opt-in also applies to intent and the publish preview. Guided question responses precede the authoring pass. If additional questions remain, status is `awaiting-input`; answer using a subsequent `--feedback-file` or interactive run.

When resuming `awaiting-input`, an interactive `run` asks the saved questions before calling the author again. Each answer is saved immediately, so interrupted input resumes at the remaining questions. A non-interactive `run` without feedback returns the pending state without another provider call. Feedback is retained in the conversation even when the author asks more questions.

Unresolved author questions take precedence over any bundled draft or file proposals. The runner retains the response as local evidence but applies no changes or checks and skips independent review until a fresh candidate contains no questions. Interactive runs collect answers before requesting that candidate; non-interactive runs pause with `awaiting-input`.

| Increment | Station        | Reviewable result                                                                          |
| --------- | -------------- | ------------------------------------------------------------------------------------------ |
| 0         | Foundation     | doctor, isolated worktrees, persisted state, adapters and deterministic fixtures           |
| 1         | intent         | problem, users, outcome, constraints, non-goals, success evidence                          |
| 2         | spec           | stable AC-n definitions, permissions, examples, failures and edge cases                    |
| 3         | plan           | repository-grounded approach, exact file scope, dependencies and rollout                   |
| 4         | test-plan      | AC/check mapping, unit files, preservation vs missing-behavior expectations                |
| 5         | unit-tests     | unit tests, minimal new interfaces, detached-baseline RED, tests-first commit              |
| 6         | implementation | feature code, planned integration/browser tests and GREEN                                  |
| 7         | verify         | business logic, architecture, edge cases, actual flows, test integrity and verification.md |
| 8         | publish        | exact local preview, acceptance, push and recoverable draft PR                             |

```powershell
pnpm kitchen run completion-notifications spec
pnpm kitchen approve completion-notifications spec --actor your-name
# Repeat for plan, test-plan, unit-tests, implementation, verify.
pnpm kitchen status completion-notifications
pnpm kitchen report completion-notifications
pnpm kitchen publish completion-notifications --preview
pnpm kitchen approve completion-notifications publish --actor your-name
pnpm kitchen publish completion-notifications
```

`start --issue https://github.com/HireBus/hirebus-v3/issues/123` records an optional issue link. There is no issue/project management, merge or deployment step. Publication is intentionally a separate human checkpoint.

Documents live in the feature worktree at `docs/features/<feature>/`: `intent.md`, `spec.md`, `plan.md` and `test-plan.md`. Each successful document run writes its draft there. `approve <feature> <station>` commits that document on `codex/kitchen/<feature>` after validating the approval gates and any applicable independent review. Each document gets its own commit; unrelated staged files block approval. The main checkout is unchanged.

The CLI shows station status, the absolute document path, the approval commit and the next command. An `awaiting-input` result lists outstanding questions and has no new candidate document. Add `--json` to `start`, `run`, `approve` or `status` for the complete machine-readable state.

Edit documents in the feature worktree. Frontmatter status is descriptive; it never grants approval. Rerun a station after edits so the edited artifact is validated before acceptance, including independent review when enabled. Use `run --feedback-file <path>` to direct revisions. Accepted document/input changes invalidate later approvals while preserving files.

The plan and test plan contain a visible JSON execution manifest appended by the runner. It records exact file scope, check profiles, test files, scaffold files and RED/GREEN expectations. Review it with the prose. Wildcards are not accepted as write scope. The author reads the existing intent/spec/plan templates and relevant repository instructions.

Generated test-plan check IDs are normalized to lowercase kebab-case before validation, writing the manifest and review; matching document references use those same IDs. Duplicate IDs after normalization remain blockers. Test plans require the exact nonempty headings `## Acceptance coverage`, `## Unit tests`, `## Regression` and `## Required evidence`, including when a feature worktree has an older template.

## Approvals and disputed findings

The local approval record binds the validated artifact, upstream approvals, policy/rubric contents, effective provider and review settings, check profiles, raw execution evidence and relevant source fingerprint. Edits after validation or changes to `reviewEnabled` require a new run (or a new publish preview). A required failed/unverified check cannot be accepted through a reviewer-resolution file.

`approve` checks the station status before asking for your name. An `awaiting-input` station is a normal workflow pause: the CLI lists the saved questions and the next run command, records no approval, and exits successfully. `--json` returns that unchanged pending state. Supply the answers through an interactive run or `run --feedback-file <path>`. Execution stations reach `awaiting-approval` after authoring, validation and any enabled independent review; publish reaches it after preparing and optionally reviewing the exact preview. Failed, stale or unstarted stations still produce an error when approval is attempted.

To dispute a reviewer finding, create a JSON object mapping its finding ID to your evidence-based reason, then use `approve --resolutions <file> --actor <name>`. This records your disagreement. Confirmed blockers require correction and a new run. Profile/coverage/scope failures cannot be waived. `--minutes` records review effort in the report.

## Tests before feature code

The unit-tests station runs accepted test files and approved minimal interface scaffolds in a detached worktree at the original pinned base. Existing production code is not copied from the candidate. Dependencies can be restored with a configured offline, frozen pnpm install; missing packages are infrastructure failures, never RED.

A new-behavior check needs assertion failures for every mapped AC-n. Syntax/import/runtime errors, unexpected passes, missing reports, skipped coverage and zero executed tests block acceptance. A preservation check explicitly uses `expectation: "green"` and may pass at baseline. Tests must include their AC IDs in test names.

Minimal scaffolds are limited to new interfaces: types/signatures with throw-only bodies or `return undefined`. They cannot replace baseline production modules. The coding station can implement those bodies. The runner hashes approved unit tests and preserves a tests-first commit before implementation.

Implementation proposals that rewrite approved unit tests are rejected before any proposed file is written. To revise accepted tests, return to `unit-tests` with `--feedback "AC-2: <requirement-based reason>"`, run any enabled independent review and accept again. Revised tests run at the original base; the original checkpoint stays recorded and revision commits are listed separately. Implementation and verification must run again.

## Configure providers and package checks

Root `kitchen.config.json` supplies versioned finite profiles for the repository's Vitest packages, architecture checks and human observations. Select appropriate profiles in each test plan. Check profiles are human-controlled executable configuration; agents cannot supply arbitrary commands.

```json
{
  "providers": {
    "author": { "provider": "codex", "model": "gpt-6.1-sol" },
    "review": { "provider": "claude", "model": "sonnet" },
    "timeoutMs": 600000
  },
  "stations": {
    "spec": {
      "reviewEnabled": true,
      "author": { "provider": "claude", "model": "sonnet" },
      "review": { "provider": "codex", "model": "gpt-6.1-sol" }
    }
  }
}
```

Set `stations.<station>.reviewEnabled` to `true` to opt that station into independent model review. All eight stations default to `false`, including when the flag is omitted; the checked-in configuration lists each flag explicitly. A `review` provider/model override selects the reviewer but does not enable review. Enabled stations use their `review` override or fall back to `providers.review`. Human approval, document validation, tests-first history and required executable checks apply regardless of the flag. Explicit `evaluate --live` calibration still runs independently of station opt-ins.

Edit the `providers.author.model` and `providers.review.model` fields in root `kitchen.config.json` to select models independently of your global CLI settings. The checked-in configuration makes the existing Codex selection explicit; it does not guarantee that your account/client can use it. Use a model available to your account, then run `pnpm kitchen doctor` to establish access. The doctor and feature stations use the same model settings and request adapter. There is no silent fallback when a selected model is rejected.

For machine-specific settings, create root `kitchen.config.local.json` (Git-ignored). It overrides shared settings, merging provider-role fields and station-role fields while preserving other settings. For example, select the Codex app's bundled CLI without putting a personal path in the shared configuration:

```json
{
  "providers": {
    "author": {
      "executable": "C:/path/to/Codex/bin/runtime-id/codex.exe"
    }
  }
}
```

The model and provider still come from the shared author settings. The chosen CLI reuses its saved login; Kitchen does not copy credentials, switch accounts, or require an API key for ChatGPT sign-in. A global `codex` command can resolve to an older CLI than the desktop app uses. If a model works in the app but the CLI rejects it, compare the versions and test the app's bundled executable. Doctor prints the selected executable with its version. Update the local executable path if an app update moves it; configure any additional Codex station roles the same way when needed.

To run Codex's Windows sandbox without administrator setup, add `"windowsSandbox": "unelevated"` to each Codex role you use, normally in `kitchen.config.local.json`:

```json
{
  "providers": {
    "author": { "windowsSandbox": "unelevated" }
  }
}
```

Merge this field with any existing local executable setting. Kitchen passes `-c windows.sandbox="unelevated"` to Codex for both model probes and station requests; its `--sandbox read-only` policy stays in place. The setting changes only Kitchen's Codex child processes and keeps the existing ChatGPT login. Set any explicit Codex station role overrides separately. Omit the field to inherit Codex's default, or select `"elevated"` explicitly. Doctor and process evidence identify the requested selection; model-only doctor probes do not establish tool readiness.

Codex's [unelevated mode](https://learn.chatgpt.com/docs/windows/windows-sandbox) uses a restricted token with ACL filesystem boundaries and weaker network isolation than elevated mode. Administrator-managed requirements may disallow it; Kitchen reports the provider's rejection instead of overriding those requirements. This Windows-only option does not apply to Claude.

Merge overrides into the existing configuration. A station role overrides that entire default role, so include its model explicitly when desired. Omit `model` to inherit the CLI's model choice. Empty model strings are rejected. An optional `executable` selects a trusted CLI path (also used by the fake-executable tests). Provider usage/error metadata is retained when the CLI emits it. Provider failures include structured stdout errors as well as stderr diagnostics.

Each execution has a finite timeout and command/argument array. Unit/integration/browser profiles require JSON reports with executed counts. Plain command profiles establish lint/types/architecture evidence and cannot establish behavioral AC coverage. New dependencies must already be available in the local pnpm store or be installed deliberately before offline baseline setup can succeed.

For an additional package, add a versioned profile with an exact cwd, command, arguments, parser and timeout. `{files}` expands to absolute candidate paths. No watch/dev commands or pass-with-no-tests behavior is allowed. Non-unit checks are run at implementation and verification, with final GREEN required.

## Local integration and browser checks

Integration/browser profiles require an existing disposable local fixture path. Explicit endpoint environment settings must be loopback URLs/hosts. A worktree isolates source and Git state; it is not an operating-system or network security sandbox. Inspect test configuration and use disposable local services. The runner does not provision Docker or databases.

Browser profiles must build the candidate, start their own preview on an assigned dedicated port, and pass `{baseUrl}` to the browser test command. The runner stops only the preview process tree it started. Existing `pnpm dev` services are preserved. Use a dedicated browser config that does not start/reuse another dev server.

Example profile to adapt and review for your package:

```json
{
  "version": "1.0.0",
  "kind": "browser",
  "cwd": "apps/example",
  "command": "node",
  "args": ["test/kitchen-browser-check.mjs", "{baseUrl}", "{files}"],
  "parser": "playwright-json",
  "fixture": "test/fixtures/local.json",
  "timeoutMs": 180000,
  "preview": {
    "build": { "command": "pnpm", "args": ["build"] },
    "command": "pnpm",
    "args": [
      "exec",
      "vite",
      "preview",
      "--host",
      "127.0.0.1",
      "--port",
      "{port}",
      "--strictPort"
    ]
  }
}
```

Implement the package's planned `test/kitchen-browser-check.mjs` wrapper to accept that URL, invoke Playwright with a dedicated config and JSON reporter, and set `use.baseURL` from `KITCHEN_BASE_URL`. The wrapper/config belong in the approved file scope and integration test plan. The explicit argument plus environment makes the target reviewable; missing wrappers or fixtures block verification.

Manual profile observations are passed via `run --observations <json>`:

```json
[
  {
    "id": "owner-flow",
    "status": "passed",
    "observation": "Created a completion in local company A; its owner saw exactly one notification.",
    "evidence": ["docs/features/completion-notifications/flow-observation.txt"]
  }
]
```

Evidence paths must exist in the candidate and be included in approved scope if committed. The runner snapshots their contents locally. N/A observations need an explicit `reason`. Required missing observations block acceptance.

## Verifier calibration

Each station has a versioned rubric and acceptable/flawed examples under `rubrics/` and `examples/`. The supplied labels are proposals, not claims of human calibration.

```powershell
pnpm kitchen evaluate spec
pnpm kitchen evaluate spec --labels C:/work/spec-labels.json --live
```

Label JSON maps IDs such as `spec-acceptable` and `spec-flawed` to `acceptable` or `flawed`. Without human labels and explicit `--live`, no hosted model calls or quality measurements run. Evaluation stores missed problems, unnecessary findings, per-case findings, labels and rubric version locally. Add realistic company examples as you discover failures. Review effort is collected with station acceptance.

## Persistence, cancellation and recovery

`.kitchen/features/<feature>/` contains atomic JSON state, approvals, conversations, raw transcripts, evidence, publication preview/body and per-run IDs. Worktrees are in `.kitchen/worktrees/`; detached RED baselines are retained in `.kitchen/baselines/` for diagnosis. Everything under `.kitchen/` is ignored.

Ctrl+C cancels owned provider/check subprocess trees. Finite timeouts prevent unattended hangs. Per-feature process locks reject concurrent mutations; the next command recovers a dead process's running station as failed, requiring a rerun. Provider/schema failures remain inspectable and retryable. Raw local files are trusted operator storage, not an access-control boundary.

`run` prints provider/station progress to stderr, including Codex tool starts/results and a 15-second heartbeat. Its final JSON remains on stdout. Each provider directory under `runs/<run-id>/` gets `<role>-events.jsonl` (raw stdout) and `<role>-stderr.log`, appended during execution; `<role>-process.json` records the final result and any `failureReason`. Claude currently supplies a final JSON response, so its intermediate progress is the heartbeat.

Known Codex Windows sandbox setup failures stop the owned provider process promptly and mark the station failed as an infrastructure error. Ordinary tool failures remain available for agent recovery. When the error says `setup refresh had errors`, correlate the run's stderr timestamp with `%USERPROFILE%\.codex\.sandbox\sandbox.<date>.log` for the underlying Windows error. A successful model-only doctor probe does not verify sandbox tool execution.

Publication rechecks source, accepted tests, branch, local/remote base, every origin fetch/push destination and intended GitHub identity. It uses a body file and explicit repository/base/head. No force pushes. A remote/base reconciliation that changes the candidate requires renewed approvals and verification. Retrying after an unknown create result recovers an existing open PR before creating another.

## Validate the framework

```powershell
pnpm --filter @hirebus/kitchen test
pnpm --filter @hirebus/kitchen check:types
pnpm --filter @hirebus/kitchen lint
```

Tests use temporary Git repositories, fake provider executables, fake GitHub writes and a local preview server. No paid hosted model calls or real PRs run in the test suite. Hosted availability checks run when you invoke `doctor`; live verifier calibration requires `evaluate --live`. Model quality remains to be calibrated by you.

Provider interfaces follow [Codex non-interactive execution](https://learn.chatgpt.com/docs/non-interactive-mode), [Codex configuration](https://learn.chatgpt.com/docs/config-file/config-reference), [Claude headless execution](https://code.claude.com/docs/en/headless) and [Claude CLI flags](https://code.claude.com/docs/en/cli-reference). Adapters use fresh read-only sessions, disable user hooks/plugins/MCP integrations, and use configured models or inherited CLI defaults. Machine-managed provider policy remains trusted infrastructure.
