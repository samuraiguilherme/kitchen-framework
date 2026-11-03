# DeepSeek token usage reduction plan

Status: implementation available behind an opt-in token policy; live model
qualification has not passed. Prepared and executed 2026-11-03.

## Execution results

The adapter now records full harness request projections and per-step usage,
retains partial measurements, rejects incomplete generation, and supports
versioned context/tool limits. Opt-in compact context preserves complete human
answers, accepted documents, candidate diffs, blockers, and required profiles.
Policy and prompt versions participate in approval and discovery fingerprints.
The example configuration and local-provider guide include the new policy.

The offline benchmark covers all eight planned cases, with three repetitions of
each normal case. Across those normal cases, final adapter input fell from
165,777 to 160,728 UTF-8 bytes, a 3.05% reduction. This measures bytes and does not
establish a token reduction. Reports are retained locally at
`.kitchen/benchmarks/deepseek-token-offline-final/report.json`.

Two separate local canaries against the pinned `kitchen-deepseek-r1:8b` alias
exhausted the existing 2,048-token generation cap before completing valid output.
They consumed 2,993 and 3,003 total tokens respectively and produced no accepted
station. These are failure diagnostics, not a successful paired comparison.
The first failing case stopped each canary; the larger live matrix was not run.
Reports are retained under `.kitchen/benchmarks/deepseek-token-live-canary/` and
`.kitchen/benchmarks/deepseek-token-live-optimized/`.

The installed model advertises thinking capability but supplies no thinking
control metadata. Smaller output caps and thinking changes remain unqualified;
the default generation cap and model selection were preserved. The 30% target
and general model-quality gate remain open. Resolve the model's incomplete
generation before continuing the full three-repetition live comparison.

A separate live resource check rejected a 118,147-byte harness request before
inference at its explicit 16,384-byte input limit, preserving its complete
context in local evidence. Its report is
`.kitchen/benchmarks/deepseek-token-live-oversized/report.json`.

Validation passed: all 322 tests across 23 files, TypeScript checking, lint with
zero warnings, and the real pinned DSH protocol fixture. The fixture verifies
read-only tools, actual wire output caps, per-step usage, missing usage, limits,
and incomplete-generation rejection. The final test run suppressed only Node
26's existing tsx `DEP0205` deprecation warning for that process; no global
runtime setting was changed. The test report is
`.kitchen/validation/deepseek-tokens-tests-final.json`.

### Retest with the supplied 16k configuration

The supplied `kitchen-deepseek-r1:16k` configuration was tested with context
16,384, output cap 4,096, DSH `0.2.2-alpha.3`, and runner timeout 1,200,000 ms.
Ollama confirmed the installed alias and actual 16,384-token allocation. The
harness request forwarded `maxTokens: 4096`; its input was 2,979 serialized
bytes, with no tools enabled for the readiness probe.

The structured-output probe failed after 312.97 seconds with
`pi-ai stream idle timeout after 300000ms`. Kitchen's outer process did not time
out. The pinned DSH provider defaults `streamIdleTimeoutMs` to 300,000 ms, and
the current overlay does not override that separate idle limit. No final JSON
or usable token counts were returned, so the dependent live benchmark was not
started. This failure does not establish whether the 4,096-token output cap is
sufficient. Model selection and application configuration were not changed.

The exact configuration, probe evidence, and report are retained under
`.kitchen/validation/deepseek-16k/`. An offline benchmark confirmed the same
configuration and timeout in
`.kitchen/benchmarks/deepseek-16k-offline/report.json`. The benchmark now accepts
`--config <file>` to read a complete provider configuration without falling
back to the initial 8k/2k defaults. TypeScript checking and benchmark lint passed.

## Description

Reduce the tokens needed to complete a successful Kitchen station with the local
DeepSeek provider. Measure the entire DSH invocation, remove repeated context,
bound repository exploration, and then qualify smaller generation budgets where
they work. Preserve complete accepted requirements, strict output schemas,
independent review when enabled, and human approval.

The current integration uses DSH `0.2.2-alpha.3` with Ollama, initially
`kitchen-deepseek-r1:8b`, an 8,192-token context and a 2,048-token output cap.
The primary benefit is less local inference and context pressure. Hosted
DeepSeek pricing and model controls are outside this adapter's current scope.

## Success criteria

Use the following as qualification targets, not predicted savings:

- Reduce median total tokens per successful station by at least 30% across the
  representative benchmark. Count all model steps, discovery, enabled review,
  and unsuccessful attempts leading to the successful result.
- Report input and generated tokens separately, plus per-station results and
  worst-case context use. Include reasoning in generated usage when the backend
  counts it there; never add a reasoning subtotal twice.
- Preserve baseline task correctness, requirement coverage, complete file
  proposals, and detection of the benchmark's known blocking review findings.
  JSON failures, incomplete outputs, and attempts per successful station must
  not increase.
- Record missing usage as unknown. Byte reductions and faster responses alone
  do not establish token savings. Report tasks that never succeed separately so
  they cannot disappear from the comparison.

## Current behavior and remaining opportunities

| Area | Existing behavior | Planned improvement |
| --- | --- | --- |
| Prompt construction | Station rules are filtered; intent excludes implementation context. | Also select rules by author/reviewer role and remove exact repetitions. |
| Context | Selected documents stay complete; full proposals and document diffs are already excluded from repeated state. | Further select relevant state, findings, profiles, and conversation entries without losing human constraints. |
| Measurement | Kitchen records prompt section bytes; DSH step usage is summed when available. | Include the appended output contract, DSH instructions, tool definitions, tool results, and each model step. |
| Discovery | Optional, fingerprinted cache; local tasks run sequentially. | Measure cache hits and duplicated reads before changing discovery behavior. |
| Generation | Configured output cap; provider retries disabled; no automatic JSON repair. | Qualify task-specific caps and bound the cumulative tool loop. |

Relevant code: `src/prompts.ts`, `src/context.ts`, `src/deepseek.ts`,
`src/provider-progress.ts`, `src/discovery.ts`, and `src/kitchen.ts`.

## Steps to implement

### 1 Measure the complete request

Extend the existing metrics and benchmark machinery before changing prompts.
Kitchen currently measures prompt bytes before `prepareDeepSeek` appends its
output contract and schema. Capture both the Kitchen prompt and the final
adapter input, and use the local protocol fixture to inspect the full messages
and tool definitions sent by the pinned harness. DSH input alone is not the
complete model input.

Record per-step input/output usage, invocation totals, model-step count, tool
count, returned tool bytes, termination reason, and usage completeness. Retain
partial measurements on cancellation or failure. Distinguish actual counts from
token estimates and label their source. Do not treat absent usage as zero or
confuse each step's input count with cumulative usage.

Create a DeepSeek benchmark covering initial intent, intent after human answers,
a plan with long accepted documents, test authoring, implementation returning
complete files, review with a seeded defect, a long revision conversation, and
an oversized context. Run three repetitions for each normal case in baseline
and optimized modes against the same model digest and source snapshots. Record
warm/cold state separately for timing comparisons. Keep oversized inputs as
explicit resource-handling cases rather than counting refusal as task success.

Verify: fixture requests reconcile with recorded adapter input and step totals;
baseline reports identify the largest token consumers before optimization.

### 2 Remove repeated prompt content

Apply deterministic, lossless changes first:

- Include only the current role's author/reviewer rules, retaining all shared
  execution boundaries and current station requirements.
- Include the current station and required predecessor state instead of every
  station's summary. Preserve unresolved questions, blocking findings, check
  results, preparation identity, and evidence needed by that station.
- Remove an exact repeated revision request when it is already in the
  conversation. Preserve the original request, all authoritative human answers,
  role labels, ordering, and unresolved decisions. Do not introduce model-written
  summaries of human requirements in this phase.
- Include relevant check profiles with the definitions needed to interpret them;
  retain all profiles during test planning when profile selection is required.
- Keep selected accepted documents, repository instructions, and required schemas
  complete. They already have useful deduplication; extend those protections.

Keep the full candidate changes available for review and verification. If author
context uses a file index plus targeted source reads, benchmark the additional
model calls: moving text into a tool call only helps when total usage falls.
Do not remove required diff evidence merely to shrink the initial prompt.

Verify: context fixtures preserve every required human constraint and document,
while measured reductions appear in the intended sections.

### 3 Budget each model step and repository read

Add a DeepSeek token policy with a version included in approval and discovery
fingerprints. Account for the complete model input and growing tool history.
For the initial settings, use this starting budget for qualification:

```text
8,192 context - 2,048 generation reserve - 512 safety margin
= 5,632 maximum input tokens per model step

Reserve 1,024 of those input tokens for subsequent tool history:
initial complete input target <= 4,608 tokens
```

These are proposed starting limits. Confirm the pinned model/backend's context
accounting and generation-cap behavior with the fixture and live qualification.
Use a matching tokenizer where available; otherwise label estimates and retain
conservative headroom. A byte-to-token heuristic cannot guarantee that a request
fits. If reliable preflight counting is unavailable, keep it advisory and require
explicit backend overflow detection rather than claiming a hard guarantee.

Guide repository reads toward targeted `glob`/`grep` followed by supported line
ranges. Bound search results and cumulative steps/results through mechanisms
verified against the pinned DSH release. Add limits to the Kitchen guard or a
tested DSH extension where the existing CLI has no suitable control. Preserve
the existing read-only allowlist. Never invent an unverified DSH flag.

When required material exceeds the budget, stop with section sizes and a clear
choice to split the task or qualify larger limits. Do not silently truncate
accepted documents, relevant diffs, tool evidence, or JSON output. A tool-loop
limit produces an incomplete run, not an accepted candidate. Keep automatic
compaction disabled until a separate completeness check qualifies it.

Verify: oversized fixtures fail visibly; repeated reads terminate within policy;
normal read/glob/grep workflows still complete within the context window.

### 4 Tune output and reasoning after measuring

Keep the current 2,048-token cap as the comparison baseline. Test smaller caps
first for the no-tools doctor probe and short review/discovery responses.
Give document and implementation outputs enough space for their complete JSON
and file contents. Concise summaries and findings can reduce output; mandatory
fields and substantive findings remain intact.

Discover thinking capabilities from the installed model and confirm that DSH's
OpenAI-compatible transport forwards any proposed control. Ollama documents
model-specific thinking controls; an unsupported control may have no useful
effect. Qualify any lower-thinking mode against correctness and tool use before
exposing it in configuration. See [Ollama thinking controls](https://docs.ollama.com/capabilities/thinking)
and [OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility).

Count reasoning generation even when its text is hidden. Check how the backend
reports generation limits and incomplete finishes through DSH; a shorter answer
cap that causes failed JSON or more reruns is a regression.

Verify: smaller caps lower total generated usage without increasing incomplete
responses, missed findings, or attempts per successful station.

### 5 Reuse discovery and qualify rollout

Retain the existing source-verified discovery cache. Include the token policy
and prompt version in its key, and expose cache hit/miss metrics. Compare cache
reuse against the current behavior before considering a single combined
implementation/verification discovery pass. That optional follow-up must preserve
both traces and their citations. Sequential execution controls memory; it does
not by itself reduce tokens.

Keep author and enabled reviewer sessions independent. Do not reuse old model
outputs or executable check results as fresh acceptance evidence.

Verify: source, accepted spec, instructions, model, profile, or token-policy
changes invalidate the applicable cache/approval evidence.

## Files to change

| Path | Planned change |
| --- | --- |
| `src/types.ts`, `src/metrics.ts`, `src/provider-progress.ts` | Add usage completeness, per-step accounting, and token-policy metrics. |
| `src/providers.ts`, `src/deepseek.ts` | Measure final adapter input, apply qualified generation settings, and record budget failures. |
| `src/prompts.ts`, `src/context.ts`, `src/kitchen.ts` | Select role/state context, preserve human constraints, and account for all invocation costs. |
| `src/token-budget.ts` new | Centralize budget calculation, counting provenance, and overflow diagnostics. |
| `src/deepseek-guard.mjs` | Enforce verified tool/step limits while preserving execution restrictions. |
| `src/config.ts`, `src/discovery.ts` | Validate opt-in policy settings and fingerprint policy/prompt changes. |
| `scripts/benchmark-deepseek-tokens.ts` new | Compare representative workloads using the existing intent benchmark patterns. |
| `scripts/smoke-deepseek.ts` | Assert actual request sizes, forwarded limits, usage, and termination behavior. |
| `test/context.test.ts`, `test/metrics.test.ts`, `test/deepseek.test.ts` | Cover preservation, usage accounting, overflow, and incomplete output. |
| `test/config.test.ts`, `test/discovery.test.ts`, `test/workflow.test.ts`, `test/token-budget.test.ts` new | Cover validation, invalidation, budget math, and workflow gates. |
| `docs/local-deepseek.md`, `kitchen.config.deepseek.example.json` | Document qualified settings, measurements, and rollback. |

The exact DSH extension point for cumulative limits is an implementation
dependency: establish it with the pinned protocol fixture before finalizing
configuration fields.

## Order of the work

1. Measurement and reproducible baseline, with no behavior changes.
2. Lossless prompt/context changes and comparison report.
3. Opt-in budget enforcement and tool-loop limits.
4. Qualified output/reasoning settings and rollout documentation.

Each slice includes its behavioral tests. Defer schema redesign, patch-based file
proposals, automatic summaries, and model replacement; they change additional
contracts and are unnecessary for the first measurable improvements.

## Test plan

Use deterministic fixtures for usage totals across multiple steps, missing
usage, Unicode estimates, complete human answers, large documents, repeated
reads, policy invalidation, and incomplete JSON. Reuse the real pinned DSH
protocol fixture to establish transport behavior before live model comparisons.
The [DSH headless reference](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/headless/README.md)
describes the event interface; the installed pinned release remains the contract
to test.

After implementation, run `pnpm test`, `pnpm check:types`, and `pnpm lint`, then
the explicit protocol smoke check. Run live comparisons only against the
selected local model and retain every attempt's evidence. Promote settings only
when the success criteria pass; report token gains separately from timing gains.

## Risks and rollout

| Risk | Mitigation |
| --- | --- |
| Smaller prompts lose human intent or evidence. | Lossless changes first; complete accepted documents and seeded requirement/review cases. |
| Limits produce more failures or extra read calls. | Compare total usage including failed attempts and tool loops. |
| Hidden harness overhead defeats preflight estimates. | Inspect actual model requests; label counting provenance and preserve headroom. |
| Short output limits exhaust reasoning before JSON completes. | Qualify by workload and preserve larger limits where required. |
| Cached material becomes stale. | Fingerprint source, policy, instructions, accepted spec, and model identity. |

Start with an explicit opt-in in `kitchen.config.local.json`. Keep the previous
policy selectable during qualification, and require fresh affected approvals
after policy changes. Roll back by restoring the previous role/policy settings
and rerunning affected stations. Retain benchmark and run evidence.
