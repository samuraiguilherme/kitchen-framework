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
readiness checks the exact cached CLI version, local model/digest, and an
isolated no-tools schema request with a maximum of 180 seconds. It requires no
DeepSeek API key or hosted login. Normal requests use the prewarmed npm cache
with `--offline`; no package or model downloads happen during station execution.

## Provider behavior and evidence

DSH receives prompts on stdin, uses a separate home/profile for each invocation,
and can execute only native `read`, `glob`, and `grep`. A required execution
guard also rejects every other tool, including tools introduced by a later CLI
version. Model-only probes allow no tools. Kitchen applies file proposals only
after its existing validation and workflow gates.

The adapter requires successful process completion, a matching completed final
event, and strict JSON matching Kitchen's existing schema. Markdown, prose,
invalid schemas, permission failures, and forbidden-tool attempts fail the run.
There is no hosted fallback or automatic JSON repair. Local discovery runs
sequentially to limit memory.

Inspect the role's `*-events.jsonl`, `*-stderr.log`, `*-process.json`, generated
DSH patch, and isolated DSH home under the normal run evidence directory. Evidence
includes the requested version, local model digest, overlay hash, timings, and
available usage. DSH telemetry is disabled. Digest pins are checked before model
requests and before accepting a station.

To verify the harness integration without an actual model, prewarm the pinned
DSH CLI and run the explicit local protocol-fixture check:

```powershell
node --import tsx scripts/smoke-deepseek.ts
```

This checks the real DSH profile, tool catalogue, repository read, final output,
and metrics. The default test suite uses fake executables and a local HTTP
fixture and does not download DSH or use a paid model. Real DeepSeek model
quality and context capacity still require a representative Kitchen workflow.

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
