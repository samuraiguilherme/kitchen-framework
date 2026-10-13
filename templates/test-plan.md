---
spec: ./spec.md
plan: ./plan.md
status: draft
---

# Test plan

## Acceptance coverage

Generate unique lowercase kebab-case check IDs (for example, `backend-purchases` or `manual-browser`). Use the same IDs in this table and structured checks; preserve configured profile IDs and AC-n IDs.

| AC  | Check/profile | Expected behavior | Required? | Baseline RED or preservation GREEN |
| --- | ------------- | ----------------- | --------- | ---------------------------------- |

## Unit tests

List exact files, AC-n test names, assertions, fixtures, mock boundaries and minimal new interface scaffolds. Explain legitimate changes to existing tests.

## Integration and browser checks

Declare disposable local fixtures, candidate preview/build and expected flow evidence. Explain N/A where applicable.

## Regression

Name exact existing suites and contracts to preserve, their required GREEN check IDs/profiles, and any permitted test changes. Keep this exact heading.

## Required evidence

Require nonzero executed tests, per-criterion behavioral RED, final GREEN, source fingerprints and actual database/provider/browser/manual observations where needed. Identify the reports and artifacts required for each check; these are evidence requirements, not claims of execution. Keep this exact heading.

## Open decisions

List unresolved product/test-contract decisions separately from model-proposed assumptions.
