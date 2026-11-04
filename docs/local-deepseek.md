# Local DeepSeek provider

Kitchen can launch a pinned DeepSeek Harness CLI through npx and route it to a
local Ollama model. This is opt-in; existing Codex and Claude settings continue
to work. The adapter targets DSH `0.2.2-alpha.3` and Node 24.9 or newer.

## Prepare Ollama

On Windows, install Ollama and run its local server with cloud features disabled.
For a manually started server, quit the tray app first, then run:

```powershell
$env:OLLAMA_HOST = '127.0.0.1:11434'
$env:OLLAMA_NO_CLOUD = '1'
$env:OLLAMA_NUM_PARALLEL = '1'
$env:OLLAMA_MAX_LOADED_MODELS = '1'
ollama serve
```

In another terminal:

```powershell
ollama pull deepseek-r1:8b
@'
FROM deepseek-r1:8b
PARAMETER num_ctx 8192
'@ | Set-Content -LiteralPath 'Modelfile.deepseek' -Encoding utf8
ollama create kitchen-deepseek-r1:8b -f Modelfile.deepseek
```

The 8B model is an initial candidate for the 6 GB laptop GPU; partial CPU
offloading may be needed. Check `ollama ps`. An 8,192-token context and a
2,048-token output cap are qualification limits; larger Kitchen tasks may need
more memory, context, or output capacity. Changing only Kitchen's
`contextWindow` does not change Ollama's allocation: update the Modelfile too.

## Connect Kitchen

From the Kitchen checkout, run the setup helper with PowerShell 7, pointing
`-Root` at the target project. It checks the existing Ollama model/context,
prewarms the exact npm package, pins the model digest, and merges the author
setting into the ignored machine-local config. It saves an existing local
configuration before replacing the author settings. It does not pull models or
change the reviewer/station roles.

```powershell
pwsh -File scripts/setup-deepseek.ps1 -Root C:/work/target-project
```

Alternatively, merge [the example](../kitchen.config.deepseek.example.json) into
`kitchen.config.local.json`, prewarm `npx --yes @deepseek-ai/dsh@0.2.2-alpha.3 --version`,
and add `dsh.expectedModelDigest` from `http://127.0.0.1:11434/api/tags`.
Explicit station author/reviewer settings override the global role. Enabled
Claude reviews still use Claude's hosted service; select DeepSeek explicitly
for all enabled roles to run every model locally.

Run `kitchen doctor` from the target project after initialization. DeepSeek
setup diagnostics are shown even before DeepSeek is selected: `dsh-cli` checks
the cached harness, `deepseek-node` checks its Node runtime, `ollama-server`
checks the endpoint, and `deepseek-local` reports the expected alias and installed
DeepSeek models. `deepseek-configuration` identifies the project and explains how
to enable the provider. These checks are optional while it is unused; no local
generation is started. Selecting an active DeepSeek role makes its readiness
checks required. Configured model details include the digest pin and context/output
limits, and missing infrastructure is reported before attempting generation.

Once configured, DeepSeek
readiness checks the exact cached CLI version, local model/digest, and an
isolated no-tools schema request with a maximum of 180 seconds. It requires no
DeepSeek API key or hosted login. Normal requests use the prewarmed npm cache
with `--offline`; no package or model downloads happen during station execution.

## Provider behavior and evidence

DSH receives prompts on stdin, uses a separate home/profile for each invocation,
and can execute only native `read`, `glob`, and `grep`. A required execution
guard also rejects every other tool, including tools introduced by a later CLI
version. Intent author/review calls and model-only probes allow no tools. Intent
uses only the supplied request, human answers, template, and context. Its author
schema accepts either questions with `document: null`, or a nonempty document
with no questions; file proposals, scope, test manifests, and checks must all be
empty. Kitchen applies file proposals from later stations only
after its existing validation and workflow gates.

The adapter requires successful process completion, a matching completed final
event, and strict JSON matching the station's schema. If a completed final answer
contains Markdown/prose, malformed JSON, or an invalid output contract, Kitchen
requests one corrective regeneration in a fresh session using the original
context and validation feedback. Both attempts share the original timeout.
Kitchen never extracts fenced JSON or relaxes validation. A second invalid answer
fails with `DSH final answer violated JSON contract`, the session ID, and the raw
event evidence path. Stream failures, permission/tool denials, incomplete or
truncated generations, token-budget failures, cancellation, and process failures
remain terminal. There is no hosted fallback. Local discovery runs
sequentially to limit memory.

Inspect the role's `*-events.jsonl`, `*-stderr.log`, `*-process.json`, generated
DSH patch, and isolated DSH home under the normal run evidence directory. Evidence
includes the requested version, local model digest, overlay hash, timings, and
available usage. DSH telemetry is disabled. Digest pins are checked before model
requests and before accepting a station.

When regeneration is needed, the original attempt stays in the role's run
directory and the second attempt has its own prompts, events, token measurements,
process record, patch, and DSH home under `contract-retry/`. The role's
`*-attempts.json` records both evidence directories and errors. Only a validated
candidate is exposed at the usual `*-answer.json` and `*-output.json` paths.

To verify the harness integration without an actual model, prewarm the pinned
DSH CLI and run the explicit local protocol-fixture check:

```powershell
node --import tsx scripts/smoke-deepseek.ts
```

This checks the real DSH profile, tool catalogue, repository read, final output,
and metrics. The default test suite uses fake executables and a local HTTP
fixture and does not download DSH or use a paid model. Real DeepSeek model
quality and context capacity still require a representative Kitchen workflow.

## Reduce token usage

The DeepSeek example enables an opt-in `dsh.tokenPolicy`. Merge that object into
the selected author or reviewer in `kitchen.config.local.json` to use compact
context and bounded exploration. Policy changes invalidate affected approvals
and discovery caches. Remove `tokenPolicy` to restore the previous context and
unbounded exploration behavior in later stations; intent always disables tools.
Model-call instrumentation remains available.

Version 1 defaults to 8 model steps, 12 tool calls, and 32,768 bytes of cumulative
tool-result content in a model request. It reserves 512 context tokens for safety
and 1,024 for future tool history. Set those values explicitly to qualify a
different workload. `maxToolCalls` can be zero for tasks requiring no reads.
An optional positive `maxInputBytes` imposes a hard limit on the serialized
harness request before inference. Limits stop the run with an explanation;
required documents, source changes, and output are never silently truncated.

At the initial 8,192/2,048 settings, the advisory initial input target is 4,608
tokens, and later steps have a 5,632-token input target. Estimates use serialized
UTF-8 bytes divided by three; they are not exact model token counts or a fit
guarantee. The serialized harness projection includes internal metadata and can
be larger than the provider's wire request. Reported input usage includes cache
reads/writes and is checked after each step. A backend context error or an
incomplete generation fails the run even if its partial text looks like JSON.

Each role now retains `*-token-events.jsonl` with full harness request projections,
section sizes, per-step usage, warnings, and termination reasons. The process
metrics distinguish the Kitchen prompt, final adapter input (including the
schema), and model steps. `knownTotalTokens` preserves measured partial totals;
`totalTokens` appears only when every attempted step supplies usage. Reasoning
is already included in generated tokens and is not added twice. Evidence stays
under the existing local run directory and follows its retention policy.
All-zero usage from the pinned adapter is treated as incomplete because it can
represent a provider response with no usage data.

The default output cap is unchanged. Optional `tokenPolicy.outputTokens` keys
`probe`, `review`, and `discovery` accept positive caps up to `dsh.maxTokens`.
Document and implementation authoring keep the full configured cap. Qualify
short-task caps against the installed model before using them; a smaller cap
that creates incomplete JSON does not save tokens per successful task. Thinking
controls are not exposed without model and transport qualification.

Compare all eight workload cases without model inference:

```powershell
node --import tsx scripts/benchmark-deepseek-tokens.ts
```

Then qualify against the installed local model, using three repetitions per
normal case. No hosted fallback is used. The benchmark records the model digest,
thinking metadata when present, initial load state, source fingerprint, every
attempt, and correctness checks. Source proposals are inspected and are not
executed by the benchmark. Large-context rejection is reported separately.

```powershell
node --import tsx scripts/benchmark-deepseek-tokens.ts --live --iterations 3
# Use a complete saved provider configuration, including its timeout and limits:
node --import tsx scripts/benchmark-deepseek-tokens.ts --config C:/work/deepseek-test.json --live --iterations 1 --stop-on-failure
# Optional first canary; stop if the local model cannot complete a case:
node --import tsx scripts/benchmark-deepseek-tokens.ts --live --iterations 1 --cases intent-initial,review-seeded-defect --stop-on-failure
```

Reports go into a new `.kitchen/benchmarks/deepseek-tokens-*` directory. Existing
output directories cannot be reused. Offline results describe bytes only.
Promotion requires complete usage and correctness across all cases, at least
three repetitions, successful large-context handling, and a median token
reduction of at least 30%. Keep token savings separate from timing effects.

## Troubleshooting and rollback

- **Cache miss:** run the pinned npx version command once with internet access,
  using the same npm cache/environment as Kitchen.
- **Model not installed:** check the exact alias in `ollama list` and the
  configured port. DSH and Ollama must share the same host/network environment.
- **Digest differs:** qualify the changed model and update its pin deliberately;
  rerun affected stations and approvals.
- **No valid final JSON or tool use:** inspect the raw evidence. A successful
  local chat alone does not qualify a small model for Kitchen.
- **Slow or exhausted context:** inspect `ollama ps`, reduce unrelated memory
  use, and qualify revised model/context/output settings. Keep accepted documents
  and schemas complete.
- **CLI configuration failure:** use the tested exact version. A DSH upgrade
  requires the protocol-fixture check and model qualification again.

Restore the saved local configuration, or replace the author/station roles with
their previous Codex provider/model/executable settings, then rerun doctor and
the affected stations. Historical evidence and Codex credentials are retained.
