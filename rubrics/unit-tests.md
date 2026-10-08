# Rubric v1.0.0

Findings require a stable rule ID, supporting passage/file/evidence, consequence, and proposed resolution. Unsupported findings are rejected. Record product assumptions separately from operator answers. Required execution failures and missing evidence are blockers; a reviewer opinion cannot waive them.

## Implement unit tests

## Acceptance rules

Inspect assertion strength, false positives, mocks and real boundaries. Tests have AC IDs, exercise the approved contract, and fail on the pinned pre-implementation baseline at behavioral assertions. Preservation tests may already pass. Minimal scaffolds contain signatures/types and throw-only bodies. Tests are written before feature logic.

## Rejection examples

expect(true).toBe(true), asserting a mocked result without verifying behavior, a syntax/import failure labeled RED, or production logic hidden in a stub.

## Required evidence

Actual test files, baseline SHA, executed counts, per-criterion failures, raw runner results and accepted test plan.

## Blocking conditions

Infrastructure failure, missing expected RED, zero tests, weak assertions, production implementation at this station.
