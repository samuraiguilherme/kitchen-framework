# Trust agent output through human-crafted verification

## What the product can't do today

Reviewing LLM-generated features requires repeatedly reconstructing business intent, checking conventions and edge cases, trying flows, and investigating whether tests were weakened. There is no persistent, consistent chain of accepted contracts and evidence.

## Who is affected

The engineering lead acting as the kitchen chef, and developers building features with hosted Codex and Claude.

## What better looks like

A feature moves through specialized stations with explicit human acceptance. Documents, tests-first history, executable evidence and independent review make each handoff inspectable. Record human review minutes and verifier misses/false findings before deciding to increase autonomy.

## Out of scope

Autonomous acceptance, issue/project management, merging, deployment, hosted orchestration and production fixtures.

## Constraints

Local Windows-compatible TypeScript CLI, Node 22, pinned pnpm, existing monorepo conventions, isolated feature worktrees, hosted Codex/Claude, tests before production implementation, draft PR destination. Actual publication of this framework is deferred at the user's request.

## Success evidence

Deterministic fixtures exercise the complete approved-documents → baseline RED → tests-first commit → GREEN → verification → draft PR workflow, plus rejection and recovery paths. Live model quality is assessed separately using human-labeled examples.
