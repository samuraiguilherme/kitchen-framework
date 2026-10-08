# Test plan: Kitchen framework

## Acceptance coverage

| AC   | Verification                                                                                                                                               |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC-1 | workflow temporary Git repo, pinned ref, isolated branch/worktree, original source unchanged                                                               |
| AC-2 | provider JSON/schema failures, literal Windows arguments/paths, fake Codex/Claude executables, timeout and abort                                           |
| AC-3 | document headings/criteria, guided questions, frontmatter non-authority, gates and stale upstream artifacts                                                |
| AC-4 | assertion RED vs infrastructure, preservation GREEN, zero tests, pinned baseline and tests-first commit                                                    |
| AC-5 | manual test weakening, atomic rejection of author rewrites, scaffold implementation and requirement-based revisions                                        |
| AC-6 | required GREEN failures, local fixture gaps, observed evidence, dedicated preview preserving an existing service                                           |
| AC-7 | explicit draft arguments/body file, preview without remote writes, candidate/base/identity drift, separate push URL rejection and create-response recovery |
| AC-8 | proposed-label non-measurement and human-label calibration counts                                                                                          |
| AC-9 | dead-process recovery, concurrent locks, provider-failed restart, finite profile validation and doctor                                                     |

## Unit tests

Write domain, checks, providers/process, GitHub and workflow contracts first. Minimal exported signatures contain no feature logic. The initial fixture run must fail against those signatures before implementation is committed.

Add focused regression cases as implementation exposes boundary requirements: scaffold bodies, baseline test revisions, evidence integrity, preview targeting and publication recovery. Fake provider/model output is used to test runner behavior, not to claim model quality.

## Regression

Run pnpm --filter @hirebus/kitchen test, check:types and lint. Smoke-test pnpm kitchen --help, doctor and evaluate without live calls. Existing application suites are outside this CLI-only change; package profiles select future feature-specific checks.

## Required evidence

Preserve initial RED output locally and its tests-first Git commit. Record final test counts and tool results in verification.md. Use temporary repositories, loopback preview servers, fake provider executables and a fake GitHub adapter. No real hosted model inference or publication in deterministic tests.

## Legitimate test changes

The publication workflow fixture needs a local bare origin so branch/base validation executes against a real Git remote. This expands the fixture; it does not remove publication assertions. Later assertions cover newly implemented boundary rules and must pass without weakening earlier gates.

## Limitations and manual checks

Live provider authentication and semantic reviewer quality are separate smoke/calibration tasks. The user's exact GitHub account and real framework PR are deferred. Doctor findings remain visible; do not turn unavailable authentication into a passing live-model claim.
