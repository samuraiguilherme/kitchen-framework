# Rubric v1.0.0

Findings require a stable rule ID, supporting passage/file/evidence, consequence, and proposed resolution. Unsupported findings are rejected. Record product assumptions separately from operator answers. Required execution failures and missing evidence are blockers; a reviewer opinion cannot waive them.

## Verify candidate

## Acceptance rules

Review business logic, architecture/conventions, edge cases, actual flows and test integrity separately. Compare final tests to approved hashes and tests-first history. Required checks pass with nonzero discovered/executed tests. Confirm source fingerprints, fixture availability and browser candidate targeting. Separate executable evidence, LLM judgments and human observations.

## Rejection examples

Approve from exit zero with no tests, test another running dev server, miss tenant leakage, or call an LLM opinion passing executable evidence.

## Required evidence

Candidate diff, checked fingerprint, baseline/RED and final GREEN, test integrity, local flow/manual evidence, limitations.

## Blocking conditions

Required failures, absent evidence, wrong candidate, test tampering or stale inputs.
