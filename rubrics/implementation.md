# Rubric v1.0.0

Findings require a stable rule ID, supporting passage/file/evidence, consequence, and proposed resolution. Unsupported findings are rejected. Record product assumptions separately from operator answers. Required execution failures and missing evidence are blockers; a reviewer opinion cannot waive them.

## Implement feature

## Acceptance rules

Implement accepted behavior using approved tests without weakening them. Add planned integration/browser tests, respect code conventions, report scope deviations. Changes to approved unit tests return to unit-tests with requirement-based rationale.

## Rejection examples

Delete an assertion, skip a failing case, change an approved expected value, broaden file scope, or mock out the feature.

## Required evidence

Accepted documents, tests-first commit, approved test hashes, actual diff and GREEN results.

## Blocking conditions

Approved tests changed, required checks fail or remain unverified, scope deviation unresolved.
