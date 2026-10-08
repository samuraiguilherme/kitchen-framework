# Rubric v1.0.0

Findings require a stable rule ID, supporting passage/file/evidence, consequence, and proposed resolution. Unsupported findings are rejected. Record product assumptions separately from operator answers. Required execution failures and missing evidence are blockers; a reviewer opinion cannot waive them.

## Publish draft PR

## Acceptance rules

Human inspects exact diff, title/body, documents, tests-first history, verification and limitations. Recheck source/base/branch, intended account and GitHub authentication. Use explicit repository/base/head and a body file. Recover open PRs on retries.

## Rejection examples

Preview pushes a branch, publish uses an inferred account, or retry opens a duplicate PR.

## Required evidence

Local preview, accepted verification and publish approval, current remote base and explicit identity.

## Blocking conditions

Stale source/base, identity mismatch, unaccepted preview or authentication failure.
