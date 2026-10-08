# Plan: Local Development Kitchen

## Description

Add the runner under tools/kitchen, using the existing intent/spec/plan templates and a separate test-plan.md. Build station contracts around deterministic state transitions, exact scope, content fingerprints and a small provider/GitHub boundary. Preserve tests before implementation in Git.

## Files to change

| Path                                                                        | Purpose                                                                                  |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| tools/kitchen/package.json, tsconfig.json, vitest.config.ts                 | private TypeScript workspace and checks                                                  |
| tools/kitchen/src/{cli,config,doctor,types}.ts                              | commands, runtime configuration and diagnostics                                          |
| tools/kitchen/src/{domain,storage,git,kitchen}.ts                           | paths, fingerprints, recovery, worktrees, station gates and publication                  |
| tools/kitchen/src/{process,providers,checks,github}.ts                      | finite subprocesses, hosted structured output, executable evidence and draft PR boundary |
| tools/kitchen/src/{prompts,evaluate}.ts                                     | station context, rubrics and human-labeled evaluation                                    |
| tools/kitchen/test/\*.test.ts                                               | deterministic contract and workflow fixtures                                             |
| tools/kitchen/{rubrics,examples}/\*                                         | per-station acceptance rules and calibration cases                                       |
| tools/kitchen/README.md, kitchen.config.json                                | local setup and versioned package profiles                                               |
| docs/features/kitchen-framework/\*.md, docs/\_templates/{plan,test-plan}.md | feature contract, separate test plan and factual verification                            |
| package.json, pnpm-workspace.yaml, pnpm-lock.yaml, .gitignore               | workspace registration and ignored runtime storage                                       |

## Steps to implement

1. Write behavioral contract tests with minimal signatures; record RED and commit before implementation.
2. Implement subprocess/provider/schema, persistence, path and Git foundations.
3. Add intent, spec, plan and test-plan gates with independent review and human approval.
4. Execute tests at a detached pinned baseline, review and preserve the tests-first checkpoint.
5. Constrain implementation writes, protect approved tests and require GREEN.
6. Record actual candidate flow/evidence, independent five-concern review and verification summary.
7. Add exact publication preview, explicit identity/base checks and recoverable draft creation.
8. Validate with local fixtures, fake executables/GitHub, then document calibration and current limitations.

## Order of the work

The executable station order is intent → spec → plan → test-plan → unit-tests → implementation → verify → publish. Each station pauses for human acceptance. Foundation tests cover shared contracts before code; complete workflow tests enforce the ordering.

## Test plan

See [test-plan.md](./test-plan.md) for acceptance coverage, baseline failure expectations, regression checks and final evidence.

## Risks

| Risk                                                      | Mitigation                                                                                                                          |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Model proposes plausible but incorrect behavior           | self-contained accepted contracts, independent review, human checkpoints and calibration                                            |
| Stale or fabricated passing evidence                      | runner-owned checks, count validation, raw evidence hashes and candidate fingerprints                                               |
| Tests changed to fit implementation                       | accepted unit hashes, atomic proposal validation and explicit revision cycle                                                        |
| Local fixture accidentally reaches hosted systems         | required fixture declarations, loopback endpoint validation, reviewed disposable configuration; worktrees are not network sandboxes |
| Missing provider authentication or local dependency cache | doctor, offline baseline setup, unverified infrastructure evidence and opt-in live tests                                            |
| Publication response lost                                 | explicit branch/repository lookup and idempotent retry without force push                                                           |

## Rollout

Use locally with human acceptance at every station. Label company examples and record review minutes before granting more autonomy. This request defers the real framework PR; keep local commits ready for later publication.
