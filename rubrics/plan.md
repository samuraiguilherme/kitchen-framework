# Rubric v1.0.0

Findings require a stable rule ID, supporting passage/file/evidence, consequence, and proposed resolution. Unsupported findings are rejected. Record product assumptions separately from operator answers. Required execution failures and missing evidence are blockers; a reviewer opinion cannot waive them.

## Craft implementation plan

## Acceptance rules

Inspect actual repository code and target AGENTS.md/CLAUDE.md. Cover every AC with exact paths, architecture choices, dependencies, ordered steps, risks, rollout and a link to test-plan.md. File scope includes tests and fixtures.

## Rejection examples

A proposed module does not exist, violates tenant conventions, or omits a migration/consumer.

## Required evidence

Accepted spec, repository paths and symbols, explicit allowedPaths manifest.

## Blocking conditions

Unmapped requirements, infeasible dependencies, hidden scope or architecture contradiction.
