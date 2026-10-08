---
id: <issue#>-<slug>
spec: ./spec.md # or the issue url for size S
status: draft # draft | approved | in-progress | done
owner: <name>
approved_by: <name>
branch: <branch>
prs: []
---

# Plan: <Title>

## Description

<!-- 3–5 lines: the approach and the key technical decisions. Name any deviation from the spec and why. -->

## Files to change

| Path | Change                | Why / AC |
| ---- | --------------------- | -------- |
|      | new / modify / delete | AC-1     |

## Steps to implement

<!-- Each step is small, independently verifiable, and names its check. -->

1. <step> — verify: <command or observable result>

## Order of the work

<!-- Dependencies and slicing: schema → backend → frontend; what can run in parallel; how it splits into PRs. -->

- PR 1:
- PR 2:

## Risks

| Risk                                                                         | Impact | Mitigation |
| ---------------------------------------------------------------------------- | ------ | ---------- |
| <!-- data loss, billing error, tenant leak, perf, breaking API consumers --> |        |            |

## Test plan

See [test-plan.md](./test-plan.md) for AC coverage, unit tests before implementation,
local fixtures, regression suites, browser/manual checks, and required RED/GREEN evidence.

<!-- Approve the separate test plan before implementing tests or feature code. -->

## Deployment plan

- **Order:** <!-- migrations → edge functions → frontend -->
- **Config:** <!-- env vars, secrets, feature flag, Stripe/product config per environment -->
- **Data:** <!-- backfill or scripts: who runs them, where, idempotent? -->
- **Verification after deploy:** <!-- dev → staging → prod: what to check -->
- **Rollback:** <!-- how to undo; is the migration reversible? -->
- **Monitoring:** <!-- logs, events or metrics to watch in the first 24–48h -->
