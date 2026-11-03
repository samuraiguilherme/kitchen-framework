# DeepSeek CLI migration plan

Status: opt-in implementation available; local model qualification pending.
Prepared for Kitchen on 2026-11-03.

The implementation uses published DSH `0.2.2-alpha.3`. Its real CLI passed the
local protocol-fixture check for the generated profile, read/glob/grep catalogue,
file reading, strict final JSON, a no-tools model probe, and forbidden-write
rejection. `scripts/setup-deepseek.ps1` links a prepared Ollama alias to Kitchen.
The existing author defaults remain unchanged until representative DeepSeek model
workflows pass. See [local setup](../local-deepseek.md).

## Description

Replace Kitchen's default Codex author with DeepSeek Harness, launched through
`npx @deepseek-ai/dsh`, and serve a DeepSeek model locally through Ollama. Keep
Kitchen responsible for validating proposals, applying files, running checks,
recording evidence, and obtaining human acceptance. DSH supplies model reasoning
and repository reads.

Add `deepseek` as a provider rather than renaming or deleting `codex`. Existing
explicit Codex configurations remain usable for rollback. Keep the current Claude
reviewer unless the operator also selects DeepSeek for that role. Consequently,
enabled Claude reviews still use a hosted model; a completely local configuration
must explicitly select DeepSeek for every enabled author and reviewer, including
station overrides. A separate session on the same model does not provide the same
independence as a different reviewer model.

The remaining qualification uses the operator's local Ollama model and the
acceptance criteria below.

## Current integration and compatibility

Kitchen currently accepts only `codex` and `claude` in `src/types.ts` and
`src/config.ts`. `src/providers.ts` uses a Codex/Claude conditional for invocation,
output extraction, errors, and probing. Simply adding another provider name would
send DSH Claude's arguments and parse its response as a Claude envelope.

DSH offers a headless profile, stdin input, and an NDJSON event stream. Its current
CLI reference has no headless `--model`, `--output-schema`,
`--output-last-message`, or `--ephemeral` equivalent. Select the model in an
overlay, include Kitchen's schema in the task, and validate the final answer in
Kitchen. DSH JSON events alone do not enforce Kitchen's answer schema.
See the [CLI reference](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cli-help.md).

The headless contract requires both process exit zero and a terminal
`final.reason.kind` of `completed`. Extract the answer from `final.text`; earlier
text events can be truncated. Each invocation normally persists a fresh session,
so isolate its storage rather than claiming it is ephemeral.
See the [headless reference](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/headless/README.md).

DSH is a developer preview. First qualify an exact published package version and
save its help, composed configuration, and version. The inspected upstream source
identifies itself as `0.2.2-alpha.3`, but that does not establish npm availability.
Query npm during preflight; never infer a published version from the repository
or run a moving npm tag in normal Kitchen requests. The upstream development
runtime requires Node 24.9 or newer; the selected npm release must also pass its
own runtime requirements. See the [upstream manifest](https://github.com/deepseek-ai/deepseek-harness/blob/master/package.json).

## Local model choice

The inspected Windows machine has an AMD Ryzen 7 7435HS, 32 GiB system RAM, an
RTX 4050 Laptop GPU with approximately 6 GiB VRAM, and Node 26.13.0. At inspection,
approximately 7 GiB system RAM and 4 GiB VRAM were free. Ollama and LM Studio were
not found on PATH; this does not rule out an installation elsewhere.

Use Ollama's `deepseek-r1:8b` as the first qualification candidate. It is the
DeepSeek-R1-0528 Qwen3 distillation, distributed as a roughly 5.2 GB Q4_K_M model.
Expect possible CPU/GPU offloading on this laptop. If memory or latency prevents
qualification, evaluate `deepseek-r1:7b`, roughly 4.7 GB Q4_K_M, as a separately
recorded candidate. Neither choice is equivalent to running a full DeepSeek
flagship model locally. See the [8B model](https://ollama.com/library/deepseek-r1:8b)
and [7B model](https://ollama.com/library/deepseek-r1:7b).

Start at 8,192 context tokens and a 2,048 output-token cap for qualification.
These are initial resource limits, not a claim that all Kitchen tasks fit.
Reasoning, schemas, instructions, accepted documents, tool results, and file
contents all consume the available budget. Larger contexts consume more memory;
Ollama recommends much larger windows for general agent workloads. Increase the
window only after measuring memory and a representative Kitchen task. Do not
silently truncate accepted documents, diffs, schemas, or instructions to fit.
See [context allocation](https://docs.ollama.com/context-length).

## Files to change

| Path | Planned change |
| --- | --- |
| `src/types.ts` | Add `deepseek` and typed DSH settings. Keep the `Provider` request and output contracts. |
| `src/config.ts` | Validate DSH settings and merge role overrides by provider. Share qualified defaults with initialization. |
| `src/deepseek.ts` (new) | Build isolated DSH configuration, stdin schema instructions, invocation, endpoint/model checks, and strict event parsing. |
| `src/providers.ts` | Dispatch explicitly across three providers. Reuse author/review/discovery validators and existing process evidence. Add a provider-neutral `cliProvider` export and retain `hostedProvider` as a compatibility alias. |
| `src/provider-executable.ts` | Resolve DeepSeek to `npx.cmd` on Windows and `npx` elsewhere; preserve explicit executable paths and Codex recovery. |
| `src/provider-progress.ts` | Parse DSH events separately, record timings, count tools by call ID, and collect available step usage. |
| `src/doctor.ts` | Add DSH runtime/version, Ollama reachability, exact-model/digest, and isolated schema probes; remove hosted-login assumptions for this provider. |
| `src/discovery.ts` | Run local DeepSeek discovery tasks sequentially to bound memory; retain concurrent behavior for other providers. Include that scheduling policy in the discovery cache key. |
| `src/kitchen.ts` | Use the neutral provider export and retain existing write detection, approval fingerprints, and tests-first gates. |
| `src/project.ts`, `kitchen.config.example.json` | Switch new-project author defaults to the qualified DSH configuration after the rollout gates pass. Preserve existing project files. |
| `src/evaluate.ts`, `scripts/benchmark-intent.ts` | Update neutral naming and expose local-provider identity in live calibration evidence where needed. |
| `test/providers.test.ts`, `test/hosted-adapters.test.ts`, `test/provider-executable.test.ts` | Cover dispatch, Windows execution, DSH event/output contracts, errors, and process termination. |
| `test/config.test.ts`, `test/doctor.test.ts`, `test/project.test.ts`, `test/discovery.test.ts`, `test/workflow.test.ts`, `test/metrics.test.ts` | Cover configuration, readiness, defaults, scheduling, workflow invariants, and metrics. |
| `scripts/setup-deepseek.ps1` (new), `docs/local-deepseek.md` (new), `README.md` | Provide explicit setup, generated configuration, verification, troubleshooting, rollback, and local/hosted distinctions. |

## Proposed configuration changes

Add the following shape to the existing types. The `dsh` fields are valid only
for `provider: "deepseek"`; require an explicit nonempty model for that provider.

```ts
export type ProviderName = "codex" | "claude" | "deepseek";

export interface DeepSeekOptions {
  version: string; // exact qualified npm version, never latest/next/a range
  baseURL: string; // initially http://127.0.0.1:11434/v1
  contextWindow: number;
  maxTokens: number;
  expectedModelDigest?: string;
}

// Add to RoleConfig:
// dsh?: DeepSeekOptions;
```

Validate finite positive integer limits with `maxTokens < contextWindow`, a
literal loopback HTTP endpoint, and an exact package version. Reject cloud model
tags, non-loopback endpoints, and Codex-only `windowsSandbox` on DeepSeek roles.
Keep this first implementation specific to local Ollama; remote gateways can be
a later explicit feature.

When a local override changes provider, replace the previous role's provider
settings rather than inheriting its model, executable, or sandbox selection.
For overrides on the same provider, merge nested `dsh` fields predictably. Apply
the same rule to station roles. This prevents an old Codex desktop executable
from accidentally becoming the DSH executable.

The generated local configuration will contain the following provider section.
The setup script substitutes the qualified version and model digest and merges
this into an existing file without dropping unrelated settings.

```json
{
  "providers": {
    "author": {
      "provider": "deepseek",
      "model": "kitchen-deepseek-r1:8b",
      "dsh": {
        "version": "<exact qualified npm version>",
        "baseURL": "http://127.0.0.1:11434/v1",
        "contextWindow": 8192,
        "maxTokens": 2048,
        "expectedModelDigest": "<digest from local Ollama model inventory>"
      }
    },
    "review": { "provider": "claude" },
    "timeoutMs": 1200000
  },
  "discovery": { "enabled": false }
}
```

Keep configuration version 1 because the change is additive. Changes to the role,
version, model pin, or limits already enter Kitchen's policy fingerprint; test
that affected approvals become stale. Check an expected model digest before
requests and acceptance so an externally repointed Ollama alias cannot reuse
approval evidence from different weights. Promoted local configurations must
include the digest pin.

## Adapter implementation

### Invocation and configuration isolation

Create a separate `dsh-home` and generated overlay under each request's `runDir`.
Use the shipped `headless` profile with `DSH_HOME` pointing at that directory.
The adapter must not edit or inherit the operator's normal DSH home. Generate
YAML through the existing `yaml` dependency, not string interpolation.

After prewarming the selected npm package, execute an argument array equivalent
to the following. Use `runProcess` with `shell: false`, the feature worktree as
cwd, and the prompt on stdin. `executable` overrides identify an npx-compatible
launcher for this provider.

```text
npx --yes --offline @deepseek-ai/dsh@<qualified-version>
  --profile headless --patch <absolute-generated-overlay.yml>
  --json --permission-mode read-only --approval-policy never -
```

Set child-process `KITCHEN_OLLAMA_API_KEY=ollama` and
`DSH_TELEMETRY_MODE=DISABLED`. The key is a local compatibility placeholder, not
a DeepSeek API credential. Preflight must establish that the npm cache can run
the exact package offline. A cache miss is an actionable setup error, not an
implicit package installation during a feature run.

The overlay's model-routing portion is:

```yaml
- id: llm-pi-ai
  config:
    providers:
      ollama-local:
        apiKeyEnv: KITCHEN_OLLAMA_API_KEY
        api: openai-completions
        baseURL: http://127.0.0.1:11434/v1
        compat:
          supportsDeveloperRole: false
          maxTokensField: max_tokens
        models:
          - id: kitchen-deepseek-r1:8b
            contextWindow: 8192
            maxTokens: 2048
- id: agent-default-model
  config:
    provider: ollama-local
    model: kitchen-deepseek-r1:8b
- id: tool-fs
  config:
    read: true
    readImage: false
    write: false
    edit: false
    applyPatch: false
```

This is the routing portion, not the complete restrictive overlay. Also disable
shell/PowerShell tools, web tools and provider extensions, MCP resources/clients,
plugin management tools, skill tools, delegation/team/workflow tools, jobs,
interactive questions, mutable working-directory tools, and other unrelated
tools in the qualified composition. Keep only native `read`, `glob`, and `grep`
tools. Disable model-generated session titles and hosted DeepSeek routes.
Disable automatic compaction for qualification so missing contract context
cannot be hidden by a generated summary. Bound the task with the existing timeout
and output limit.

Use a composed-configuration fixture for the pinned version to enumerate the
actual plugin IDs and assert the resulting callable tool set. Do not rely on a
prompt asking a general coding agent not to write. For model-only doctor probes,
disable all tools. Preserve source fingerprint checks after every provider run.
The filesystem switches and routing settings are documented in the
[filesystem tool reference](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/fs/tool-fs/README.md)
and [model provider guide](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/providers.md).

DSH's Windows process sandbox reports partial enforcement. Keeping shell tools
disabled avoids depending on it for repository exploration; still test actual
filesystem-tool restrictions and never describe the profile as an operating
system boundary around the entire Node process. See the
[sandbox reference](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sandbox/sandbox-local/README.md).

### Structured output and failures

1. Select the existing author, review, or discovery schema. Add its full JSON and
   an explicit instruction to return exactly one JSON object to DSH's stdin task.
2. Persist raw stdout/stderr before parsing or reporting progress. Parse NDJSON
   incrementally across arbitrary chunk boundaries, including a final line with
   no trailing newline.
3. Require one opening session and one matching terminal final event, process
   exit zero, and `final.reason.kind === "completed"`. Reject malformed streams,
   error events, missing/null/failed termination, and mismatched session IDs.
4. Parse only `final.text` with `JSON.parse`, then apply the existing Ajv validator.
   Reject prose, Markdown fences, extra content, missing required fields, and
   schema violations. Do not extract the first JSON-looking substring or silently
   repair an invalid answer.
5. Treat forbidden-tool attempts and permission denials as failed runs even if
   the model later returns plausible JSON. Distinguish them from an ordinary
   recoverable read/search failure.
6. Save the validated answer in the existing role answer file. Record CLI
   version, endpoint, model digest, context/output limits, session ID, overlay
   hash, timings, and termination reason in process evidence. Preserve DSH session
   files inside the isolated run directory according to normal evidence retention.
7. Propagate cancellation, timeout, and the current 20 MB process-output limit.
   On Windows, verify termination reaches the npx/Node descendants and leaves the
   independently running Ollama server alive. Never retry through a hosted model.

DSH `status` events with `phase: "step_end"` can carry usage. Aggregate reported
token counts without inventing missing values or hosted cost. Measure first event
and first tool separately; committed DSH text events are not token-by-token
streaming. Keep the existing heartbeat for quiet local inference.

## Local DeepSeek model setup

### Install and configure Ollama

Install the native [Ollama Windows application](https://docs.ollama.com/windows)
and check its GPU-driver requirements. Allow room for the application, the model,
and npm cache. Downloading these dependencies requires internet access; local
inference after provisioning uses the loopback server.

Quit the Ollama tray application before starting a manually configured server.
In a dedicated PowerShell terminal, run:

```powershell
$env:OLLAMA_HOST = '127.0.0.1:11434'
$env:OLLAMA_NO_CLOUD = '1'
$env:OLLAMA_NUM_PARALLEL = '1'
$env:OLLAMA_MAX_LOADED_MODELS = '1'
ollama serve
```

These variables configure this server process. If using the tray application
instead, set the same variables in the Windows user environment and restart
Ollama. Do not start two servers on the same port. `OLLAMA_NO_CLOUD` disables
Ollama cloud inference and web search. See the
[Ollama configuration FAQ](https://docs.ollama.com/faq).

In a second terminal, pull the candidate and create a named model whose context
matches DSH's declaration:

```powershell
ollama --version
ollama pull deepseek-r1:8b
New-Item -ItemType Directory -Force -Path '.kitchen/deepseek-setup' | Out-Null
@'
FROM deepseek-r1:8b
PARAMETER num_ctx 8192
'@ | Set-Content -LiteralPath '.kitchen/deepseek-setup/Modelfile' -Encoding utf8
ollama create kitchen-deepseek-r1:8b -f '.kitchen/deepseek-setup/Modelfile'
ollama list
Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/tags'
```

Setting `contextWindow` in DSH describes capacity; it does not configure Ollama's
allocated context. A Modelfile sets the actual local context for this
OpenAI-compatible route. See [Ollama API compatibility](https://docs.ollama.com/api/openai-compatibility).

Verify a completion through the same protocol DSH will use:

```powershell
$probeBody = @{
  model = 'kitchen-deepseek-r1:8b'
  messages = @(@{
    role = 'user'
    content = 'Return exactly this JSON object: {"summary":"Kitchen model probe OK","findings":[]}'
  })
  stream = $false
  max_tokens = 2048
} | ConvertTo-Json -Depth 6
$probe = Invoke-RestMethod -Method Post `
  -Uri 'http://127.0.0.1:11434/v1/chat/completions' `
  -ContentType 'application/json' -Body $probeBody -TimeoutSec 180
$probe.choices[0].message.content
ollama ps
```

Inspect the response, termination, allocated context, memory use, and CPU/GPU
split. Then perform the DSH probe; a direct Ollama completion does not establish
DSH tool use or Kitchen schema reliability. If the 7B candidate is needed, change
the base model, alias, configuration, and digest together, and repeat qualification.

### Provision and qualify DSH

Query package versions and choose one that implements the inspected headless
contract. Check its runtime requirements and actual help before fixing the pin:

```powershell
node --version
npm view @deepseek-ai/dsh dist-tags --json
# Substitute an exact published candidate, then retain it in Kitchen config.
$dshVersion = '<exact published candidate>'
$dshPackage = "@deepseek-ai/dsh@$dshVersion"
npm view $dshPackage engines --json
npx --yes $dshPackage --version
npx --yes $dshPackage --profile headless --help
npx --yes --offline $dshPackage --version
```

Reject a candidate whose CLI or composed configuration differs from the adapter's
tested contract. Capture `--dump-default-config` and the final `--dump-config`
under an isolated `DSH_HOME`; inspect the restrictive overlay before submitting a
model task. Web UI configuration under the `web` profile is not sufficient for
the headless profile. DSH composes home patches and explicit overlays in defined
order, which is why Kitchen owns a separate home for each request. See the
[launcher reference](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/README.md).

The planned setup script will perform these explicit provisioning steps, write
the model alias/digest and qualified version into `kitchen.config.local.json`,
and save a setup record under `.kitchen/deepseek-setup`. It must preserve unrelated
configuration, report failures, and leave model/package upgrades explicit. Normal
`kitchen doctor` remains diagnostic and does not install packages or pull models.

## Implementation order and verification

1. **Qualify the local stack.** Establish exact DSH/Ollama/model versions, a
   restrictive composed profile, local completion, schema response, and a real
   repository read through DSH. Capture representative prompt sizes and memory.
   Exit condition: evidence demonstrates the target can support the contract;
   otherwise document the specific capability or resource failure before cutover.
2. **Add behavioral tests and configuration support.** Cover `deepseek` roles,
   version/endpoint validation, provider switches, station overrides, Windows
   launchers, and fake DSH transcripts. Preserve current Codex/Claude tests.
3. **Implement the adapter and progress parser.** Reuse `runProcess`, Ajv, and
   evidence paths. Add isolated profiles, strict final extraction, local model
   identity checks, and sequential local discovery.
4. **Add readiness and setup tooling.** Doctor checks only selected providers. For
   DeepSeek, check runtime/package availability, Ollama model/digest, then the
   no-tools schema request in a scratch cwd. Allow up to 180 seconds for its cold
   local probe, bounded by the configured timeout. Identify local compute rather
   than reporting hosted quota consumption. Include the full DSH settings in
   doctor deduplication. Preserve hosted login checks for selected hosted providers.
5. **Run representative Kitchen workflows, then change defaults.** Select
   DeepSeek through the ignored local override first. Validate intent through
   implementation and verification before changing `loadConfig`, initialization,
   and example defaults together. Audit every explicit station override for
   remaining Codex references. Update setup and troubleshooting documentation.

Run the repository's existing checks after implementation:

```powershell
pnpm test
pnpm check:types
pnpm lint
pnpm kitchen doctor
```

The first three commands must remain deterministic and require no external model.
Doctor and separate explicit live calibration exercise the provisioned local
stack; enabled Claude reviews still need their own authentication.

## Acceptance and test plan

| Acceptance criterion | Required evidence |
| --- | --- |
| DSH runs without Codex | Fake executable tests plus a live run with all active roles inspected; no Codex command launched. |
| Valid output contracts | Author, review, and discovery fixtures validate; malformed JSON, prose, wrong schema, missing/mismatched final events, error events, and failed reasons are rejected. A final answer longer than 8 KiB survives intact. |
| Literal Windows invocation | Paths with spaces, multiline prompts, quotes, Unicode, `$()`, and `&` survive argument/stdin transport without shell interpretation. |
| Kitchen owns mutations | Profile exposes only read/glob/grep; attempted writes, shell execution, web calls, and delegation are denied. Fake workflow tests confirm invalid proposals cause no writes and approved test hashes remain protected. |
| Correct failure handling | Chunked NDJSON, absent final newline, timeout, cancellation, output overflow, capture failure, unavailable server, wrong model/digest, cache miss, and bad DSH config retain useful raw evidence and fail readiness/runs. |
| Local resource limits work | Two discovery tasks run sequentially; requests finish or fail within the configured timeout. A representative large context fits without silent truncation or lost accepted requirements. |
| No implicit hosted inference | Restrictive configuration enables only the loopback route. After provisioning, run a fixture with outbound internet blocked and loopback allowed; record successful completion. |
| Workflow gates remain intact | Provider/limit/model-pin changes stale the relevant approvals. Human acceptance, tests-first preservation, runner-owned checks, and publication behavior pass existing workflow regression tests. |
| Local quality is acceptable | Repeat small intent, test-authoring, implementation, and review cases. Every accepted result passes schema and behavioral checks; review fixtures include a known blocking flaw that must be detected. Record schema failures, latency, tokens, and memory for all attempts. |

The ability to chat locally is insufficient for promotion. Tool calling, complete
structured file proposals, context capacity, and actual coding/review behavior
must pass through DSH and Kitchen. If the small model cannot pass, retain the
explicit Codex configuration or evaluate another DeepSeek size/host as a new
candidate; do not silently change the requested model family or weaken validation.

## Rollout and rollback

Keep the first implementation opt-in through `kitchen.config.local.json`, which
is already ignored. Promote DeepSeek for new projects only after the acceptance
matrix passes. Preserve existing explicit project configuration and feature
history; changes to active provider policy require fresh affected approvals.

Rollback by restoring the previously saved author/station role objects with
`provider: "codex"` and their original model/executable settings, then rerun
doctor and affected stations. Keep Claude review configuration as selected. The
migration requires no repository data conversion, deletion of Codex credentials,
or removal of historical provider evidence.
