# Local Development Kitchen

## Summary

Provide a standalone Kitchen package and `kitchen` CLI for Git projects. The human accepts every station. The runner owns writes, checks, approvals, commits and publication; hosted providers propose structured artifacts and independently review them.

## Requirements and acceptance criteria

| ID   | Requirement              | Acceptance criteria                                                                                                                                                                                                           |
| ---- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC-1 | Isolate features         | start creates codex/kitchen/<feature> at a recorded configured base commit in ignored storage; the original checkout remains unchanged.                                                                                        |
| AC-2 | Bound provider execution | Fresh read-only author/review calls validate JSON, capture errors/usage when available, and stop on timeout/cancellation. Models inherit CLI defaults unless configured.                                                      |
| AC-3 | Human station gates      | intent, spec, plan and test-plan are editable and reviewed. Explicit acceptance binds artifacts and inputs; changed upstream content invalidates dependent approvals. Frontmatter never authorizes advancement.               |
| AC-4 | Tests before code        | Required unit tests execute at the pinned baseline. New behavior reaches assertion failures; preservation tests may pass. Infrastructure failures/zero tests cannot establish RED. Acceptance preserves a tests-first commit. |
| AC-5 | Preserve test integrity  | Coding requires accepted tests and baseline evidence. Attempts to rewrite approved tests reject the entire proposal. Requirement-based revisions return to independent review and baseline execution.                         |
| AC-6 | Verify actual candidate  | Required final checks pass with executed counts, source fingerprints and evidence. Candidate previews use dedicated ports. Human observations and model judgments remain distinct from executable results.                    |
| AC-7 | Publish recoverably      | An accepted exact local preview precedes any push/create. Explicit account, origin, base/head and fingerprints are checked. Retries recover a draft PR without duplicate creation.                                            |
| AC-8 | Calibrate verifiers      | Every station has a versioned rubric and proposed acceptable/flawed cases. Explicit human labels and opt-in live evaluation measure missed problems and unnecessary findings; acceptance records review effort.               |
| AC-9 | Recover local execution  | Atomic state and per-feature locks preserve interrupted/provider-failed work. Doctor validates runtime, pinned package manager, provider availability/authentication and publication prerequisites.                           |

## Roles and permissions

The human owns acceptance and disputed-finding resolutions. Providers have read-only tool access; their proposed writes are constrained to station output or accepted exact paths. The runner alone executes approved profiles and Git/GitHub changes. Local files/configuration and machine-managed policy are trusted operator infrastructure.

## Business rules and edge cases

Duplicate feature starts recover existing state. Concurrent mutations reject. Missing/contradictory criteria and invalid test profiles block readiness. New interface scaffolds may contain minimal signatures only, and implementation fills their bodies. Required unverified evidence blocks acceptance. Expected RED never counts as final GREEN. Drift or reconciliation requires renewed verification. Live fixtures and provider calls are opt-in.

## Failure behavior

Provider/schema/command failures persist with raw local evidence and can be rerun. A timeout or cancellation cannot report success. PR create responses may fail after GitHub created the PR; retry queries the open PR before creating again.

## Non-goals

No automated merge/deployment, account selection, issue/project mutation, remote database provisioning or claim that model review proves semantic correctness.
