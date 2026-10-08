# Rubric v1.0.0

Findings require a stable rule ID, supporting passage/file/evidence, consequence, and proposed resolution. Unsupported findings are rejected. Record product assumptions separately from operator answers. Required execution failures and missing evidence are blockers; a reviewer opinion cannot waive them.

## Create test plan

## Acceptance rules

Cover every AC with required executable or recorded manual evidence. Define unit tests, integration/browser flows, isolated fixtures, expected outputs, regression suites and acceptable existing test changes. Separate missing-behavior RED from preservation GREEN. Include mocks' limits.

## Rejection examples

A mock returns the expected answer, a required AC only has optional checks, or a hosted fixture is assumed.

## Required evidence

Accepted spec/plan, explicit profiles, files, AC mappings, expectations, unitTestFiles and scaffoldFiles.

## Blocking conditions

No required unit tests, uncovered AC, nonexistent profile, unsafe fixture, ambiguous assertion contract.
