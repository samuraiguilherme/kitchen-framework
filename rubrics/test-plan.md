# Rubric v1.0.0

Findings require a stable rule ID, supporting passage/file/evidence, consequence, and proposed resolution. Unsupported findings are rejected. Record product assumptions separately from operator answers. Required execution failures and missing evidence are blockers; a reviewer opinion cannot waive them.

## Create test plan

## Acceptance rules

Cover every AC with required executable or recorded manual evidence. Define unit tests, integration/browser flows, isolated fixtures, expected outputs, regression suites and acceptable existing test changes. Separate missing-behavior RED from preservation GREEN. Include mocks' limits.

Generate unique lowercase kebab-case check IDs and use the same IDs in prose, coverage tables and structured checks. The runner normalizes generated IDs before validation; collisions still block approval. Keep configured profile IDs and AC-n IDs unchanged.

The document must contain the exact nonempty level-two sections `## Acceptance coverage`, `## Unit tests`, `## Regression`, and `## Required evidence`. Do not replace required headings with variants such as `## Required evidence and blockers`. Regression names existing suites/contracts, preservation GREEN checks and permitted test changes. Required evidence specifies nonzero executed tests, per-criterion behavioral RED and final GREEN reports, source fingerprints, and recorded database/provider/browser/manual observations as applicable. Explain N/A explicitly.

## Rejection examples

A mock returns the expected answer, a required AC only has optional checks, a hosted fixture is assumed, or regression/evidence content appears only under a renamed required heading.

## Required evidence

Accepted spec/plan, explicit profiles, files, AC mappings, expectations, unitTestFiles and scaffoldFiles.

## Blocking conditions

No required unit tests, uncovered AC, nonexistent profile, unsafe fixture, ambiguous assertion contract.
