# Kitchen framework verification

Checked change-set fingerprint (SHA-256): `bce2b4b5c79f745aff75fd2833fc6418de73f0f664b40adac06cbc9542f18d0c`.

This hashes the 54 changed implementation, test, configuration, rubric/example and documentation files, excluding this self-referencing report. The file manifest and raw outputs are retained locally in `.kitchen/framework-evidence/`.

Pinned development base: `e038b951accd611de09608de7acdbb06df60d223`.

Tests-first contract commit: `7f57822b39f43b54ea122df8fb7d020e2dad4b91`.

Implementation commit: `81f49fc49`.

Publication regression checkpoint: `ea18bc384` (observed assertion failure before the fix). Publication fix: `4c89edbf0`.

## Executable evidence

| Check | Result | Evidence |
|---|---|---|
| Initial contract tests before implementation | 54 failed, 20 passed | Minimal signatures only; expected missing implementation, not a final verification pass |
| Final deterministic suite | passed: 92 tests in 9 files | Temporary repositories, fake hosted CLI executables, fake GitHub writes and local preview |
| TypeScript | passed | `pnpm --filter @hirebus/kitchen check:types` |
| Repository lint | passed: zero warnings/errors | `pnpm --filter @hirebus/kitchen lint` |
| Root CLI help | passed | `pnpm kitchen --help` |
| Evaluation CLI without live calls | passed | Proposed examples shown; 0 human labels, measured=false |
| Node / pinned pnpm | passed | Node 22.20.0, pnpm 9.15.9 |
| Codex CLI / stored login | passed | CLI 0.142.5; no live inference claimed |
| Claude CLI | passed | 2.1.252 |
| Claude authentication | failed | Not logged in; default live review cannot run until authenticated |
| Intended GitHub publication account | unverified | Explicit username/publication deferred by the user |
| Real GitHub publication | unverified / deferred | No real branch push or PR creation performed |

The initial missing-implementation failures establish that tests were committed first. Runtime feature RED is separately validated by fixtures that require actual assertion failures and reject syntax, dependency, runtime, skipped-test and zero-test evidence.

## Coverage and observed results

- AC-1: isolated worktree/branch anchored to the recorded remote ref; original fixture checkout unchanged.
- AC-2: strict provider output validation, fake Codex/Claude executables, literal stdin/Windows arguments and paths, timeout and cancellation.
- AC-3: guided human answers, ordered approvals, frontmatter non-authority and stale upstream/dependent approvals.
- AC-4: behavioral baseline RED, legitimate preservation GREEN, nonzero execution counts and tests-first commit contents.
- AC-5: atomic rejection of approved-test rewrites, manual tampering detection, scaffold implementation and independently reviewed baseline test revisions.
- AC-6: required GREEN failures block acceptance; absent local fixtures remain unverified; observations require evidence; a dedicated candidate preview preserves an existing service; altered raw evidence invalidates acceptance.
- AC-7: explicit draft arguments/body file, no remote writes during preview, source/base/identity rejection, validation of every origin fetch/push destination and recovery after a lost PR-create response without duplicates.
- AC-8: proposed examples never count as human calibration; supplied label fixtures measure missed problems and unnecessary findings.
- AC-9: dead-process recovery, concurrent-feature locking and retry after provider failures.

## LLM judgments and human decisions

No live cross-provider review of this implementation was performed. The author checked the runner's gate ordering, scope validation, evidence hashing, test history and publication recovery against the accepted plan. These observations are distinct from the executable results above.

The user authorized implementation and explicitly deferred GitHub publication. No runtime feature approval records were invented for this framework build. Every future feature run still requires explicit acceptance at each station.

## Limitations

Live model semantic quality remains unverified and requires human-labeled company examples. Authenticate Claude before using the default author/reviewer pair. Browser/integration checks require package-specific local fixtures and a reviewed candidate-targeting wrapper/config. Worktrees isolate source/Git state; they do not provide an OS/network sandbox. Machine-managed provider policy and local configuration/state remain trusted operator infrastructure.

The deterministic workflow uses fake GitHub writes; real push/create must be checked when publication is resumed with an explicitly chosen username. No merge or deployment is included.
