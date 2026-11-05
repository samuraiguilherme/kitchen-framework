# DSH max token recovery plan

Status: implementation validated; targeted generation qualification passed. Prepared and
executed 2026-11-05. Existing provider defaults and rad configuration are
preserved.

## Execution findings

The exact failing run was found in rad's `first-feat` plan evidence. It selected
`kitchen-qwen3.6:27b-16k`, a 16,384-token context and an 8,192-token output cap.
The final step reported 36 new input tokens, 12,196 cached input tokens, and
26 output tokens. Its total input of 12,232 exceeds the 7,680-token input budget
after reserving output and a 512-token safety margin. This is context pressure;
raising the output cap alone would further reduce input capacity.

The adapter now validates context reservations without requiring a token
policy, forwards the idle watchdog and optional author cap, retains raw exit
codes, and reports typed failures with usage and evidence. Optional token
recovery requires verified allocation and complete usage and shares a maximum
of two attempts with contract regeneration. Successful fresh sessions are
retained correctly for after-input reuse. The benchmark preserves supplied
token policies, and a new replay script reads saved prompts without changing
the original project's Kitchen state.

All 428 tests across 28 files pass, along with TypeScript checking and lint
with zero warnings. The full-suite run suppresses only Node 26's existing
`DEP0205` warning for that process. Its report is
`.kitchen/validation/dsh-recovery-tests-thinking.json`.

The cached DSH protocol fixture passed wire cap forwarding, 512-to-1,024-token
recovery, idle watchdog configuration, strict partial-output rejection, and
the existing tool and measurement checks. A stalled stream also stopped at the
configured 2,000 ms idle watchdog without recovery. The protocol summary is
`.kitchen/validation/dsh-recovery-protocol-final.json`.

A separate 32,768-context alias was
created from rad's installed model for qualification. Ollama reported the actual
loaded allocation as 32,768 tokens. Replays and baseline evidence are retained
under `.kitchen/validation/dsh-recovery-rad-32k/`. The first replay exposed a
Windows `EPERM` lock replacing the live progress snapshot. Transient snapshot
locks now leave raw evidence writes strict and retry the snapshot on the next
checkpoint; four regression cases cover this behavior. The restarted three-run
qualification is under `.kitchen/validation/dsh-recovery-rad-32k-final/`.

That restarted run reached the original 1,200,000 ms outer deadline without
the original token cutoff. The installed model advertises boolean thinking
controls. An optional `dsh.thinking` setting now requires the selected value
in `/api/show` metadata before inference; the pinned transport maps thinking
off to `reasoning_effort: "none"`. The real protocol fixture verified this wire
field, and a live readiness probe completed in 15.5 seconds with no thinking
events and complete usage. Evidence is under
`.kitchen/validation/dsh-recovery-thinking-off-probe/` and
`.kitchen/validation/dsh-recovery-thinking-wire.json`.

The intent clarification and seeded review canaries both passed with thinking
off and complete usage. Their report is
`.kitchen/validation/dsh-recovery-thinking-canaries/report.json`. The oversized
case rejected all 119,971 serialized input bytes at its explicit 16,384-byte
limit before inference, without truncating the request. Its report is
`.kitchen/validation/dsh-recovery-oversized/report.json`.

Three replays with thinking off are retained under
`.kitchen/validation/dsh-recovery-rad-thinking-off/`. Two returned complete
validated candidates; the third returned prose after its single corrective
attempt and was rejected. All three avoided the original token cutoff, but
the three-success generation gate did not pass. A separate alias with the
same weights, context, and thinking-off control, plus `temperature: 0`, is
available. Its first candidate was valid, but allocation remained unverified
because Ollama reported the earlier loaded alias. After explicitly unloading
that idle alias and loading the selected one, Ollama confirmed the exact new
digest and 32,768-token allocation. All three fresh replays passed on their
first attempt, with complete usage and unchanged source. They took 269, 234,
and 255 seconds and each consumed 7,767 total tokens. The qualification is under
`.kitchen/validation/dsh-recovery-rad-final/`; the earlier candidate and reload
evidence remain under `.kitchen/validation/dsh-recovery-rad-deterministic/`.

The same final settings passed the clarification, seeded-review, and
oversized-input canaries in
`.kitchen/validation/dsh-recovery-final-canaries/report.json`. The normal cases
consumed 4,806 total tokens with complete usage; the oversized case rejected
its 120,015-byte input before inference. Qualification timings include shared
local inference with those canaries and are not a performance comparison.
The complete pinned role is in `dsh-recovery-rad-final/config.json`, and
`dsh-recovery-rad-final/plan-override.json` scopes it to the plan station.

A real-model token-recovery probe also passed: an intentional 12-token cap
exhausted generation, followed by one fresh attempt at 24 tokens that completed
the exact structured request. Both attempts supplied complete usage, totalling
845 tokens across two model steps. Evidence is under
`.kitchen/validation/dsh-recovery-live-token-retry/`.

Generation qualification is separate from normal candidate review: the initial successful plans named
a `vitest` check profile while the saved human-controlled profile map was
empty. Profile configuration remains operator work at the normal preparation
and test-plan gates. No generated plan has been applied to rad, and no default
model or project configuration has been promoted. The broader token-efficiency
comparison remains open.

## Objective

Complete Kitchen authoring tasks that currently stop with `max-tokens`, while
retaining complete documents, strict JSON validation, bounded inference, and
human acceptance. First qualify enough output and context for the failing plan
station. Then add one controlled recovery attempt for generation exhaustion.

Increasing a limit cannot remove the model's finite context window. Tasks that
exceed a qualified budget need smaller generation units or a separately
qualified model.

## Failure and existing behavior

The supplied plan author log ends after 258 seconds with
`DSH model stopped with max-tokens: incomplete generation`. It establishes an
incomplete model finish; elapsed time alone does not establish a timeout or
identify which token budget was exhausted. The exact run configuration and
per-step usage must come from its evidence directory.

The current adapter has the following relevant behavior:

- `src/deepseek.ts` forwards the selected output limit as `max_tokens` through
  the pinned DSH `0.2.2-alpha.3` provider. The example uses an 8,192-token context
  and a 2,048-token output cap.
- `src/deepseek-guard.mjs` records model requests and usage, and marks incomplete
  finishes as failures. `src/providers.ts` then reports code `-1`, which can be
  Kitchen's normalized failure code rather than the raw DSH process exit code.
- `src/token-budget.ts` reserves output and context margins. Its UTF-8 byte
  estimate is advisory; it is not an exact model token count.
- Completed answers that violate the JSON contract get one fresh regeneration.
  Incomplete generations are deliberately excluded, as tested in
  `test/deepseek-retry.test.ts`.

The [earlier token usage plan](./deepseek-token-usage-plan.md) records two
2,048-token canary failures. A separate 16,384-context, 4,096-output readiness
probe hit a 300,000 ms provider stream idle timeout and returned no usable token
counts. That probe did not qualify the larger output cap. The cached pinned
`dsh-llm-pi-ai` package exposes a provider-level `streamIdleTimeoutMs` setting
with that default; Kitchen's overlay currently leaves it unset.

## 1 Capture the failing request and classify the limit

Retain the original role's `*-process.json`, `*-events.jsonl`,
`*-token-events.jsonl`, prompt, generated patch, and stderr. Record the model
alias and digest, effective output cap, configured and allocated context,
per-step usage, tool history size, finish reason, and both timeout settings.

Classify failures into generation exhaustion, context exhaustion, stream idle
timeout, outer deadline, and tool or policy limits. If the available counters
cannot distinguish output exhaustion from a full context window, report the
cause as unresolved and retain the evidence. Do not infer a cause from the
human-readable error alone.

Add typed failure data at the provider boundary so recovery does not depend on
matching an error message. Preserve the raw process exit code separately from
Kitchen's failure classification. Show the effective cap, relevant usage when
available, session ID, evidence path, and next action in progress/error output.

## 2 Qualify larger output and actual backend context

Use a disposable local configuration and the exact failing task. Try a
4,096-token generation cap, then 8,192 if the first still exhausts generation
and the input fits. These are qualification candidates, not new defaults.
Reasoning consumes generation capacity in the current adapter's accounting;
do not budget only for the visible JSON or add reasoning usage twice.

Use the existing policy calculation for each model step:

```text
input + reserved output + safety margin <= allocated context
initial input target = context - output - safety margin - tool history reserve
```

With the current 512-token safety margin and 1,024-token history reserve:

| Context | Output cap | Initial input target |
| --- | --- | --- |
| 8,192 | 2,048 | 4,608 |
| 16,384 | 4,096 | 10,752 |
| 16,384 | 8,192 | 6,656 |
| 32,768 | 8,192 | 23,040 |

Include DSH instructions, schema, tool definitions, messages, and tool results
in input accounting. A larger output reservation reduces available input space.
Reject configurations with no remaining input budget, including configurations
without an explicit token policy. Warn on estimates and retain measured usage;
do not turn the byte estimate into a claim of exact fit.

Kitchen's `contextWindow` describes the model to DSH; changing it does not
configure Ollama's allocation. For this OpenAI-compatible route, create or
select a model alias with the intended `PARAMETER num_ctx`, then check the
loaded allocation with `ollama ps`. Preserve and verify the model digest after
changing the alias. Ollama documents this configuration path in its
[OpenAI compatibility reference](https://docs.ollama.com/api/openai-compatibility#setting-the-local-context-size).
Larger allocations require more memory; qualify hardware fit using
[Ollama's context guidance](https://docs.ollama.com/context-length).

Expose an optional positive `dsh.streamIdleTimeoutMs` and forward it to
`llm-pi-ai.config.providers.ollama-local.streamIdleTimeoutMs`. Verify this path
with the pinned runtime fixture. Select an idle limit from measured load and
prefill delays, keep it bounded by the remaining outer deadline, and record its
effective value. Increasing the outer timeout alone cannot change this inner
watchdog. Never classify an idle timeout as recoverable token exhaustion.

## 3 Reduce generation pressure without losing requirements

Use the existing compact context policy and targeted repository reads. Remove
exact repetition, keep summaries brief, and omit irrelevant exploration.
Preserve complete accepted documents, human answers, required rules, and plan
manifest fields. Prompt brevity can help but cannot guarantee that a reasoning
model finishes within a cap.

Inspect the installed model's `/api/show` response before considering thinking
controls. Only expose a control after proving that the pinned DSH transport
forwards a supported value and the model honors it. Missing metadata does not
establish that thinking can be disabled. See
[Ollama's thinking controls](https://docs.ollama.com/capabilities/thinking).

Keep the current model unless qualification shows that it cannot complete the
task within practical limits. Any alternative local model must pass the same
schema, tool, correctness, and resource checks before selection.

## 4 Add one bounded recovery attempt

Recovery is opt-in. `dsh.maxTokens` remains the hard per-call output
ceiling. Two additive token-policy fields are available:

- `outputTokens.author`: an optional lower initial author cap, following the
  existing probe, review, and discovery caps. Existing station role overrides
  can assign different author settings to plan and other stations.
- `maxTokenRetries`: `0` or `1`, defaulting to `0`. A retry uses
  `min(2 * previous effective cap, dsh.maxTokens)` and requires a strict increase.

For example, a qualified plan role could start at 4,096 tokens with an
8,192-token hard ceiling and one retry. Authoring uses the full configured cap
when no initial author cap is selected.

Recovery must satisfy all of these conditions:

1. A valid, matching session stream and instrumentation identify a terminal
   `max-tokens` finish. No tool denial, policy failure, malformed stream,
   cancellation, timeout, or independent process error may be masked by it.
2. The larger reservation fits the verified context budget. Explicit context
   exhaustion, unresolved capacity, or an unchanged effective cap stops recovery
   with a configuration or task-splitting recommendation.
3. Start a fresh isolated DSH home using `freshPrompt ?? prompt`, including the
   complete original requirements and human answers. Never concatenate partial
   JSON, accept partial output, or resume the exhausted conversation as the
   recovery strategy.
4. Share the existing absolute deadline across attempts. Bound model steps and
   tool calls per attempt. With two attempts and a hard per-step output ceiling,
   total generation and tool work remain finite and are reported across both.
5. Use one coordinator for token recovery and existing contract regeneration:
   at most two attempts total. A contract retry cannot trigger another token
   retry, and a token retry cannot trigger another contract retry.
6. Preserve each attempt's raw evidence and settings, extend the attempts index,
   and aggregate available usage without treating missing usage as zero.
   Publish the usual answer/output files only after normal completion and full
   schema and station validation. Register only the successful fresh session
   for any later supported reuse.

The disabled default retains today's terminal handling of incomplete output.
Human acceptance, approval fingerprints, and discovery cache invalidation must
include the effective recovery policy and prompt version.

## 5 Split tasks that still exceed the qualified budget

If larger qualified caps still fail, reduce the generation unit. For plan
authoring, an optional later design can generate bounded sections against the
same accepted inputs and assemble them locally into one complete candidate.
Keep drafts separate from station output; validate section coverage, references,
and the combined manifest before normal review and human acceptance.

Each section must itself complete normally and satisfy its own contract. Share
an overall deadline and explicit section/attempt limit. Assemble completed
sections deterministically so a final model call does not have to reproduce the
entire oversized document. This requires a separate internal draft protocol;
the current author contract still requires one complete response. Defer this
work until the larger-budget qualification demonstrates a need.

## Implementation order and files

| Change | Files |
| --- | --- |
| Typed limits, diagnostics, raw exit evidence | `src/deepseek-failure.ts`, `src/deepseek-guard.mjs`, `src/deepseek.ts`, `src/provider-progress.ts`, `src/providers.ts`, `src/types.ts` |
| Budget validation, initial author cap, idle timeout, recovery settings | `src/token-budget.ts`, `src/types.ts`, `src/config.ts`, `src/deepseek.ts`, `src/doctor.ts` |
| Shared retry coordinator, evidence, successful session handling | `src/providers.ts`, `src/kitchen.ts` |
| Prompt and policy fingerprints where behavior changes | `src/prompts.ts`, `src/kitchen.ts`, `src/discovery.ts`, `src/token-budget.ts` |
| Reliable progress and selected source evidence | `src/provider-progress.ts`, `src/evidence-bundle.ts`, `test/provider-progress.test.ts` |
| Qualification and setup guidance | `scripts/smoke-deepseek.ts`, `scripts/qualify-dsh-recovery.ts`, `scripts/benchmark-deepseek-tokens.ts`, `docs/local-deepseek.md`; example defaults preserved |

Capture baseline evidence first. Add behavioral fixtures before changing
failure handling; implement diagnostics and configuration, qualify the manual
larger-budget path, then enable the optional retry coordinator. Extend existing
tests rather than building another harness. Preserve the earlier token usage
plan as the historical measurement record.

## Validation and completion criteria

Deterministic tests must cover cap forwarding, impossible budget rejection,
idle timeout forwarding, retry disabled, one successful recovery, exhausted
hard ceiling, context failure, cancellation, shared deadline, missing usage,
evidence retention, fresh sessions, and the two-attempt limit across both retry
types. Keep the existing rejection of partial JSON even if it parses. Use the
real pinned DSH protocol fixture to verify actual wire caps and failure events.

Then run the originally failing plan task three times with the qualified local
configuration. Require complete validated candidates and correct requirement
and manifest coverage in all three runs. Include an intent clarification case,
a seeded review defect, and an oversized-input rejection to check that larger
budgets and recovery preserve existing boundaries. Record all attempts, token
usage completeness, latency, context allocation, and memory/offload behavior.

Run `pnpm test`, `pnpm check:types`, `pnpm lint`, and
`node --import tsx scripts/smoke-deepseek.ts` after implementation. A passing
protocol fixture does not establish live model quality. Resume the full token
efficiency comparison only after completion reliability passes; keep token
savings separate from this recovery gate.

Roll out through a local override first. Change examples or defaults only after
live qualification. Roll back by removing the new recovery/initial-cap settings
and restoring the saved model/context/timeout configuration, while retaining
all attempt evidence.
